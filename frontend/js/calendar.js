/**
 * calendar.js - カレンダーUIコンポーネント
 *
 * 月表示カレンダーグリッドの描画。
 * 日記が存在する日付にドットマーカーを表示する。
 * 音声操作用に各日付セルに data-ap-id を付与する。
 */

import { DiaryAPI } from './api.js';

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

export class Calendar {
  /** @type {HTMLElement} */
  #container;
  #year;
  #month;
  /** @type {Set<number>} 日記がある日 */
  #entryDays = new Set();
  /** @type {Function|null} 日付選択コールバック */
  #onDateSelect = null;

  /**
   * @param {string} containerId - カレンダーを描画するコンテナのID
   * @param {Function} onDateSelect - (dateStr: string) => void
   */
  constructor(containerId, onDateSelect) {
    this.#container = document.getElementById(containerId);
    this.#onDateSelect = onDateSelect;

    const now = new Date();
    this.#year = now.getFullYear();
    this.#month = now.getMonth() + 1; // 1-indexed

    // イベント委譲
    this.#container.addEventListener('click', (e) => {
      const cell = e.target.closest('[data-calendar-day]');
      if (cell) {
        const day = parseInt(cell.getAttribute('data-calendar-day'), 10);
        const dateStr = this.#formatDate(this.#year, this.#month, day);
        if (this.#onDateSelect) this.#onDateSelect(dateStr);
      }

      // 月ナビゲーション
      if (e.target.closest('[data-calendar-prev]')) this.prevMonth();
      if (e.target.closest('[data-calendar-next]')) this.nextMonth();
    });

    this.render();
  }

  /* ---------- ナビゲーション ---------- */

  prevMonth() {
    this.#month--;
    if (this.#month < 1) { this.#month = 12; this.#year--; }
    this.render();
  }

  nextMonth() {
    this.#month++;
    if (this.#month > 12) { this.#month = 1; this.#year++; }
    this.render();
  }

  /* ---------- 描画 ---------- */

  async render() {
    // 日記がある日を取得
    this.#entryDays = await DiaryAPI.getDatesWithEntries(this.#year, this.#month);

    const today = new Date();
    const isCurrentMonth = today.getFullYear() === this.#year && today.getMonth() + 1 === this.#month;
    const todayDate = today.getDate();

    const firstDay = new Date(this.#year, this.#month - 1, 1).getDay(); // 0=Sun
    const daysInMonth = new Date(this.#year, this.#month, 0).getDate();

    let html = '';

    // ヘッダー: 月ナビゲーション
    html += `<div class="calendar-header">`;
    html += `  <button class="calendar-nav-btn" data-calendar-prev aria-label="前の月">◀</button>`;
    html += `  <span class="calendar-title">${this.#year}年 ${this.#month}月</span>`;
    html += `  <button class="calendar-nav-btn" data-calendar-next aria-label="次の月">▶</button>`;
    html += `</div>`;

    // 曜日ヘッダー
    html += `<div class="calendar-grid">`;
    WEEKDAYS.forEach((wd, i) => {
      const cls = i === 0 ? 'sun' : i === 6 ? 'sat' : '';
      html += `<div class="calendar-weekday ${cls}">${wd}</div>`;
    });

    // 空セル（月初の前）
    for (let i = 0; i < firstDay; i++) {
      html += `<div class="calendar-cell empty"></div>`;
    }

    // 日付セル
    for (let d = 1; d <= daysInMonth; d++) {
      const dayOfWeek = (firstDay + d - 1) % 7;
      const isToday = isCurrentMonth && d === todayDate;
      const hasEntry = this.#entryDays.has(d);

      let cls = 'calendar-cell';
      if (isToday) cls += ' today';
      if (hasEntry) cls += ' has-entry';
      if (dayOfWeek === 0) cls += ' sun';
      if (dayOfWeek === 6) cls += ' sat';

      html += `<div class="${cls}" data-calendar-day="${d}" data-ap-label="${d}日" role="button" tabindex="0" aria-label="${this.#month}月${d}日">`;
      html += `  <span class="calendar-day-num">${d}</span>`;
      if (hasEntry) html += `<span class="calendar-dot"></span>`;
      html += `</div>`;
    }

    html += `</div>`;

    this.#container.innerHTML = html;
  }

  /* ---------- ヘルパー ---------- */

  #formatDate(y, m, d) {
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
}
