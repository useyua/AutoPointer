/**
 * voice.js - 音声認識・音声合成モジュール
 *
 * Web Speech API を用いた音声入力（SpeechRecognition）と
 * 音声フィードバック（SpeechSynthesis）を管理する。
 *
 * 自身の音声合成出力を誤認識しないよう、
 * 発話中は認識を一時停止する仕組みを持つ。
 */

export class VoiceController {
  /** @type {SpeechRecognition|null} */
  #recognition = null;
  #isListening = false;
  #isSpeaking = false;
  #supported = false;

  /** @type {Function|null} 認識結果コールバック (text: string) => void */
  #onResult = null;
  /** @type {Function|null} 中間結果コールバック (text: string) => void */
  #onInterim = null;
  /** @type {Function|null} ステータス変更コールバック */
  #onStatusChange = null;

  /**
   * @param {object} callbacks
   * @param {Function} callbacks.onResult       - (text: string) => void
   * @param {Function} callbacks.onInterim      - (text: string) => void
   * @param {Function} callbacks.onStatusChange - (status: 'idle'|'listening'|'processing'|'speaking'|'error') => void
   */
  constructor({ onResult, onInterim, onStatusChange } = {}) {
    this.#onResult       = onResult       || (() => {});
    this.#onInterim      = onInterim      || (() => {});
    this.#onStatusChange = onStatusChange || (() => {});

    // SpeechRecognition の存在チェック
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      console.warn('[Voice] SpeechRecognition is not supported in this browser.');
      this.#supported = false;
      return;
    }

    this.#supported = true;
    this.#recognition = new SpeechRecognition();

    // 設定
    this.#recognition.lang = 'ja-JP';
    this.#recognition.continuous = false;       // 一発言ごとに結果を返す
    this.#recognition.interimResults = true;    // 途中結果も取得
    this.#recognition.maxAlternatives = 1;

    // --- イベントハンドラ ---

    this.#recognition.onresult = (event) => {
      let interimTranscript = '';
      let finalTranscript = '';

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          finalTranscript += transcript;
        } else {
          interimTranscript += transcript;
        }
      }

      if (interimTranscript.trim() !== '') {
        this.#onInterim(interimTranscript.trim());
      }

      if (finalTranscript.trim() !== '') {
        console.log('[Voice] Recognized:', finalTranscript.trim());
        this.#onStatusChange('processing');
        this.#onResult(finalTranscript.trim());
      }
    };

    this.#recognition.onend = () => {
      // 自動再開: リスニング中であれば、発話中でなければ再開する
      if (this.#isListening && !this.#isSpeaking) {
        this.#restartRecognition();
      }
    };

    this.#recognition.onerror = (event) => {
      console.warn('[Voice] Recognition error:', event.error);

      switch (event.error) {
        case 'no-speech':
          // 何も聞こえなかった → 静かに再開
          if (this.#isListening) {
            this.#restartRecognition();
          }
          break;
        case 'audio-capture':
          this.#onStatusChange('error');
          this.speak('マイクが見つかりません');
          this.stop();
          break;
        case 'not-allowed':
          this.#onStatusChange('error');
          this.speak('マイクの使用が許可されていません');
          this.stop();
          break;
        case 'aborted':
          // 明示的な停止 → 何もしない
          break;
        default:
          if (this.#isListening) {
            this.#restartRecognition();
          }
      }
    };

    this.#recognition.onspeechstart = () => {
      console.log('[Voice] Speech detected');
    };
  }

  /* ---------- プロパティ ---------- */

  get isSupported()  { return this.#supported; }
  get isListening()  { return this.#isListening; }

  /* ---------- 開始・停止 ---------- */

  /**
   * 音声認識を開始する。
   * @returns {boolean} 開始できたかどうか
   */
  start() {
    if (!this.#supported) {
      this.speak('このブラウザは音声認識に対応していません');
      return false;
    }

    if (this.#isListening) return true;

    try {
      this.#isListening = true;
      this.#recognition.start();
      this.#onStatusChange('listening');
      console.log('[Voice] Listening started');
      return true;
    } catch (err) {
      console.warn('[Voice] Failed to start:', err);
      this.#isListening = false;
      this.#onStatusChange('error');
      return false;
    }
  }

  /**
   * 音声認識を停止する。
   */
  stop() {
    this.#isListening = false;
    try {
      this.#recognition?.abort();
    } catch { /* ignore */ }
    this.#onStatusChange('idle');
    console.log('[Voice] Listening stopped');
  }

  /* ---------- 音声合成 ---------- */

  /**
   * テキストを音声で読み上げる。
   * 読み上げ中は音声認識を一時停止し、完了後に再開する。
   * @param {string} text
   * @returns {Promise<void>}
   */
  speak(text) {
    return new Promise((resolve) => {
      if (!('speechSynthesis' in window)) {
        resolve();
        return;
      }

      // 認識を一時停止（自分の声を拾わないように）
      const wasListening = this.#isListening;
      if (wasListening) {
        this.#isSpeaking = true;
        try { this.#recognition?.abort(); } catch { /* ignore */ }
      }

      this.#onStatusChange('speaking');

      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = 'ja-JP';
      utterance.rate = 0.9;
      utterance.pitch = 1.0;

      utterance.onend = () => {
        this.#isSpeaking = false;
        // 発話完了後、リスニング状態であれば再開
        if (wasListening && this.#isListening) {
          this.#restartRecognition();
          this.#onStatusChange('listening');
        } else {
          this.#onStatusChange(this.#isListening ? 'listening' : 'idle');
        }
        resolve();
      };

      utterance.onerror = () => {
        this.#isSpeaking = false;
        if (wasListening && this.#isListening) {
          this.#restartRecognition();
        }
        this.#onStatusChange(this.#isListening ? 'listening' : 'idle');
        resolve();
      };

      // 既にキューがある場合はキャンセル
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(utterance);
    });
  }

  /* ---------- 内部ヘルパー ---------- */

  /**
   * 認識を短い遅延を置いて再開する。
   * 連続呼び出しのデバウンス処理込み。
   */
  #restartRecognition() {
    if (!this.#isListening || !this.#supported) return;

    // 短い遅延を入れて前回のセッション終了を待つ
    setTimeout(() => {
      if (!this.#isListening || this.#isSpeaking) return;
      try {
        this.#recognition.start();
        this.#onStatusChange('listening');
      } catch (err) {
        // 既に開始済みの場合のエラーを無視
        if (!err.message?.includes('already started')) {
          console.warn('[Voice] Restart failed:', err);
        }
      }
    }, 300);
  }
}
