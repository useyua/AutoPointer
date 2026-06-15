/**
 * ai-manager.js - AI推論マネージャ（メインスレッド側）
 *
 * Web Worker とのメッセージ通信を管理し、
 * Promise ベースの init() / processCommand() インターフェースを提供する。
 * モデル読み込み失敗時は Mock モードにフォールバックする。
 */

/* ---------- システムプロンプト ---------- */

const SYSTEM_PROMPT = `あなたはユーザーの音声指示を解析するAIです。
ユーザーの言葉から「日記に入力する本文」と「アプリの操作指示」を抽出し、以下のJSON形式で返してください。

【出力フォーマット】
{
  "text": "日記に入力する文章（なければ空文字）",
  "commands": "操作の指示（「戻る」「5月6日」「送信」「下にスクロール」など。なければ空文字）"
}

【重要なルール】
1. 指示言葉（「〜と入力して」「〜と書いて」など）は text に含めず削除してください。
2. 日記の本文として入力すべき内容がない場合は、text は必ず空文字 "" にしてください。
3. "家に戻る" などの日記本文は commands に入れないでください。

【例1】「5月6日を選択し、今日は楽しかったと入力して送信して」
{"text": "今日は楽しかった", "commands": "5月6日、送信"}

【例2】「8月のカレンダーにして」
{"text": "", "commands": "8月"}

【例3】「今日は疲れたから家に戻る」
{"text": "今日は疲れたから家に戻る", "commands": ""}

【例4】「戻って」
{"text": "", "commands": "戻る"}`;

/* ---------- AIManager クラス ---------- */

export class AIManager {
  /** @type {Worker|null} */
  #worker = null;
  #isReady = false;

  /** @type {Function|null} 進捗コールバック */
  #onProgress = null;
  /** @type {Function|null} ステータスコールバック */
  #onStatus = null;

  /** 推論中の Promise resolver */
  #pendingResolve = null;

  get isReady() { return this.#isReady; }

  /**
   * @param {object} callbacks
   * @param {Function} callbacks.onProgress - (progress) => void
   * @param {Function} callbacks.onStatus   - (status: string) => void
   */
  constructor({ onProgress, onStatus } = {}) {
    this.#onProgress = onProgress || (() => {});
    this.#onStatus   = onStatus   || (() => {});
  }

  /* ---------- 初期化 ---------- */

  async init() {
    // WebGPU チェック
    if (!navigator.gpu) {
      console.warn('[AI] WebGPU not available.');
      this.#onStatus('WebGPU非対応のブラウザです。');
      return false;
    }

    return new Promise((resolve) => {
      try {
        this.#worker = new Worker('/js/ai-worker.js', { type: 'module' });
      } catch (err) {
        console.warn('[AI] Worker creation failed:', err);
        this.#onStatus('AI Workerの起動に失敗しました。');
        resolve(false);
        return;
      }

      const timeout = setTimeout(() => {
        console.warn('[AI] Model load timeout.');
        this.#onStatus('モデルの読み込みがタイムアウトしました。');
        this.#worker?.terminate();
        resolve(false);
      }, 5 * 60 * 1000);

      this.#worker.onmessage = (e) => {
        const { type, data } = e.data;

        switch (type) {
          case 'progress':
            this.#onProgress(data);
            break;

          case 'ready':
            clearTimeout(timeout);
            this.#isReady = true;
            this.#onStatus('AIモデルの準備が完了しました');
            this.#setupInferenceHandler();
            resolve(true);
            break;

          case 'error':
            console.warn('[AI] Worker error:', data);
            clearTimeout(timeout);
            this.#onStatus(`AIエラー: ${data}`);
            this.#worker?.terminate();
            resolve(false);
            break;
        }
      };

      this.#worker.onerror = (err) => {
        console.warn('[AI] Worker fatal error:', err);
        clearTimeout(timeout);
        this.#onStatus('AI Workerでエラーが発生しました。');
        resolve(false);
      };

      // モデル初期化開始
      this.#worker.postMessage({ type: 'init' });
    });
  }

  /* ---------- 推論ハンドラ切替 ---------- */

  #setupInferenceHandler() {
    if (!this.#worker) return;
    this.#worker.onmessage = (e) => {
      const { type, data } = e.data;
      if (type === 'result' && this.#pendingResolve) {
        this.#pendingResolve(data);
        this.#pendingResolve = null;
      } else if (type === 'error' && this.#pendingResolve) {
        console.warn('[AI] Inference error:', data);
        this.#pendingResolve(null);
        this.#pendingResolve = null;
      }
    };
  }

  /* ---------- コマンド処理 ---------- */

  async processCommand(commandText, elementsText) {
    // 1. まず高速ルーターでパースを試みる
    const fastActions = this.#buildActionPlan(commandText, "");
    
    // 入力や送信などの複雑な指示が含まれていない場合のみ、LLMをスキップして高速実行
    if (!commandText.includes('入力') && !commandText.includes('書いて') && !commandText.includes('打って') && !commandText.includes('送信')) {
      if (fastActions && fastActions.length > 0) {
        console.log('[AI] Fast Route Matched:', fastActions);
        return fastActions;
      }
    }

    // 2. 複雑な指示の場合はLLMによる意図抽出
    if (!this.#isReady || !this.#worker) {
      return null;
    }

    // LLMには要素リストは渡さず、音声のみを渡して意味抽出させる
    const userMessage = `ユーザー指示：「${commandText}」`;

    const rawResponse = await new Promise((resolve) => {
      this.#pendingResolve = resolve;
      this.#worker.postMessage({
        type: 'infer',
        data: { systemPrompt: SYSTEM_PROMPT, userMessage },
      });

      // 推論タイムアウト（30秒）
      setTimeout(() => {
        if (this.#pendingResolve) {
          this.#pendingResolve(null);
          this.#pendingResolve = null;
        }
      }, 30000);
    });

    const extracted = this.#parseAction(rawResponse);
    if (!extracted) return null;
    
    // 3. LLMの抽出結果を元にルーターがアクション配列を組み立てる
    console.log('[AI] LLM Extracted:', extracted);
    const plan = this.#buildActionPlan(extracted.commands, extracted.text);
    return plan && plan.length > 0 ? plan : null;
  }

  /* ---------- レスポンスパース ---------- */

  #parseAction(raw) {
    if (!raw) return null;

    try {
      let jsonString = raw;
      
      const objMatch = raw.match(/\{[\s\S]*/);
      if (objMatch) {
        jsonString = objMatch[0];
        const lastBrace = jsonString.lastIndexOf('}');
        if (lastBrace !== -1) {
           jsonString = jsonString.substring(0, lastBrace + 1);
        } else {
           if (!jsonString.endsWith('"')) jsonString += '"';
           jsonString += '}';
        }
      } else {
        return null;
      }

      const parsed = JSON.parse(jsonString);
      return {
        text: parsed.text || "",
        commands: parsed.commands || ""
      };
    } catch (e) {
      console.warn('[AI] Failed to parse response:', raw, e);
      return null;
    }
  }

  /* ---------- Action Router (State Machine) ---------- */

  #buildActionPlan(commandsString, textString) {
    const actions = [];
    const cmd = commandsString.toLowerCase();

    // 1. カレンダー操作の判定
    
    // --- Step 1: 年の抽出（独立して先に行う）---
    const thisYear = new Date().getFullYear();
    let targetYear = null;

    // 相対年表現
    if (cmd.includes('再来年'))      targetYear = thisYear + 2;
    else if (cmd.includes('来年'))   targetYear = thisYear + 1;
    else if (cmd.includes('おととし') || cmd.includes('一昨年')) targetYear = thisYear - 2;
    else if (cmd.includes('去年') || cmd.includes('昨年')) targetYear = thisYear - 1;
    else if (cmd.includes('今年'))   targetYear = thisYear;
    else {
      // 4桁数字 + 年 を直接指定
      const yearNumMatch = cmd.match(/(\d{4})年/);
      if (yearNumMatch) targetYear = parseInt(yearNumMatch[1], 10);
    }

    // --- Step 2: 月・日の抽出（年なし正規表現で安定的に） ---
    const dateMatch = cmd.match(/(\d{1,2})月(\d{1,2})日/);       // 〇月〇日
    const dayOnlyMatch = !dateMatch && cmd.match(/(\d{1,2})日/); // 〇日のみ
    const monthOnlyMatch = cmd.match(/(\d{1,2})月/);             // 〇月（日あり・なし両対応）

    // カレンダー操作がある場合、チャット画面にいるならまずホームに戻る
    if (dateMatch || dayOnlyMatch || monthOnlyMatch || targetYear !== null) {
      const isChatScreen = document.getElementById('screen-chat')?.classList.contains('active');
      if (isChatScreen) {
        actions.push({ action: 'click_by_label', label: '戻る' });
        actions.push({ action: 'wait', ms: 500 });
      }
    }

    // 月・年の移動
    let targetMonth = null;
    if (dateMatch) {
      targetMonth = parseInt(dateMatch[1], 10);
    } else if (monthOnlyMatch) {
      targetMonth = parseInt(monthOnlyMatch[1], 10);
    }
    
    // UI表示用に現在の月を取得しておく（null回避）
    let currentUIMonth = null;
    const titleEl = document.querySelector('.calendar-title');
    if (titleEl) {
      const mMatch = titleEl.textContent.match(/(\d+)月/);
      if (mMatch) currentUIMonth = parseInt(mMatch[1], 10);
    }
    if (!currentUIMonth) currentUIMonth = new Date().getMonth() + 1;

    // 年・月の移動アクション（統合または個別）
    if (targetYear !== null) {
      // 年が指定されている場合は、月も含めて1つのアクションにする
      actions.push({ 
        action: 'flip_to_month', 
        year: targetYear, 
        month: targetMonth || currentUIMonth 
      });
    } else if (targetMonth !== null) {
      // 年指定がなく月だけの場合
      actions.push({ 
        action: 'flip_to_month', 
        year: null, 
        month: targetMonth 
      });
    }

    // 日付のクリック
    if (dateMatch) {
      const targetDay = parseInt(dateMatch[2], 10);
      actions.push({ action: 'click_by_label', label: `${targetDay}日` });
      actions.push({ action: 'wait', ms: 500 });
    } else if (dayOnlyMatch) {
      const targetDay = parseInt(dayOnlyMatch[1], 10);
      actions.push({ action: 'click_by_label', label: `${targetDay}日` });
      actions.push({ action: 'wait', ms: 500 });
    }

    // 2. スクロール
    if (cmd.includes('一番上') || cmd.includes('最上')) actions.push({ action: 'scroll_to_top' });
    else if (cmd.includes('一番下') || cmd.includes('最下')) actions.push({ action: 'scroll_to_bottom' });
    else if (cmd.includes('下') && cmd.includes('スクロール')) actions.push({ action: 'scroll_down' });
    else if (cmd.includes('上') && cmd.includes('スクロール')) actions.push({ action: 'scroll_up' });
    // スクロール単体
    else if (cmd.includes('下')) actions.push({ action: 'scroll_down' });
    else if (cmd.includes('上')) actions.push({ action: 'scroll_up' });

    // 3. クリア
    if (cmd.includes('クリア') || cmd.includes('消して')) {
      actions.push({ action: 'clear' });
    }

    // 4. テキスト入力
    if (textString) {
      actions.push({ action: 'type', value: textString });
    }

    // 5. その他のボタン操作
    if (cmd.includes('送信') || cmd.includes('送って')) {
      actions.push({ action: 'click_by_label', label: '送信' });
    } else if (cmd.includes('削除')) {
      actions.push({ action: 'click_by_label', label: '削除' });
    } else if (cmd.includes('戻る') || cmd.includes('戻って')) {
      // 意図的な「戻る」操作の場合（日付指定などで自動的に戻るアクションが追加されていない場合のみ）
      if (!dateMatch && !monthOnlyMatch) {
        actions.push({ action: 'click_by_label', label: '戻る' });
      }
    } else if (cmd.includes('先月') || cmd.includes('前の月')) {
      if (!dateMatch && !monthOnlyMatch) actions.push({ action: 'click_by_label', label: '前の月' });
    } else if (cmd.includes('来月') || cmd.includes('次の月')) {
      if (!dateMatch && !monthOnlyMatch) actions.push({ action: 'click_by_label', label: '次の月' });
    }

    return actions;
  }

  #parseElements(text) {
    const elements = [];
    const lines = text.split('\n');
    for (const line of lines) {
      const match = line.match(/id:\s*"([^"]+)".*type:\s*"([^"]+)".*label:\s*"([^"]*)"/);
      if (match) {
        elements.push({ id: match[1], type: match[2], label: match[3] });
      }
    }
    return elements;
  }

  /* ---------- 破棄 ---------- */

  destroy() {
    this.#worker?.terminate();
    this.#worker = null;
    this.#isReady = false;
  }
}
