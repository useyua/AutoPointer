"""
main.py - FastAPI エントリポイント

日記CRUD用のREST APIを提供し、フロントエンドの静的ファイルも配信する。
"""

from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel
import os

from database import init_db, get_entries, add_entry, delete_entry, get_dates_with_entries

# --- アプリケーション初期化 ---
app = FastAPI(title="AutoPointer Diary API")

# DB初期化（テーブル作成）
init_db()

# フロントエンド静的ファイルのパス
FRONTEND_DIR = os.path.join(os.path.dirname(__file__), "..", "frontend")


# --- リクエスト/レスポンスモデル ---
class EntryCreate(BaseModel):
    text: str


class EntryResponse(BaseModel):
    id: int
    date: str
    text: str
    timestamp: str


# ========== API エンドポイント ==========

@app.get("/api/entries/{date}", response_model=list[EntryResponse])
def api_get_entries(date: str):
    """指定日の日記エントリ一覧を取得する。"""
    return get_entries(date)


@app.post("/api/entries/{date}", response_model=EntryResponse, status_code=201)
def api_add_entry(date: str, body: EntryCreate):
    """指定日に日記エントリを追加する。"""
    if not body.text.strip():
        raise HTTPException(status_code=400, detail="テキストが空です")
    return add_entry(date, body.text.strip())


@app.delete("/api/entries/{date}/{entry_id}", status_code=204)
def api_delete_entry(date: str, entry_id: int):
    """日記エントリを削除する。"""
    if not delete_entry(entry_id):
        raise HTTPException(status_code=404, detail="エントリが見つかりません")


@app.get("/api/dates/{year}/{month}")
def api_get_dates(year: int, month: int):
    """指定年月で日記が存在する日付（日）のリストを返す。"""
    return {"days": get_dates_with_entries(year, month)}


# ========== フロントエンド配信 ==========

# 静的ファイル（CSS, JS等）
app.mount("/css", StaticFiles(directory=os.path.join(FRONTEND_DIR, "css")), name="css")
app.mount("/js", StaticFiles(directory=os.path.join(FRONTEND_DIR, "js")), name="js")


@app.get("/{full_path:path}")
def serve_frontend(full_path: str):
    """SPA用: すべてのパスで index.html を返す。"""
    index_path = os.path.join(FRONTEND_DIR, "index.html")
    if os.path.exists(index_path):
        return FileResponse(index_path)
    raise HTTPException(status_code=404, detail="Frontend not found")
