/**
 * scanner.js - DOM要素スキャンモジュール
 *
 * 画面上の操作可能要素を検出し、IDの付与・座標管理・ホワイトリスト検証を行う。
 * LLMに送信するのは ID / タグ名 / ラベルのみ（座標・画像は送信しない）。
 * 座標はフロントエンド側のメモリ上でのみ管理する。
 */

const INTERACTABLE_SELECTORS = [
  'button:not([disabled])',
  'a[href]',
  'input:not([disabled]):not([type="hidden"])',
  'textarea:not([disabled])',
  'select:not([disabled])',
  '[role="button"]',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

// ポインター・デモパネル等のシステム要素はスキャン対象外
const EXCLUDE_IDS = new Set(['virtual-pointer', 'demo-panel', 'mic-stop-btn']);

export class Scanner {
  /** @type {Map<string, {element: HTMLElement, type: string, label: string}>} */
  #elementMap = new Map();
  #idCounter = 0;
  /** @type {MutationObserver|null} */
  #observer = null;

  constructor() {
    this.scan();
    this.#setupObserver();
  }

  /* ---------- 要素スキャン ---------- */

  /**
   * 画面上の操作可能要素をスキャンし、IDを付与してマップに格納する。
   * 既存の ap-id は保持し、新規要素にのみ連番IDを振る。
   */
  scan() {
    this.#elementMap.clear();
    const elements = document.querySelectorAll(INTERACTABLE_SELECTORS);

    elements.forEach((el) => {
      // システム要素を除外
      if (EXCLUDE_IDS.has(el.id)) return;
      // デモパネル内の要素も除外
      if (el.closest('#demo-panel')) return;
      // 非表示要素を除外
      if (!this.#isVisible(el)) return;

      // ap-id が未付与なら振る
      let apId = el.getAttribute('data-ap-id');
      if (!apId) {
        apId = `element-${this.#idCounter++}`;
        el.setAttribute('data-ap-id', apId);
      }

      this.#elementMap.set(apId, {
        element: el,
        type: this.#resolveType(el),
        label: this.#resolveLabel(el),
      });
    });

    return this;
  }

  /* ---------- 要素アクセス ---------- */

  /**
   * apId に対応するDOM要素を返す。
   * ホワイトリスト検証＋可視性チェック込み。
   * @returns {HTMLElement|null}
   */
  getElement(apId) {
    const entry = this.#elementMap.get(apId);
    if (!entry) return null;
    if (!this.#isVisible(entry.element)) return null;
    return entry.element;
  }

  /**
   * apId の要素のビューポート中心座標を返す。
   * スクロール位置を考慮した絶対座標も同時に返す。
   */
  getPosition(apId) {
    const el = this.getElement(apId);
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    return {
      // ビューポート座標（ポインター移動用）
      viewportX: rect.left + rect.width / 2,
      viewportY: rect.top + rect.height / 2,
      // ドキュメント絶対座標（参考用）
      absoluteX: rect.left + window.scrollX + rect.width / 2,
      absoluteY: rect.top + window.scrollY + rect.height / 2,
    };
  }

  /**
   * 現在のホワイトリスト（有効なID一覧）を返す。
   */
  getWhitelist() {
    return new Set(this.#elementMap.keys());
  }

  /**
   * 現在の全要素の情報を配列で返す。
   */
  getElements() {
    return Array.from(this.#elementMap.entries()).map(([id, info]) => ({
      id,
      ...info
    }));
  }

  /**
   * LLMに送信するためのテキスト形式の要素リストを生成する。
   * 座標情報は含めない。
   */
  toPromptList() {
    const lines = [];
    for (const [id, info] of this.#elementMap) {
      lines.push(`- id: "${id}", type: "${info.type}", label: "${info.label}"`);
    }
    return lines.join('\n');
  }

  /* ---------- バリデーション ---------- */

  /**
   * LLMが返した target_id がホワイトリストに存在し、
   * かつ現在可視であるかを検証する。
   */
  validate(targetId) {
    if (!targetId) return false;
    const entry = this.#elementMap.get(targetId);
    if (!entry) return false;
    return this.#isVisible(entry.element);
  }

  /* ---------- MutationObserver ---------- */

  #setupObserver() {
    this.#observer = new MutationObserver(() => {
      // DOM変更があったら次フレームで再スキャン
      requestAnimationFrame(() => this.scan());
    });
    this.#observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['disabled', 'style', 'class', 'hidden'],
    });
  }

  destroy() {
    if (this.#observer) {
      this.#observer.disconnect();
      this.#observer = null;
    }
  }

  /* ---------- ヘルパー ---------- */

  #isVisible(el) {
    if (!el || !el.isConnected) return false;
    const style = window.getComputedStyle(el);
    return style.display !== 'none'
      && style.visibility !== 'hidden'
      && style.opacity !== '0'
      && el.offsetWidth > 0;
  }

  #resolveType(el) {
    const tag = el.tagName.toLowerCase();
    if (tag === 'input')    return el.type || 'text';
    if (tag === 'textarea') return 'textarea';
    if (tag === 'select')   return 'select';
    if (tag === 'a')        return 'link';
    return 'button';
  }

  #resolveLabel(el) {
    // aria-label > textContent > placeholder > title > value
    return (
      el.getAttribute('aria-label') ||
      el.textContent?.trim().slice(0, 60) ||
      el.placeholder ||
      el.title ||
      el.value ||
      ''
    );
  }
}
