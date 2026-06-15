/**
 * app.js - メインアプリケーション（Phase 5: 音声統合）
 *
 * 画面遷移、カレンダー、チャットUI、AI推論統合、
 * 音声認識・合成、マイク/Stopトグル管理。
 */

import { Pointer }         from './pointer.js';
import { Scanner }         from './scanner.js';
import { ActionEngine }    from './actions.js';
import { Calendar }        from './calendar.js';
import { DiaryAPI }        from './api.js';
import { AIManager }       from './ai-manager.js';
import { VoiceController } from './voice.js';

/* ========== タスクキューUI ========== */
const taskQueueEl = document.getElementById('task-queue');

function generateId() {
  return Math.random().toString(36).substring(2, 9);
}

function pushTaskUI(id, text, isReading = false) {
  if (!taskQueueEl) return;
  const el = document.createElement('div');
  el.id = `task-${id}`;
  el.className = 'task-item';
  if (isReading) el.classList.add('reading-task');
  el.textContent = text;

  // クリックで取り消し
  el.addEventListener('click', () => {
    // 実行中のタスクを消した場合は、エンジン自体を止める（現在の動作を中断するため）
    if (el.classList.contains('running')) {
      engine.stop();
      // engine.stop() はキューを空にするので、UI側も同調させる
      const items = taskQueueEl.querySelectorAll('.task-item');
      items.forEach(item => {
        const itemId = item.id.replace('task-', '');
        removeTaskUI(itemId);
      });
    } else {
      // 待機中のタスクを消す
      engine.dequeue(id);
      removeTaskUI(id);
    }
  });

  taskQueueEl.appendChild(el);
}

function updateTaskUI(id, state) {
  const el = document.getElementById(`task-${id}`);
  if (!el) return;
  if (state === 'running') el.classList.add('running');
}

function removeTaskUI(id) {
  const el = document.getElementById(`task-${id}`);
  if (!el) return;
  el.classList.add('completed');
  setTimeout(() => {
    if (el.parentNode) el.parentNode.removeChild(el);
  }, 400);
}

function actionToText(action) {
  switch (action.action) {
    case 'click': return 'ボタン/要素を押す';
    case 'click_by_label': return `「${action.label}」を選択`;
    case 'flip_to_month': 
      if (action.year && action.month) return `${action.year}年${action.month}月のカレンダーに遷移`;
      if (action.year) return `${action.year}年のカレンダーに遷移`;
      return `${action.month}月のカレンダーに遷移`;
    case 'type': return `「${action.value}」をテキスト入力`;
    case 'clear': return '入力欄をクリア';
    case 'scroll_down': return '下にスクロール';
    case 'scroll_up': return '上にスクロール';
    case 'scroll_to_top': return '一番上にスクロール';
    case 'scroll_to_bottom': return '一番下にスクロール';
    case 'wait': return '待機中...';
    default: return '操作を実行';
  }
}

/* ========== 初期化 ========== */

const pointer = new Pointer();
const scanner = new Scanner();
const engine  = new ActionEngine(pointer, scanner, 
  (action) => updateTaskUI(action.taskId, 'running'),
  (action) => removeTaskUI(action.taskId)
);

/* ========== AI 初期化 ========== */

const aiManager = new AIManager({
  onProgress: (progress) => {
    updateLoadingProgress(progress);
  },
  onStatus: (msg) => {
    updateStatus(msg);
    console.log('[AI Status]', msg);
  },
});

const loadingOverlay = document.getElementById('loading-overlay');
const loadingText    = document.getElementById('loading-text');
const loadingDetail  = document.getElementById('loading-detail');
const progressFill   = document.getElementById('progress-bar-fill');

/** AI モデルの読み込み開始 */
async function initAI() {
  const success = await aiManager.init();
  hideLoadingOverlay();

  if (success) {
    updateStatus('AI準備完了');
  } else {
    updateStatus('音声操作 非対応環境です');
    const micBtn = document.getElementById('mic-stop-btn');
    micBtn.disabled = true;
    micBtn.style.opacity = '0.5';
    micBtn.style.cursor = 'not-allowed';
  }
}

/** ローディング進捗の更新 */
function updateLoadingProgress(progress) {
  if (!progress) return;

  if (progress.status === 'download' || progress.status === 'progress') {
    const pct = progress.progress ?? 0;
    progressFill.style.width = `${Math.round(pct)}%`;

    const fileName = progress.file ? progress.file.split('/').pop() : '';
    loadingDetail.textContent = fileName
      ? `${fileName} — ${Math.round(pct)}%`
      : `ダウンロード中... ${Math.round(pct)}%`;
  } else if (progress.status === 'ready') {
    progressFill.style.width = '100%';
    loadingText.textContent = '初期化しています...';
  }
}

/** ローディングオーバーレイを非表示 */
function hideLoadingOverlay() {
  loadingOverlay.style.opacity = '0';
  setTimeout(() => {
    loadingOverlay.style.display = 'none';
  }, 400);
}


// AI初期化を開始
initAI();

/* ========== 状態管理 ========== */

const state = {
  currentScreen: 'home',
  selectedDate: null,
};

/* ========== 音声コントローラ ========== */

const voice = new VoiceController({
  onResult: (text) => {
    // 音声認識結果 → AIコマンド処理
    handleAICommand(text);
  },
  onInterim: (text) => {
    updateStatus(`認識中: ${text}...`);
  },
  onStatusChange: (status) => {
    updateMicButtonState(status);
  },
});

/* ========== AI コマンド処理 ========== */

/**
 * 音声テキスト（またはデモコマンド）を AI に送り、
 * 返されたアクションをポインターで実行する。
 */
async function handleAICommand(commandText) {
  if (!aiManager.isReady) {
    voice.speak('AIの準備がまだ完了していません');
    return;
  }

  // 1) 思考中・読み取り中表示
  pointer.startThinking();
  await voice.speak('少々お待ちください');
  
  const readingTaskId = generateId();
  pushTaskUI(readingTaskId, `「${commandText}」を読み取り中`, true);

  // 2) DOMスキャン最新化
  scanner.scan();
  const elementsText = scanner.toPromptList();

  // 3) AI推論
  const actions = await aiManager.processCommand(commandText, elementsText);
  pointer.stopThinking();
  removeTaskUI(readingTaskId);

  // 4) 結果処理
  if (!actions || actions.length === 0) {
    voice.speak('もう一度お願いします');
    const errId = generateId();
    pushTaskUI(errId, '⚠ 認識に失敗しました');
    setTimeout(() => removeTaskUI(errId), 3000);
    return;
  }

  console.log('[AI Action]', actions);
  
  // 各アクションにIDを振り、キューUIに積む
  actions.forEach(a => {
    a.taskId = generateId();
    pushTaskUI(a.taskId, actionToText(a));
  });

  // 5) アクション実行
  engine.resume();
  engine.enqueue(actions);
}

/* ========== 画面遷移 ========== */

function navigateTo(screen, data = {}) {
  document.getElementById(`screen-${state.currentScreen}`).classList.remove('active');
  state.currentScreen = screen;
  if (screen === 'chat' && data.date) state.selectedDate = data.date;

  const nextScreen = document.getElementById(`screen-${screen}`);
  nextScreen.classList.add('active');

  if (screen === 'home') {
    calendar.render();
    loadRecentEntries();
  } else if (screen === 'chat') {
    initChatScreen(state.selectedDate);
  }

  requestAnimationFrame(() => {
    scanner.scan();
    window.scrollTo({ top: 0 });
  });
}

/* ========== カレンダー ========== */

const calendar = new Calendar('calendar-container', (dateStr) => {
  navigateTo('chat', { date: dateStr });
});

/* ========== ホーム画面: 最近の日記 ========== */

async function loadRecentEntries() {
  const container = document.getElementById('recent-entries');
  const now = new Date();
  const entries = [];

  for (let i = 0; i < 30; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const dateStr = formatDateStr(d);
    const dayEntries = await DiaryAPI.getEntries(dateStr);
    if (dayEntries.length > 0) {
      entries.push({ date: dateStr, preview: dayEntries[dayEntries.length - 1].text });
    }
    if (entries.length >= 5) break;
  }

  if (entries.length === 0) {
    container.innerHTML = '<p class="empty-message">まだ日記がありません。日付を選んで書き始めましょう。</p>';
    return;
  }

  container.innerHTML = entries.map(e => `
    <div class="recent-entry" data-recent-date="${e.date}" role="button" tabindex="0">
      <span class="recent-date">${formatDisplayDate(e.date)}</span>
      <span class="recent-preview">${escapeHtml(e.preview)}</span>
    </div>
  `).join('');

  container.querySelectorAll('[data-recent-date]').forEach(el => {
    el.addEventListener('click', () => {
      navigateTo('chat', { date: el.getAttribute('data-recent-date') });
    });
  });
}

/* ========== チャット画面 ========== */

async function initChatScreen(dateStr) {
  document.getElementById('chat-date-title').textContent = formatDisplayDate(dateStr);
  await renderChatMessages(dateStr);
}

async function renderChatMessages(dateStr) {
  const container = document.getElementById('chat-messages');
  const entries = await DiaryAPI.getEntries(dateStr);

  if (entries.length === 0) {
    container.innerHTML = '';
    const p = document.createElement('p');
    p.className = 'empty-message';
    p.id = 'chat-empty';
    p.innerHTML = 'この日の日記はまだありません。<br>下の入力欄から書き始めましょう。';
    container.appendChild(p);
    return;
  }

  container.innerHTML = entries.map(e => `
    <div class="chat-bubble-wrapper">
      <div class="chat-bubble user-bubble">
        <p class="bubble-text">${escapeHtml(e.text)}</p>
        <div class="bubble-footer">
          <button class="bubble-delete-btn" data-delete-id="${e.id}" aria-label="削除">🗑 削除</button>
          <span class="bubble-time">${formatTime(e.timestamp)}</span>
        </div>
      </div>
    </div>
  `).join('');

  // 削除ボタンのイベント設定
  container.querySelectorAll('[data-delete-id]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      // 親要素への伝播を停止（不要なイベント発火を防ぐ）
      e.stopPropagation();
      
      const entryId = parseInt(btn.getAttribute('data-delete-id'), 10);
      
      // confirmダイアログは環境によってブロックされることがあるため、直接削除を実行する
      await DiaryAPI.deleteEntry(dateStr, entryId);
      await renderChatMessages(dateStr);
      requestAnimationFrame(() => scanner.scan());
    });
  });

  requestAnimationFrame(() => {
    container.scrollTop = container.scrollHeight;
  });
}

async function sendMessage() {
  const input = document.getElementById('chat-input');
  const text = input.value.trim();
  if (!text || !state.selectedDate) return;

  await DiaryAPI.addEntry(state.selectedDate, text);
  input.value = '';
  await renderChatMessages(state.selectedDate);
  requestAnimationFrame(() => scanner.scan());
}

document.getElementById('btn-send').addEventListener('click', sendMessage);
document.getElementById('chat-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.isComposing) {
    e.preventDefault();
    sendMessage();
  }
});
document.getElementById('btn-back').addEventListener('click', () => navigateTo('home'));

/* ========== Mic / Stop ボタン ========== */

const micStopBtn = document.getElementById('mic-stop-btn');
let isActive = false;

micStopBtn.addEventListener('click', () => {
  if (isActive) {
    // Stop: 音声認識停止 + アクション停止
    voice.stop();
    engine.stop();
    micStopBtn.textContent = '🎤';
    micStopBtn.classList.remove('active', 'listening');
    micStopBtn.setAttribute('aria-label', 'マイクを起動');
    isActive = false;
    voice.speak('操作を停止しました');
  } else {
    // Start: 音声認識開始
    engine.resume();
    const started = voice.start();
    if (started) {
      micStopBtn.textContent = '⏹';
      micStopBtn.classList.add('active', 'listening');
      micStopBtn.setAttribute('aria-label', '操作を停止');
      isActive = true;
      voice.speak('音声操作を開始します。指示をどうぞ。');
    } else {
      voice.speak('音声認識を開始できませんでした');
    }
  }
});

/** マイクボタンの外見を音声ステータスに応じて更新 */
function updateMicButtonState(status) {
  switch (status) {
    case 'listening':
      micStopBtn.classList.add('listening');
      micStopBtn.classList.remove('processing');
      updateStatus('🎤 音声を聞いています...');
      break;
    case 'processing':
      micStopBtn.classList.remove('listening');
      micStopBtn.classList.add('processing');
      updateStatus('🧠 処理中...');
      break;
    case 'speaking':
      micStopBtn.classList.remove('listening');
      updateStatus('🔊 発話中...');
      break;
    case 'idle':
      micStopBtn.classList.remove('listening', 'processing');
      break;
    case 'error':
      micStopBtn.classList.remove('listening', 'processing');
      micStopBtn.textContent = '🎤';
      micStopBtn.classList.remove('active');
      isActive = false;
      updateStatus('⚠ マイクエラー');
      break;
  }
}


/* ========== ユーティリティ ========== */

function formatDateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function formatDisplayDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const weekday = ['日', '月', '火', '水', '木', '金', '土'];
  return `${y}年${m}月${d}日（${weekday[new Date(y, m - 1, d).getDay()]}）`;
}

function formatTime(isoStr) {
  const d = new Date(isoStr);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function updateStatus(msg) {
  // ステータスバーは廃止されたため、一時的なキューアイテムとして表示
  if (!msg.startsWith('認識中')) {
    const id = generateId();
    pushTaskUI(id, msg);
    setTimeout(() => removeTaskUI(id), 3000);
  }
}

// voice と handleAICommand をグローバルに公開（デバッグ・テスト用）
window.handleAICommand = handleAICommand;
window.voice = voice;

/* ========== 起動 ========== */

loadRecentEntries();
console.log('[AutoPointer] Phase 5 initialized');
