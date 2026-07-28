/**
 * Web Audio API PCM16 音频播放器
 *
 * 支持流式追加播放 pcm16 音频块（24kHz 单声道）。
 * 所有函数共享同一个 AudioContext 实例。
 *
 * @example
 * import { initAudioContext, playPcm16, stopPlayback } from './audioPlayer.js';
 *
 * // 用户交互后初始化
 * initAudioContext();
 *
 * // 播放 pcm16 数据块
 * const samples = new Int16Array(pcmBuffer);
 * playPcm16(samples);
 *
 * // 停止播放
 * stopPlayback();
 */

/** @type {AudioContext|null} */
let audioContext = null;

/** @type {GainNode|null} */
let gainNode = null;

/** @type {AudioBufferSourceNode|null} */
let currentSource = null;

/** @type {boolean} */
let isPlaying = false;

/** @type {Float32Array[]} */
let pendingBuffers = [];

/** @type {number} */
const SAMPLE_RATE = 24000;

/**
 * 初始化 AudioContext（需在用户交互事件中调用）
 *
 * 安全地创建或复用 AudioContext（会自动处理 suspended 状态）。
 *
 * @returns {AudioContext} 初始化后的 AudioContext 实例
 * @throws {Error} 浏览器不支持 AudioContext 时抛出
 *
 * @example
 * // 在点击事件中调用
 * button.addEventListener('click', () => {
 *   initAudioContext();
 * });
 */
export function initAudioContext() {
  if (audioContext) {
    if (audioContext.state === 'suspended') {
      audioContext.resume();
    }
    return audioContext;
  }

  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) {
    throw new Error('浏览器不支持 AudioContext');
  }

  audioContext = new AC({ sampleRate: SAMPLE_RATE });
  gainNode = audioContext.createGain();
  gainNode.gain.value = 1.0;
  gainNode.connect(audioContext.destination);

  return audioContext;
}

/**
 * 播放 PCM16 音频块
 *
 * 将 Int16Array 样本转换为 Float32 并追加到播放队列。
 * 如果当前没有播放任务则会立即启动播放。
 * 可以连续调用多次实现流式播放。
 *
 * @param {Int16Array} samples - 24kHz 单声道 PCM16 样本数据
 * @returns {void}
 *
 * @example
 * const samples = new Int16Array(pcmBuffer);
 * playPcm16(samples);
 */
export function playPcm16(samples) {
  if (!audioContext) {
    return;
  }

  // 转换为 Float32 [-1, 1]
  const floatSamples = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    floatSamples[i] = samples[i] / 32768.0;
  }

  pendingBuffers.push(floatSamples);

  if (!isPlaying) {
    playNext();
  }
}

/**
 * 内部函数：播放队列中的下一个音频块
 */
function playNext() {
  if (!audioContext || pendingBuffers.length === 0) {
    isPlaying = false;
    return;
  }

  isPlaying = true;
  const floatSamples = pendingBuffers.shift();

  const audioBuffer = audioContext.createBuffer(1, floatSamples.length, SAMPLE_RATE);
  const channelData = audioBuffer.getChannelData(0);
  channelData.set(floatSamples);

  const source = audioContext.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(gainNode);
  source.onended = () => {
    currentSource = null;
    playNext();
  };

  currentSource = source;
  source.start(0);
}

/**
 * 停止当前播放并清空队列
 *
 * @returns {void}
 *
 * @example
 * stopPlayback();
 */
export function stopPlayback() {
  if (currentSource) {
    try {
      currentSource.stop();
    } catch {
      // 可能已经 stopped，忽略
    }
    currentSource = null;
  }
  pendingBuffers = [];
  isPlaying = false;
}

/**
 * 检查是否正在播放
 *
 * @returns {boolean} 是否正在播放音频
 *
 * @example
 * if (isAudioPlaying()) {
 *   console.log('正在播放中');
 * }
 */
export function isAudioPlaying() {
  return isPlaying;
}

/**
 * 释放 AudioContext 资源
 *
 * @returns {void}
 */
export function closeAudioContext() {
  stopPlayback();
  if (audioContext) {
    audioContext.close();
    audioContext = null;
    gainNode = null;
  }
}
