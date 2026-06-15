/**
 * pointer.js - 仮想ポインター制御モジュール
 *
 * 大きな円形ポインターの描画・移動・状態管理を行う。
 * - アクション実行中: moveTo() でプログラム制御
 * - アイドル時: ユーザーのマウスカーソルに滑らかに追従
 * - requestAnimationFrame によるアニメーション制御
 * - Stopボタンによる即時停止に対応
 */

export class Pointer {
  /** @type {HTMLElement} */
  #el;
  #x;
  #y;
  #rafId = null;
  #cancelled = false;

  /** カーソル追従 */
  #followEnabled = true;
  #isAnimating = false;
  #followRafId = null;
  #mouseX;
  #mouseY;

  constructor() {
    this.#el = document.getElementById('virtual-pointer');
    if (!this.#el) {
      throw new Error('Pointer element (#virtual-pointer) not found');
    }
    // 画面中央で初期化
    this.#x = window.innerWidth / 2;
    this.#y = window.innerHeight / 2;
    this.#mouseX = this.#x;
    this.#mouseY = this.#y;
    this.#render();

    // マウス追従のセットアップ
    this.#setupCursorFollow();
  }

  get x() { return this.#x; }
  get y() { return this.#y; }
  get element() { return this.#el; }

  /* ---------- 表示制御 ---------- */

  show() { this.#el.classList.remove('hidden'); }
  hide() { this.#el.classList.add('hidden'); }

  /* ---------- 思考中アニメーション ---------- */

  startThinking() { this.#el.classList.add('thinking'); }
  stopThinking()  { this.#el.classList.remove('thinking'); }

  /* ---------- カーソル追従 ---------- */

  /**
   * マウスカーソルの動きにポインターが滑らかに追従するよう設定する。
   * アクション実行中（#isAnimating === true）は追従を一時停止する。
   */
  #setupCursorFollow() {
    document.addEventListener('mousemove', (e) => {
      this.#mouseX = e.clientX;
      this.#mouseY = e.clientY;

      // アクション実行中はカーソル追従しない
      if (this.#isAnimating) return;

      // 追従アニメーションが未起動なら開始
      if (!this.#followRafId) {
        this.#startFollowing();
      }
    });
  }

  #startFollowing() {
    const LERP_FACTOR = 0.15; // 追従の滑らかさ（0-1: 小さいほど滑らか）

    const tick = () => {
      if (this.#isAnimating) {
        this.#followRafId = null;
        return;
      }

      // 線形補間でカーソルに近づく
      this.#x += (this.#mouseX - this.#x) * LERP_FACTOR;
      this.#y += (this.#mouseY - this.#y) * LERP_FACTOR;
      this.#render();

      // 十分近づいたら停止
      const dist = Math.abs(this.#mouseX - this.#x) + Math.abs(this.#mouseY - this.#y);
      if (dist > 0.5) {
        this.#followRafId = requestAnimationFrame(tick);
      } else {
        this.#x = this.#mouseX;
        this.#y = this.#mouseY;
        this.#render();
        this.#followRafId = null;
      }
    };

    this.#followRafId = requestAnimationFrame(tick);
  }

  /* ---------- プログラム移動 ---------- */

  /**
   * ポインターを (targetX, targetY) へ滑らかに移動する。
   * 座標はビューポート基準（fixed要素と同じ基準系）。
   * 移動中はカーソル追従を停止する。
   * @param {number} targetX - ビューポート上のX座標
   * @param {number} targetY - ビューポート上のY座標
   * @returns {Promise<boolean>} true=完了, false=中断された
   */
  async moveTo(targetX, targetY) {
    this.#cancelled = false;
    this.#isAnimating = true;
    this.#el.classList.add('moving');

    // カーソル追従を中断
    if (this.#followRafId) {
      cancelAnimationFrame(this.#followRafId);
      this.#followRafId = null;
    }

    const startX = this.#x;
    const startY = this.#y;
    const dx = targetX - startX;
    const dy = targetY - startY;
    const distance = Math.sqrt(dx * dx + dy * dy);

    // 距離が極小なら即移動
    if (distance < 2) {
      this.#x = targetX;
      this.#y = targetY;
      this.#render();
      this.#isAnimating = false;
      this.#el.classList.remove('moving');
      return true;
    }

    // 距離に基づく移動時間（目で追いやすい速度）
    const speed = 380; // px/sec
    const duration = Math.max(600, Math.min(2200, (distance / speed) * 1000));

    return new Promise((resolve) => {
      const t0 = performance.now();

      const step = (now) => {
        if (this.#cancelled) {
          this.#isAnimating = false;
          resolve(false);
          return;
        }

        const elapsed = now - t0;
        const progress = Math.min(elapsed / duration, 1);
        const eased = Pointer.#easeInOutCubic(progress);

        this.#x = startX + dx * eased;
        this.#y = startY + dy * eased;
        this.#render();

        if (progress < 1) {
          this.#rafId = requestAnimationFrame(step);
        } else {
          this.#rafId = null;
          this.#el.classList.remove('moving');
          this.#isAnimating = false;
          resolve(true);
        }
      };

      this.#rafId = requestAnimationFrame(step);
    });
  }

  /* ---------- 強制停止 ---------- */

  /**
   * 進行中のアニメーションを即時停止する。
   * 現在の描画位置でポインターを固定する。
   */
  forceStop() {
    this.#cancelled = true;
    if (this.#rafId !== null) {
      cancelAnimationFrame(this.#rafId);
      this.#rafId = null;
    }
    this.#isAnimating = false;
    this.#el.classList.remove('moving');
    this.stopThinking();
  }

  /* ---------- 内部ヘルパー ---------- */

  #render() {
    this.#el.style.left = `${this.#x}px`;
    this.#el.style.top  = `${this.#y}px`;
  }

  /**
   * イーズイン・イーズアウト（視線が追従しやすい加減速）
   */
  static #easeInOutCubic(t) {
    return t < 0.5
      ? 4 * t * t * t
      : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }
}
