"""
database.py - SQLite データベース操作モジュール

日記エントリの永続化を担う。
テーブル: diary_entries (id, date, text, timestamp)
"""

import sqlite3
import os
from datetime import datetime

DB_DIR = os.path.join(os.path.dirname(__file__), "data")
DB_PATH = os.path.join(DB_DIR, "diary.db")


def _get_conn() -> sqlite3.Connection:
    """SQLite接続を取得する。データディレクトリが無ければ作成する。"""
    os.makedirs(DB_DIR, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def init_db():
    """テーブルが存在しなければ作成する。"""
    conn = _get_conn()
    conn.execute("""
        CREATE TABLE IF NOT EXISTS diary_entries (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            date       TEXT    NOT NULL,
            text       TEXT    NOT NULL,
            timestamp  TEXT    NOT NULL
        )
    """)
    conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_entries_date ON diary_entries(date)
    """)
    conn.commit()
    conn.close()


# ========== CRUD ==========

def get_entries(date: str) -> list[dict]:
    """指定日の日記エントリ一覧を取得する。"""
    conn = _get_conn()
    rows = conn.execute(
        "SELECT id, date, text, timestamp FROM diary_entries WHERE date = ? ORDER BY id ASC",
        (date,),
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def add_entry(date: str, text: str) -> dict:
    """指定日に日記エントリを追加する。"""
    now = datetime.now().isoformat()
    conn = _get_conn()
    cur = conn.execute(
        "INSERT INTO diary_entries (date, text, timestamp) VALUES (?, ?, ?)",
        (date, text, now),
    )
    conn.commit()
    entry = {
        "id": cur.lastrowid,
        "date": date,
        "text": text,
        "timestamp": now,
    }
    conn.close()
    return entry


def delete_entry(entry_id: int) -> bool:
    """日記エントリを削除する。"""
    conn = _get_conn()
    cur = conn.execute("DELETE FROM diary_entries WHERE id = ?", (entry_id,))
    conn.commit()
    deleted = cur.rowcount > 0
    conn.close()
    return deleted


def get_dates_with_entries(year: int, month: int) -> list[int]:
    """指定年月で日記が存在する日付（日）のリストを返す。"""
    prefix = f"{year}-{month:02d}-"
    conn = _get_conn()
    rows = conn.execute(
        """
        SELECT DISTINCT CAST(SUBSTR(date, 9, 2) AS INTEGER) AS day
        FROM diary_entries
        WHERE date LIKE ?
        ORDER BY day
        """,
        (prefix + "%",),
    ).fetchall()
    conn.close()
    return [r["day"] for r in rows]
