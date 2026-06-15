/**
 * ai-worker.js - Web Worker: Transformers.js による Gemma4 E2B 推論
 *
 * メインスレッドをブロックせずにモデルのダウンロード・推論を実行する。
 * CDN から @huggingface/transformers v4 をロードし、WebGPU で高速推論を行う。
 *
 * メッセージプロトコル:
 *   IN:  { type: 'init' }                           → モデルのダウンロードと初期化
 *   IN:  { type: 'infer', data: { prompt, ... } }   → 推論実行
 *   OUT: { type: 'progress', data: {...} }           → ダウンロード進捗
 *   OUT: { type: 'ready' }                           → モデル準備完了
 *   OUT: { type: 'result', data: string }            → 推論結果（JSON文字列）
 *   OUT: { type: 'error', data: string }             → エラー
 */

/* ---------- Transformers.js のインポート ---------- */

let pipeline;

async function loadTransformersLibrary() {
  try {
    const module = await import(
      'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.0.1'
    );
    pipeline = module.pipeline;
    return true;
  } catch (err) {
    self.postMessage({
      type: 'error',
      data: `Transformers.js の読み込みに失敗しました: ${err.message}`,
    });
    return false;
  }
}

/* ---------- モデル管理 ---------- */

const MODEL_ID = 'onnx-community/gemma-4-E2B-it-ONNX';
const MODEL_OPTIONS = {
  device: 'webgpu',
  dtype: 'q4f16',
};

let generator = null;

async function initModel() {
  // ライブラリ読み込み
  const loaded = await loadTransformersLibrary();
  if (!loaded) return;

  try {
    generator = await pipeline('text-generation', MODEL_ID, {
      ...MODEL_OPTIONS,
      progress_callback: (progress) => {
        self.postMessage({ type: 'progress', data: progress });
      },
    });
    self.postMessage({ type: 'ready' });
  } catch (err) {
    self.postMessage({
      type: 'error',
      data: `モデルの初期化に失敗しました: ${err.message}`,
    });
  }
}

/* ---------- 推論 ---------- */

async function runInference({ systemPrompt, userMessage }) {
  if (!generator) {
    self.postMessage({ type: 'error', data: 'モデルが初期化されていません' });
    return;
  }

  try {
    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ];

    const output = await generator(messages, {
      max_new_tokens: 512,
      temperature: 0.1,       // 確定的な出力のために低温度
      do_sample: false,
    });

    // 最後のアシスタントメッセージを取得
    const response = output[0].generated_text.at(-1).content;
    self.postMessage({ type: 'result', data: response });
  } catch (err) {
    self.postMessage({
      type: 'error',
      data: `推論エラー: ${err.message}`,
    });
  }
}

/* ---------- メッセージハンドラ ---------- */

self.onmessage = async (e) => {
  const { type, data } = e.data;

  switch (type) {
    case 'init':
      await initModel();
      break;
    case 'infer':
      await runInference(data);
      break;
    default:
      console.warn('[AI Worker] Unknown message type:', type);
  }
};
