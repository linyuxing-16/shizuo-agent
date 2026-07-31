import { asr } from './asr.js';

// ── 常量 ──────────────────────────────────────────────────────────────────

/** @type {number} 目标采样率（16kHz，WAV 编码与检测窗口统一使用） */
const SAMPLE_RATE = 16000;

/** @type {number} VAD 语音/静音能量阈值（RMS），供 UI 诊断提示复用 */
export const VAD_THRESHOLD = 0.01;

/** @type {number} 唤醒词检测间隔（毫秒） */
const DETECT_INTERVAL_MS = 1000;

/** @type {number} 每次送 ASR 的音频窗口长度（毫秒） */
const DETECT_WINDOW_MS = 2000;

/** @type {number} 滚动缓冲上限（毫秒），防止静音期间内存无限增长 */
const MAX_BUFFER_MS = 6000;

/** @type {number} ScriptProcessorNode 缓冲大小 */
const PROCESSOR_BUFFER_SIZE = 4096;

// ── 唤醒词建议列表（供 UI 的 datalist 使用） ──────────────────────────────

/** @type {readonly string[]} */
export const WAKE_WORD_SUGGESTIONS = Object.freeze([
  'alexa',
  'hey jarvis',
  'hey mycroft',
  'hey rhasspy',
  'weather',
  'timer',
  '小助手',
  '嘿 时作',
  '你好 助手',
]);

// ── 音频工具函数 ──────────────────────────────────────────────────────────

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
 * 计算音频片段的 RMS（均方根）能量
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

/**
 * 在 DataView 的指定偏移写入 ASCII 字符串
 * @param {DataView} view
 * @param {number} offset
 * @param {string} str
 */
function writeAscii(view, offset, str) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

/**
 * 将 Int16Array PCM 数据编码为 WAV 文件（16kHz、16bit、单声道），返回裸 base64
 * @param {Int16Array} samples - 16kHz 16bit 单声道 PCM 数据
 * @returns {string} WAV 文件的 base64 编码（不含 data URI 前缀）
 *
 * @example
 * import { int16ToWavBase64 } from './wakeword.js';
 *
 * const base64 = int16ToWavBase64(new Int16Array([0, 1000, -1000]));
 */
export function int16ToWavBase64(samples) {
  const bytesPerSample = 2;
  const dataSize = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  // RIFF 头
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, 'WAVE');

  // fmt 块
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // fmt 块大小
  view.setUint16(20, 1, true); // PCM 格式
  view.setUint16(22, 1, true); // 单声道
  view.setUint32(24, SAMPLE_RATE, true); // 采样率
  view.setUint32(28, SAMPLE_RATE * bytesPerSample, true); // 字节率
  view.setUint16(32, bytesPerSample, true); // 块对齐
  view.setUint16(34, 16, true); // 位深

  // data 块
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  // PCM 数据
  for (let i = 0; i < samples.length; i++) {
    view.setInt16(44 + i * bytesPerSample, samples[i], true);
  }

  return uint8ToBase64(new Uint8Array(buffer));
}

// ── 文本匹配工具 ──────────────────────────────────────────────────────────

/**
 * 归一化 ASR 文本：去说话人前缀、小写、去标点符号与空白
 * @param {string} text - 原始 ASR 文本或唤醒词
 * @returns {string}
 *
 * @example
 * import { normalizeTranscript } from './wakeword.js';
 *
 * normalizeTranscript('[说话人A]: Hey, Jarvis! 今天天气怎么样？');
 * // → 'heyjarvis今天天气怎么样'
 */
export function normalizeTranscript(text) {
  return text
    .replace(/\[[^\]]*\]\s*:/g, '') // 去掉 "[说话人A]:" 说话人前缀
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '') // 去空白、标点、符号
    .trim();
}

/**
 * 判断归一化后的 ASR 文本是否包含唤醒词
 * @param {string} transcript - 已归一化的 ASR 文本
 * @param {string} wakeWord - 唤醒词（内部会自动归一化）
 * @returns {boolean}
 *
 * @example
 * import { containsWakeWord } from './wakeword.js';
 *
 * containsWakeWord('heyjarvis今天天气', 'hey jarvis'); // → true
 */
export function containsWakeWord(transcript, wakeWord) {
  const normalized = normalizeTranscript(wakeWord);
  if (!normalized) return false;
  return transcript.includes(normalized);
}

// ── 主函数 ──────────────────────────────────────────────────────────────

/**
 * 通过 ASR 周期检测唤醒词：持续录音，检测到唤醒词后继续录音，
 * 静音超时后返回包含唤醒词的完整识别结果
 *
 * @param {string} wakeWord - 唤醒词（任意短语，如 'hey jarvis'、'你好 助手'）
 * @param {number} silenceTimeoutMs - 静音超时时间（毫秒），超过此时间的连续静音将结束录音
 * @param {Object} [callbacks] - 可选回调，用于 UI 诊断展示
 * @param {(rms: number) => void} [callbacks.onAudioLevel] - 每帧音频能量（RMS 0~1）回调，
 *   可用于显示麦克风音量；监听期间约每 90ms 触发一次
 * @returns {Promise<string>} ASR 返回的 JSON 字符串（含唤醒词）
 *
 * @throws {Error} 当 wakeWord 为空/无效、MIMO_API_KEY 未设置或浏览器 API 不可用时抛出
 *
 * @example
 * import { voiceActivate } from './wakeword.js';
 *
 * const result = await voiceActivate('你好 助手', 3000, {
 *   onAudioLevel: (rms) => console.log('能量:', rms),
 * });
 * console.log(result);
 */
export async function voiceActivate(wakeWord, silenceTimeoutMs, callbacks = {}) {
  // ── 参数校验 ──
  if (typeof wakeWord !== 'string' || !wakeWord.trim()) {
    throw new Error('唤醒词不能为空');
  }
  const normalizedWakeWord = normalizeTranscript(wakeWord);
  if (!normalizedWakeWord) {
    throw new Error('唤醒词无效：不能仅包含标点或空白');
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

  // ── 采样相关常量 ──
  const msPerSample = 1000 / SAMPLE_RATE;
  const detectIntervalSamples = Math.round(DETECT_INTERVAL_MS / msPerSample); // 1s
  const detectWindowSamples = Math.round(DETECT_WINDOW_MS / msPerSample); // 2s
  const maxBufferSamples = Math.round(MAX_BUFFER_MS / msPerSample); // 6s
  const silenceTimeoutSamples = Math.round((silenceTimeoutMs / 1000) * SAMPLE_RATE);

  // ── 创建一个 Promise 链，最终 resolve ASR 结果 ──
  let resolveResult;
  let rejectResult;
  const resultPromise = new Promise((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  // ── 状态变量 ──
  /** @type {Int16Array[]} 16kHz Int16 滚动缓冲（分块存储） */
  const bufferChunks = [];
  /** @type {number} 已推入缓冲的总样本数（单调递增，全局索引） */
  let totalSamples = 0;
  /** @type {number} 缓冲中第一个样本的全局索引（被裁剪头部后前移） */
  let bufferStart = 0;
  /** @type {number} 自上次检测以来累积的样本数 */
  let samplesSinceLastDetect = 0;
  /** @type {number} 唤醒后连续静音样本数 */
  let silentSamples = 0;

  let wakeDetected = false;
  let wakeSliceStart = 0;
  let detectionInFlight = false;
  let cleanedUp = false;

  /** @type {MediaStream|null} */
  let micStream = null;
  /** @type {AudioContext|null} */
  let audioContext = null;
  /** @type {ScriptProcessorNode|null} */
  let processor = null;
  /** @type {MediaStreamAudioSourceNode|null} */
  let source = null;

  // ── 缓冲工具 ──
  function pushSamples(samples) {
    bufferChunks.push(samples);
    totalSamples += samples.length;
    samplesSinceLastDetect += samples.length;

    // 裁剪超出上限的头部数据
    let overflow = totalSamples - bufferStart - maxBufferSamples;
    while (overflow > 0 && bufferChunks.length > 0) {
      const head = bufferChunks[0];
      if (head.length <= overflow) {
        bufferChunks.shift();
        bufferStart += head.length;
        overflow -= head.length;
      } else {
        bufferChunks[0] = head.subarray(overflow);
        bufferStart += overflow;
        overflow = 0;
      }
    }
  }

  /**
   * 从滚动缓冲中取出 [start, end) 全局样本区间
   * @param {number} start - 全局起始样本索引
   * @param {number} end - 全局结束样本索引
   * @returns {Int16Array}
   */
  function sliceSamples(start, end) {
    const parts = [];
    let cursor = bufferStart;
    for (const chunk of bufferChunks) {
      const chunkEnd = cursor + chunk.length;
      if (chunkEnd <= start) {
        cursor = chunkEnd;
        continue;
      }
      if (cursor >= end) break;
      const from = Math.max(0, start - cursor);
      const to = Math.min(chunk.length, end - cursor);
      if (to > from) parts.push(chunk.subarray(from, to));
      cursor = chunkEnd;
    }
    const total = parts.reduce((sum, p) => sum + p.length, 0);
    const out = new Int16Array(total);
    let offset = 0;
    for (const part of parts) {
      out.set(part, offset);
      offset += part.length;
    }
    return out;
  }

  /**
   * 取缓冲末尾最近 count 个样本
   * @param {number} count
   * @returns {Int16Array}
   */
  function recentSamples(count) {
    const start = Math.max(bufferStart, totalSamples - count);
    return sliceSamples(start, totalSamples);
  }

  // ── ASR 文本提取 ──
  /**
   * 从 ASR 返回的 JSON 字符串中提取纯文本
   * @param {string} asrJson
   * @returns {string}
   */
  function extractTranscript(asrJson) {
    try {
      const parsed = typeof asrJson === 'string' ? JSON.parse(asrJson) : asrJson;
      return parsed?.choices?.[0]?.message?.content || '';
    } catch {
      return typeof asrJson === 'string' ? asrJson : '';
    }
  }

  // ── 唤醒词检测（送最近窗口给 ASR 并匹配） ──
  async function checkWakeWord() {
    const windowSamples = recentSamples(detectWindowSamples);
    if (windowSamples.length === 0) return;

    const base64 = int16ToWavBase64(windowSamples);
    const result = await asr(base64, { language: 'auto', format: 'wav', stream: false });

    const transcript = normalizeTranscript(extractTranscript(result));
    if (containsWakeWord(transcript, normalizedWakeWord)) {
      // 记录切片起点（当前窗口起点），确保最终结果包含唤醒词
      wakeSliceStart = Math.max(bufferStart, totalSamples - detectWindowSamples);
      wakeDetected = true;
      silentSamples = 0;
    }
  }

  // ── 指令采集结束（静音超时）：切片 → ASR → 返回结果 ──
  async function finalizeCommand() {
    if (cleanedUp) return;
    const commandSamples = sliceSamples(wakeSliceStart, totalSamples);
    cleanup();

    try {
      if (commandSamples.length === 0) {
        resolveResult(JSON.stringify({ choices: [{ message: { content: '' } }] }));
        return;
      }
      const base64 = int16ToWavBase64(commandSamples);
      const result = await asr(base64, { language: 'auto', format: 'wav', stream: false });
      resolveResult(result);
    } catch (err) {
      rejectResult(err);
    }
  }

  // ── 清理 ──
  function cleanup() {
    if (cleanedUp) return;
    cleanedUp = true;

    try {
      processor?.disconnect();
      source?.disconnect();
    } catch (_) { /* ignore */ }

    if (micStream) {
      micStream.getTracks().forEach((t) => t.stop());
    }
    if (audioContext && audioContext.state !== 'closed') {
      audioContext.close();
    }
  }

  // ── 麦克风捕获 ──
  const AC = (typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext))
    || globalThis.AudioContext;
  audioContext = new AC();
  const sampleRate = audioContext.sampleRate;
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    // 清理已创建的 AudioContext，避免资源泄漏
    try {
      if (audioContext && audioContext.state !== 'closed') {
        audioContext.close();
      }
    } catch (_) { /* ignore */ }

    const errName = err?.name || '';
    const errMessage = err?.message || '';
    if (errName === 'NotFoundError' || /requested device not found|no audio input/i.test(errMessage)) {
      throw new Error('未找到可用的麦克风设备，请检查系统麦克风与浏览器权限设置');
    }
    if (errName === 'NotAllowedError' || /permission denied|permission dismissed/i.test(errMessage)) {
      throw new Error('麦克风权限被拒绝，请在浏览器地址栏允许麦克风访问');
    }
    throw err;
  }
  source = audioContext.createMediaStreamSource(micStream);

  processor = audioContext.createScriptProcessor(PROCESSOR_BUFFER_SIZE, 1, 1);
  source.connect(processor);

  processor.onaudioprocess = async (event) => {
    if (cleanedUp) return;

    const input = event.inputBuffer.getChannelData(0);
    const downsampled = linearResample(input, sampleRate, SAMPLE_RATE);
    const frameRms = computeRMS(downsampled);

    // 回调每帧能量，供 UI 显示麦克风音量/诊断（不阻塞检测逻辑）
    if (typeof callbacks.onAudioLevel === 'function') {
      callbacks.onAudioLevel(frameRms);
    }

    // 写入滚动缓冲（Int16）
    pushSamples(float32ToInt16(downsampled));

    if (!wakeDetected) {
      // ── 唤醒词检测阶段 ──
      if (
        !detectionInFlight &&
        frameRms >= VAD_THRESHOLD &&
        samplesSinceLastDetect >= detectIntervalSamples
      ) {
        samplesSinceLastDetect = 0;
        detectionInFlight = true;
        checkWakeWord()
          .catch((err) => {
            // 单次检测失败不中断监听，仅记录日志
            console.warn('唤醒词检测 ASR 失败:', err);
          })
          .finally(() => {
            detectionInFlight = false;
          });
      }
    } else {
      // ── 指令采集阶段（VAD 静音超时结束） ──
      if (frameRms < VAD_THRESHOLD) {
        silentSamples += downsampled.length;
        if (silentSamples >= silenceTimeoutSamples) {
          finalizeCommand().catch(rejectResult);
        }
      } else {
        silentSamples = 0;
      }
    }
  };

  processor.connect(audioContext.destination);

  // ── 返回结果（整个流程完成后自动 resolve） ──
  return resultPromise;
}
