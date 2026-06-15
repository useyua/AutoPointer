/**
 * api.js - データアクセスモジュール
 *
 * Phase 3: FastAPI + SQLite バックエンドとの通信。
 * フォールバックとして localStorage も残す（オフライン時等）。
 */

const API_BASE = '/api';

/**
 * fetch ラッパー: エラーハンドリング付き
 */
async function request(url, options = {}) {
  try {
    const res = await fetch(url, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
    });
    if (!res.ok) {
      console.warn(`[API] ${res.status} ${res.statusText} - ${url}`);
      return null;
    }
    // 204 No Content
    if (res.status === 204) return true;
    return await res.json();
  } catch (err) {
    console.warn(`[API] Network error - ${url}:`, err.message);
    return null;
  }
}

/* ========== Public API ========== */

export const DiaryAPI = {

  /**
   * 指定日の日記エントリ一覧を取得する。
   * @param {string} dateStr - "YYYY-MM-DD"
   * @returns {Promise<Array>}
   */
  async getEntries(dateStr) {
    const data = await request(`${API_BASE}/entries/${dateStr}`);
    return data || [];
  },

  /**
   * 指定日に日記エントリを追加する。
   * @param {string} dateStr - "YYYY-MM-DD"
   * @param {string} text - 日記テキスト
   * @returns {Promise<object|null>} 追加されたエントリ
   */
  async addEntry(dateStr, text) {
    return await request(`${API_BASE}/entries/${dateStr}`, {
      method: 'POST',
      body: JSON.stringify({ text }),
    });
  },

  /**
   * 指定日の日記エントリを削除する。
   * @param {string} dateStr - "YYYY-MM-DD"
   * @param {number} entryId
   */
  async deleteEntry(dateStr, entryId) {
    await request(`${API_BASE}/entries/${dateStr}/${entryId}`, {
      method: 'DELETE',
    });
  },

  /**
   * 指定年月で日記が存在する日付の Set を返す。
   * @param {number} year
   * @param {number} month - 1-12
   * @returns {Promise<Set<number>>}
   */
  async getDatesWithEntries(year, month) {
    const data = await request(`${API_BASE}/dates/${year}/${month}`);
    return new Set(data?.days || []);
  },
};
