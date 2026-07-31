import * as ort from 'onnxruntime-web';
import { asr } from './asr.js';

// ── 配置 onnxruntime-web WASM 后端路径 ────────────────────────────────────
// 使用对象形式仅覆盖 .wasm 文件 URL，保留 onnxruntime-web 的内嵌 WASM 模块。
// 字符串形式会禁用内嵌模块并触发动态 import()，导致 Vite 拦截错误。
ort.env.wasm.wasmPaths = {
  wasm: '/shizuo-agent/wasm/ort-wasm-simd-threaded.jsep.wasm',
};

// ── 支持的唤醒词列表（对应 openWakeWord v0.5.1 预训练模型） ──────────────

/** @type {readonly string[]} */
export const WAKE_WORDS = Object.freeze([
  'alexa',
  'hey mycroft',
  'hey jarvis',
  'hey rhasspy',
  'weather',
  'timer',
]);

/** @type {ReadonlySet<string>} */
const WAKE_WORDS_SET = new Set(WAKE_WORDS);

// ── ONNX 模型 URL 映射 ──────────────────────────────────────────────────

const MODEL_BASE = '/shizuo-agent/models/openWakeWord';

/** @type {Record<string, string>} */
const FEATURE_MODEL_URLS = {
  melspectrogram: `${MODEL_BASE}/melspectrogram.onnx`,
  embedding: `${MODEL_BASE}/embedding_model.onnx`,
};

/** @type {Record<string, string>} */
const WAKE_WORD_MODEL_URLS = {
  alexa: `${MODEL_BASE}/alexa_v0.1.onnx`,
  'hey mycroft': `${MODEL_BASE}/hey_mycroft_v0.1.onnx`,
  'hey jarvis': `${MODEL_BASE}/hey_jarvis_v0.1.onnx`,
  'hey rhasspy': `${MODEL_BASE}/hey_rhasspy_v0.1.onnx`,
  weather: `${MODEL_BASE}/weather_v0.1.onnx`,
  timer: `${MODEL_BASE}/timer_v0.1.onnx`,
};

// ── 模型下载与缓存 ──────────────────────────────────────────────────────

const CACHE_NAME = 'openwakeword-models-v1';

/**
 * 通过 Cache API 下载并缓存 ONNX 模型文件
 * @param {string} url - 模型下载 URL
 * @returns {Promise<ArrayBuffer>} 模型文件的 ArrayBuffer
 */
async function fetchModel(url) {
  const cache = await caches.open(CACHE_NAME);
  let response = await cache.match(url);

  if (!response) {
    response = await fetch(url);
    if (!response.ok) {
      throw new Error(`模型下载失败：${url} (${response.status})`);
    }
    await cache.put(url, response.clone());
  }

  return await response.arrayBuffer();
}

/**
 * 下载并创建 ONNX InferenceSession
 * @param {string} url - 模型文件 URL
 * @returns {Promise<ort.InferenceSession>}
 */
async function createSession(url) {
  const buffer = await fetchModel(url);
  return await ort.InferenceSession.create(buffer, {
    executionProviders: ['wasm'],
  });
}

// ── 音频工具函数 ────────────────────────────────────────────────────────

/**
 * 将 Float32Array 音频数据转为 Int16Array（16-bit PCM）
 * @param {Float32Array} float32
 * @returns {Int16Array}
 */
function float32ToInt16(float32) {
  const int16 = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return int16;
}

/**
 * 简单的线性插值降采样
 * @param {Float32Array} samples - 原始采样数据
 * @param {number} fromRate - 原始采样率
 * @param {number} toRate - 目标采样率
 * @returns {Float32Array}
 */
function linearResample(samples, fromRate, toRate) {
  if (fromRate === toRate) return samples;
  const ratio = fromRate / toRate;
  const length = Math.round(samples.length / ratio);
  const result = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const pos = i * ratio;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const a = samples[Math.min(idx, samples.length - 1)];
    const b = samples[Math.min(idx + 1, samples.length - 1)];
    result[i] = a + (b - a) * frac;
  }
  return result;
}

/**
 * 计算音频帧的 RMS（均方根）能量
 * @param {Float32Array} samples
 * @returns {number}
 */
function computeRMS(samples) {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    sum += samples[i] * samples[i];
  }
  return Math.sqrt(sum / samples.length);
}

/**
 * 将 Uint8Array 转为 Base64 字符串
 * @param {Uint8Array} bytes
 * @returns {string}
 */
function uint8ToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// ── 主函数 ──────────────────────────────────────────────────────────────

/**
 * 监听唤醒词，检测到后录音并通过 VAD 判断结束，最后调用 ASR 返回识别结果
 *
 * @param {'alexa'|'hey mycroft'|'hey jarvis'|'hey rhasspy'|'weather'|'timer'} wakeWord - 唤醒词（必须是预训练模型支持的词）
 * @param {number} silenceTimeoutMs - 静音超时时间（毫秒），超过此时间的连续静音将停止录音
 * @returns {Promise<string>} ASR 返回的 JSON 字符串
 *
 * @throws {Error} 当 wakeWord 不受支持、MIMO_API_KEY 未设置或浏览器 API 不可用时抛出
 *
 * @example
 * import { voiceActivate } from './wakeword.js';
 *
 * const result = await voiceActivate('alexa', 3000);
 * console.log(result);
 */
export async function voiceActivate(wakeWord, silenceTimeoutMs) {
  // ── 参数校验 ──
  if (!WAKE_WORDS_SET.has(wakeWord)) {
    throw new Error(
      `不支持的唤醒词 "${wakeWord}"。可选值：${WAKE_WORDS.join(', ')}`,
    );
  }

  if (typeof silenceTimeoutMs !== 'number' || silenceTimeoutMs < 0) {
    throw new Error('silenceTimeoutMs 必须是非负整数（毫秒）');
  }

  // 验证 ASR 配置
  if (!localStorage.getItem('MIMO_API_KEY')) {
    throw new Error('MIMO_API_KEY 未设置，请先在 localStorage 中配置');
  }

  // 检查浏览器 API 支持（兼容 Node 测试环境）
  if (typeof navigator !== 'undefined' && !navigator.mediaDevices?.getUserMedia) {
    throw new Error('当前浏览器不支持 getUserMedia，无法访问麦克风');
  }
  const hasAudioContext = (typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext))
    || typeof AudioContext !== 'undefined';
  if (!hasAudioContext) {
    throw new Error('当前浏览器不支持 AudioContext');
  }
  const hasMediaRecorder = (typeof window !== 'undefined' && window.MediaRecorder)
    || typeof MediaRecorder !== 'undefined';
  if (!hasMediaRecorder) {
    throw new Error('当前浏览器不支持 MediaRecorder');
  }
  if (typeof caches === 'undefined') {
    throw new Error('当前浏览器不支持 Cache API');
  }

  // ── 加载 ONNX 模型 ──
  const [melspecSession, embeddingSession, wwSession] = await Promise.all([
    createSession(FEATURE_MODEL_URLS.melspectrogram),
    createSession(FEATURE_MODEL_URLS.embedding),
    createSession(WAKE_WORD_MODEL_URLS[wakeWord]),
  ]);

  const melspecInputName = melspecSession.inputNames[0];
  const embeddingInputName = embeddingSession.inputNames[0];
  const wwInputName = wwSession.inputNames[0];
  const wwOutputName = wwSession.outputNames[0];

  // 获取唤醒词模型期望的输入特征帧数
  // 注意：onnxruntime-web v1.27+ 的 InferenceSession 公共 API 不暴露 inputs 属性，
  // 使用可选链安全访问，openWakeWord 标准为 16 帧（80ms/帧，共 1.28s 音频）
  const wwFrameCount = wwSession.inputs?.[0]?.dims?.[1] ?? 16;

  // ── 常量 ──
  const FRAME_SIZE = 1280; // 80ms @ 16kHz openWakeword 标准帧
  const VAD_THRESHOLD = 0.01;
  const TARGET_FRAME_COUNT = wwFrameCount;

  // ── 创建一个 Promise 链，最终 resolve ASR 结果 ──
  // 使用外部的 resolve/reject，在流程结束时触发
  let resolveResult;
  let rejectResult;
  const resultPromise = new Promise((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  // ── 状态变量 ──
  /** @type {Float32Array[]} 降采样后的音频帧缓存 */
  const audioBuffer = [];
  let accumulatedSamples = 0;
  /** @type {Float32Array[]} embedding 特征缓存 */
  const featureBuffer = [];

  let wakeWordDetected = false;
  let vadActive = false;
  let silenceStart = null;
  let cleanedUp = false;

  /** @type {MediaRecorder|null} */
  let recorder = null;
  /** @type {Blob[]} */
  const recordedChunks = [];
  /** @type {MediaStream|null} 录音专用流 */
  let recordingStream = null;

  // ── 音频推理管线 ──
  async function processAudioFrame(pcmFrame) {
    if (wakeWordDetected || cleanedUp) return;

    // Int16 → Float32 [-1, 1]
    const floatFrame = new Float32Array(pcmFrame.length);
    for (let i = 0; i < pcmFrame.length; i++) {
      floatFrame[i] = pcmFrame[i] / (pcmFrame[i] < 0 ? 0x8000 : 0x7fff);
    }

    try {
      // melspectrogram → embedding
      const melspecInput = new ort.Tensor('float32', floatFrame, [1, 1, floatFrame.length]);
      const { [melspecSession.outputNames[0]]: melspecOut } = await melspecSession.run({ [melspecInputName]: melspecInput });

      const { [embeddingSession.outputNames[0]]: embOut } = await embeddingSession.run({ [embeddingInputName]: melspecOut });

      // 缓存 embedding 特征
      const embData = /** @type {Float32Array} */ (embOut.data);
      featureBuffer.push(new Float32Array(embData));
      while (featureBuffer.length > TARGET_FRAME_COUNT) {
        featureBuffer.shift();
      }

      // 缓存足够后运行唤醒词模型
      if (featureBuffer.length >= TARGET_FRAME_COUNT) {
        const recent = featureBuffer.slice(-TARGET_FRAME_COUNT);
        const flatLen = recent.reduce((sum, arr) => sum + arr.length, 0);
        const featDim = flatLen / TARGET_FRAME_COUNT;
        const flat = new Float32Array(flatLen);
        let offset = 0;
        for (const arr of recent) {
          flat.set(arr, offset);
          offset += arr.length;
        }

        const wwInput = new ort.Tensor('float32', flat, [1, TARGET_FRAME_COUNT, featDim]);
        const { [wwOutputName]: wwOut } = await wwSession.run({ [wwInputName]: wwInput });
        const score = /** @type {Float32Array} */ (wwOut.data)[0];

        if (score > 0.5) {
          wakeWordDetected = true;
          startRecording().catch(rejectResult);
        }
      }
    } catch (err) {
      rejectResult(err);
    }
  }

  // ── 录音 ──
  async function startRecording() {
    recordingStream = await navigator.mediaDevices.getUserMedia({ audio: true });

    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : 'audio/webm';

    recorder = new MediaRecorder(recordingStream, { mimeType });

    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) recordedChunks.push(event.data);
    };

    recorder.onstop = async () => {
      // 停止录音流
      if (recordingStream) {
        recordingStream.getTracks().forEach((t) => t.stop());
        recordingStream = null;
      }

      if (cleanedUp) return;

      // 合并录音数据 → base64 → ASR
      const blob = new Blob(recordedChunks, { type: mimeType });
      const arrayBuffer = await blob.arrayBuffer();
      const base64 = uint8ToBase64(new Uint8Array(arrayBuffer));
      const format = mimeType.includes('opus') ? 'webm' : 'webm';

      try {
        const asrResult = await asr(base64, { language: 'auto', format, stream: false });
        resolveResult(asrResult);
      } catch (err) {
        rejectResult(err);
      }
    };

    recorder.onerror = () => {
      rejectResult(new Error('录音发生错误'));
    };

    recorder.start(100);
  }

  function stopRecording() {
    if (recorder && recorder.state !== 'inactive') {
      recorder.stop();
    }
  }

  // ── 清理 ──
  function cleanup() {
    if (cleanedUp) return;
    cleanedUp = true;

    try {
      processor.disconnect();
      source.disconnect();
      analyser.disconnect();
    } catch (_) { /* ignore */ }

    if (micStream) {
      micStream.getTracks().forEach((t) => t.stop());
    }
    if (audioContext.state !== 'closed') {
      audioContext.close();
    }
  }

  // ── 麦克风捕获 ──
  const AC = (typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext))
    || globalThis.AudioContext;
  const audioContext = new AC();
  const sampleRate = audioContext.sampleRate;
  const micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const source = audioContext.createMediaStreamSource(micStream);

  // VAD AnalyserNode
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 256;
  source.connect(analyser);

  // ScriptProcessorNode
  const processor = audioContext.createScriptProcessor(4096, 1, 1);

  processor.onaudioprocess = async (event) => {
    if (cleanedUp) return;

    const input = event.inputBuffer.getChannelData(0);
    const downsampled = linearResample(input, sampleRate, 16000);

    if (!wakeWordDetected) {
      // ── 唤醒词检测阶段 ──
      audioBuffer.push(downsampled);
      accumulatedSamples += downsampled.length;

      while (accumulatedSamples >= FRAME_SIZE) {
        // 合并缓冲
        let totalLen = 0;
        for (const buf of audioBuffer) totalLen += buf.length;
        const combined = new Float32Array(totalLen);
        let off = 0;
        for (const buf of audioBuffer) {
          combined.set(buf, off);
          off += buf.length;
        }
        audioBuffer.length = 0;
        accumulatedSamples = 0;

        const numFrames = Math.floor(combined.length / FRAME_SIZE);
        for (let i = 0; i < numFrames; i++) {
          const frame = combined.subarray(i * FRAME_SIZE, (i + 1) * FRAME_SIZE);
          await processAudioFrame(float32ToInt16(frame));
          if (wakeWordDetected) break;
        }
      }
    } else {
      // ── VAD 阶段 ──
      if (!vadActive) {
        vadActive = true;
        silenceStart = null;
      }

      const timeData = new Float32Array(analyser.frequencyBinCount);
      analyser.getFloatTimeDomainData(timeData);
      const rms = computeRMS(timeData);

      if (rms < VAD_THRESHOLD) {
        if (silenceStart === null) {
          silenceStart = Date.now();
        } else if (Date.now() - silenceStart >= silenceTimeoutMs) {
          stopRecording();
          cleanup();
        }
      } else {
        silenceStart = null;
      }
    }
  };

  processor.connect(audioContext.destination);

  // ── 返回结果（整个流程完成后自动 resolve） ──
  return resultPromise;
}
