/**
 * actions.js - アクション実行エンジン
 *
 * LLMから返されたアクション（click, type, clear, focus, scroll_*）を
 * ポインターアニメーション付きで順次実行するキューシステム。
 * 各アクションは isStopped フラグで中断可能。
 */

import { Pointer } from './pointer.js';
import { Scanner } from './scanner.js';

/** ユーティリティ: ms待機 (中断対応) */
function wait(ms, checkCancelled) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const check = () => {
      if (checkCancelled()) { resolve(false); return; }
      if (performance.now() - t0 >= ms) { resolve(true); return; }
      requestAnimationFrame(check);
    };
    requestAnimationFrame(check);
  });
}

export class ActionEngine {
  /** @type {Pointer} */
  #pointer;
  /** @type {Scanner} */
  #scanner;

  #queue = [];
  #processing = false;
  #stopped = false;

  #onActionStart = null;
  #onActionEnd = null;

  /** @param {Pointer} pointer  @param {Scanner} scanner */
  constructor(pointer, scanner, onActionStart = null, onActionEnd = null) {
    this.#pointer = pointer;
    this.#scanner = scanner;
    this.#onActionStart = onActionStart;
    this.#onActionEnd = onActionEnd;
  }

  get isStopped() { return this.#stopped; }

  /* ---------- キュー管理 ---------- */

  /**
   * アクションをキューに追加し、処理を開始する。
   * @param {{action: string, target_id?: string, value?: string} | Array<{action: string, target_id?: string, value?: string}>} actionData
   */
  enqueue(actionData) {
    if (Array.isArray(actionData)) {
      this.#queue.push(...actionData);
    } else {
      this.#queue.push(actionData);
    }
    
    if (!this.#processing) {
      this.#processQueue();
    }
  }

  /**
   * 指定した taskId のタスクをキューから削除する
   * @param {string} taskId 
   */
  dequeue(taskId) {
    this.#queue = this.#queue.filter(a => a.taskId !== taskId);
  }

  /**
   * Stopボタン: キュー全クリア＋進行中アクション中断＋ポインター即時停止
   */
  stop() {
    this.#stopped = true;
    this.#queue = [];
    this.#pointer.forceStop();
    this.#removeAllHighlights();
  }

  /**
   * 停止状態を解除して再開可能にする。
   */
  resume() {
    this.#stopped = false;
  }

  /* ---------- キュー処理ループ ---------- */

  async #processQueue() {
    if (this.#processing) return;
    this.#processing = true;

    while (this.#queue.length > 0 && !this.#stopped) {
      const action = this.#queue.shift();
      await this.#executeAction(action);
    }

    this.#processing = false;
  }

  /* ---------- アクション分岐 ---------- */

  async #executeAction(action) {
    if (this.#onActionStart && action.taskId) this.#onActionStart(action);

    const { action: type, target_id, value, month } = action;

    switch (type) {
      case 'click':       await this.#executeClick(target_id); break;
      case 'click_by_label': await this.#executeClickByLabel(action.label); break;
      case 'flip_to_month': await this.#executeFlipToMonth(month, action.year); break;
      case 'wait':        await this.#executeWait(action.ms); break;
      case 'type':        await this.#executeType(target_id, value || ''); break;
      case 'clear':       await this.#executeClear(target_id); break;
      case 'focus':       await this.#executeFocus(target_id); break;
      case 'scroll_down': await this.#executeScroll('down'); break;
      case 'scroll_up':   await this.#executeScroll('up'); break;
      case 'scroll_to_top':    await this.#executeScrollTo('top'); break;
      case 'scroll_to_bottom': await this.#executeScrollTo('bottom'); break;
      default:
        console.warn(`[ActionEngine] Unknown action: ${type}`);
    }

    if (this.#onActionEnd && action.taskId) this.#onActionEnd(action);
  }

  /* ==========================================================
     個別アクション実装
     ========================================================== */

  /* ---------- Click ---------- */
  async #executeClick(targetId) {
    // 1) ホワイトリスト検証
    if (!this.#scanner.validate(targetId)) {
      this.#onValidationError();
      return;
    }

    const el = this.#scanner.getElement(targetId);
    const pos = this.#scanner.getPosition(targetId);
    if (!el || !pos) return;

    // 2) ポインター移動
    const moved = await this.#pointer.moveTo(pos.viewportX, pos.viewportY);
    if (!moved || this.#stopped) return;

    // 3) 一時停止 (300ms)
    if (!(await wait(300, () => this.#stopped))) return;

    // 4) ハイライト（ポインター色に染める）
    el.classList.add('ap-highlight');
    if (!(await wait(400, () => this.#stopped))) {
      el.classList.remove('ap-highlight');
      return;
    }

    // 5) パルスアニメーション（拡大縮小 × 2回）
    el.classList.add('ap-pulse');
    if (!(await wait(1000, () => this.#stopped))) {
      el.classList.remove('ap-highlight', 'ap-pulse');
      return;
    }

    // 6) 実際のクリックイベント発火
    el.click();

    // 7) ハイライト解除
    await wait(200, () => this.#stopped);
    el.classList.remove('ap-highlight', 'ap-pulse');
  }

  /* ---------- Click By Label ---------- */
  async #executeClickByLabel(label) {
    let targetId = null;

    // 画面遷移直後などを考慮し、最大1.5秒リトライ
    for (let retry = 0; retry < 15; retry++) {
      this.#scanner.scan();
      const lines = this.#scanner.toPromptList().split('\n');

      for (const line of lines) {
        const match = line.match(/id:\s*"([^"]+)".*label:\s*"([^"]*)"/);
        if (match) {
          const [, id, elLabel] = match;
          if (label.match(/^\d+日$/)) {
            if (elLabel === label || elLabel.endsWith(label)) {
              const prefix = elLabel.slice(0, -label.length);
              if (prefix === '' || prefix.endsWith('月') || prefix.endsWith(' ')) {
                targetId = id;
                break;
              }
            }
          } else {
            if (elLabel.includes(label)) {
              targetId = id;
              break;
            }
          }
        }
      }
      if (targetId) break;
      await wait(100, () => this.#stopped);
    }

    if (targetId) {
      return this.#executeClick(targetId);
    } else {
      console.warn(`[ActionEngine] click_by_label failed. Label "${label}" not found on screen after retries.`);
    }
  }

  /* ---------- Wait ---------- */
  async #executeWait(ms) {
    await wait(ms || 500, () => this.#stopped);
  }

  /* ---------- Flip To Month ---------- */
  async #executeFlipToMonth(targetMonth, targetYear) {
    // カレンダータイトルから現在の年月を読み取る
    let currentMonth = null;
    let currentYear = null;
    const titleEl = document.querySelector('.calendar-title');
    if (titleEl) {
      const cmMatch = titleEl.textContent.match(/(\d{4})年\s*(\d+)月/);
      if (cmMatch) {
        currentYear  = parseInt(cmMatch[1], 10);
        currentMonth = parseInt(cmMatch[2], 10);
      } else {
        const mOnly = titleEl.textContent.match(/(\d+)月/);
        if (mOnly) {
          currentMonth = parseInt(mOnly[1], 10);
          currentYear  = new Date().getFullYear();
        }
      }
    }
    
    if (currentMonth === null) return;

    // 月が未指定の場合は現在表示中の月をそのまま使う（年だけ移動）
    let monthNum = (targetMonth !== null && targetMonth !== undefined)
      ? parseInt(targetMonth, 10)
      : currentMonth;
    if (isNaN(monthNum)) monthNum = currentMonth;
    
    let totalSteps;
    let isNext;

    if (targetYear !== null && targetYear !== undefined) {
      // 年が指定されている場合：絶対的な差分で計算
      const currentTotal = currentYear * 12 + currentMonth;
      const targetTotal  = targetYear  * 12 + monthNum;
      totalSteps = targetTotal - currentTotal;
      isNext = totalSteps > 0;
      totalSteps = Math.abs(totalSteps);
    } else {
      // 年が未指定の場合：近い方向でめくる
      if (currentMonth === monthNum) return;
      let diff = monthNum - currentMonth;
      isNext = diff > 0;
      if (diff > 6)  { diff -= 12; isNext = false; }
      else if (diff < -6) { diff += 12; isNext = true; }
      totalSteps = Math.abs(diff);
    }

    if (totalSteps === 0) return;
    
    for (let i = 0; i < totalSteps; i++) {
      if (this.#stopped) break;
      await this.#executeClickByLabel(isNext ? '次の月' : '前の月');
      await this.#executeWait(500);
    }
  }


  /* ---------- Type ---------- */
  async #executeType(targetId, text) {
    let el = null;
    let pos = null;

    // 画面遷移後など、要素が可視化されるまで最大1.5秒待機してリトライする
    for (let retry = 0; retry < 15; retry++) {
      this.#scanner.scan();
      
      if (targetId && this.#scanner.validate(targetId)) {
        el = this.#scanner.getElement(targetId);
        pos = this.#scanner.getPosition(targetId);
      } else {
        const whitelist = this.#scanner.getWhitelist();
        for (const id of whitelist) {
          const elCand = this.#scanner.getElement(id);
          if (elCand && (elCand.tagName.toLowerCase() === 'input' || elCand.tagName.toLowerCase() === 'textarea')) {
            el = elCand;
            pos = this.#scanner.getPosition(id);
            break;
          }
        }
      }

      if (el && pos) break;
      await wait(100, () => this.#stopped);
    }

    if (!el || !pos) {
      console.warn('[ActionEngine] Text input target not found after retries');
      this.#onValidationError();
      return;
    }

    // 1) ポインター移動
    const moved = await this.#pointer.moveTo(pos.viewportX, pos.viewportY);
    if (!moved || this.#stopped) return;

    // 2) フォーカス＋ハイライト
    el.focus();
    el.classList.add('ap-highlight');
    if (!(await wait(300, () => this.#stopped))) {
      el.classList.remove('ap-highlight');
      return;
    }

    // 3) 一文字ずつタイピング
    for (let i = 0; i < text.length; i++) {
      if (this.#stopped) {
        el.classList.remove('ap-highlight');
        return;
      }
      el.value += text[i];
      // input イベントを発火（フレームワーク等が値を検知できるように）
      el.dispatchEvent(new Event('input', { bubbles: true }));
      await wait(100, () => this.#stopped);
    }

    // 4) ハイライト解除（ポインターは留まる）
    await wait(200, () => this.#stopped);
    el.classList.remove('ap-highlight');
  }

  /* ---------- Clear ---------- */
  async #executeClear(targetId) {
    let el = null;
    let pos = null;
    
    for (let retry = 0; retry < 15; retry++) {
      this.#scanner.scan();
      
      if (targetId && this.#scanner.validate(targetId)) {
        el = this.#scanner.getElement(targetId);
        pos = this.#scanner.getPosition(targetId);
      } else {
        const whitelist = this.#scanner.getWhitelist();
        for (const id of whitelist) {
          const elCand = this.#scanner.getElement(id);
          if (elCand && (elCand.tagName.toLowerCase() === 'input' || elCand.tagName.toLowerCase() === 'textarea')) {
            el = elCand;
            pos = this.#scanner.getPosition(id);
            break;
          }
        }
      }

      if (el && pos) break;
      await wait(100, () => this.#stopped);
    }

    if (!el || !pos) {
      console.warn('[ActionEngine] Clear target not found after retries');
      this.#onValidationError();
      return;
    }

    const moved = await this.#pointer.moveTo(pos.viewportX, pos.viewportY);
    if (!moved || this.#stopped) return;

    el.classList.add('ap-highlight');
    await wait(400, () => this.#stopped);

    el.value = '';
    el.dispatchEvent(new Event('input', { bubbles: true }));

    await wait(200, () => this.#stopped);
    el.classList.remove('ap-highlight');
  }

  /* ---------- Focus ---------- */
  async #executeFocus(targetId) {
    if (!this.#scanner.validate(targetId)) {
      this.#onValidationError();
      return;
    }

    const el = this.#scanner.getElement(targetId);
    const pos = this.#scanner.getPosition(targetId);
    if (!el || !pos) return;

    const moved = await this.#pointer.moveTo(pos.viewportX, pos.viewportY);
    if (!moved || this.#stopped) return;

    el.focus();
    el.classList.add('ap-highlight');
    await wait(600, () => this.#stopped);
    el.classList.remove('ap-highlight');
  }

  /* ---------- Scroll (up / down) ---------- */
  async #executeScroll(direction) {
    const vh = window.innerHeight;
    const centerX = window.innerWidth / 2;

    // 1) ポインターを画面端へ移動
    const edgeY = direction === 'down' ? vh - 60 : 60;
    const moved = await this.#pointer.moveTo(centerX, edgeY);
    if (!moved || this.#stopped) return;

    // 2) 引っ張るようなバウンス動作
    const pullOffset = direction === 'down' ? 30 : -30;
    await this.#pointer.moveTo(centerX, edgeY + pullOffset);
    if (this.#stopped) return;
    await this.#pointer.moveTo(centerX, edgeY);
    if (this.#stopped) return;

    // 3) 実際のスクロール (チャット画面なら内部スクロールを優先)
    const chatContainer = document.getElementById('chat-messages');
    
    if (chatContainer && chatContainer.offsetParent !== null) {
      // チャット表示中
      const scrollAmount = direction === 'down' ? chatContainer.clientHeight * 0.6 : -(chatContainer.clientHeight * 0.6);
      chatContainer.scrollBy({ top: scrollAmount, behavior: 'smooth' });
    } else {
      // ホーム画面等
      const scrollAmount = direction === 'down' ? vh * 0.6 : -(vh * 0.6);
      window.scrollBy({ top: scrollAmount, behavior: 'smooth' });
    }

    await wait(600, () => this.#stopped);
  }

  /* ---------- Scroll To (top / bottom) ---------- */
  async #executeScrollTo(target) {
    const centerX = window.innerWidth / 2;
    const edgeY = target === 'bottom' ? window.innerHeight - 60 : 60;

    const moved = await this.#pointer.moveTo(centerX, edgeY);
    if (!moved || this.#stopped) return;

    const chatContainer = document.getElementById('chat-messages');
    
    if (chatContainer && chatContainer.offsetParent !== null) {
      // チャット表示中
      const scrollTarget = target === 'bottom' ? chatContainer.scrollHeight : 0;
      chatContainer.scrollTo({ top: scrollTarget, behavior: 'smooth' });
    } else {
      // ホーム画面等
      const scrollTarget = target === 'bottom' ? document.documentElement.scrollHeight : 0;
      window.scrollTo({ top: scrollTarget, behavior: 'smooth' });
    }

    await wait(800, () => this.#stopped);
  }

  /* ---------- エラー処理 ---------- */

  #onValidationError() {
    // 音声合成で「もう一度お願いします」
    if ('speechSynthesis' in window) {
      const utterance = new SpeechSynthesisUtterance('もう一度お願いします');
      utterance.lang = 'ja-JP';
      utterance.rate = 0.9;
      window.speechSynthesis.speak(utterance);
    }
    console.warn('[ActionEngine] Validation failed - target not in whitelist or not visible');
  }

  /* ---------- ユーティリティ ---------- */

  #removeAllHighlights() {
    document.querySelectorAll('.ap-highlight, .ap-pulse').forEach((el) => {
      el.classList.remove('ap-highlight', 'ap-pulse');
    });
  }
}
