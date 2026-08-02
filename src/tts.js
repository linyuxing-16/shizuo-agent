/**
 * DashScope Qwen3-TTS-Flash 语音合成
 *
 * 调用阿里云百炼 multimodal-generation 接口（模型 qwen3-tts-flash），
 * 固定使用音色 Roy（官方「闽南-阿杰」音色）。
 * 流式模式通过 SSE 逐段返回 24kHz 单声道 PCM16 音频数据。
 */

/** DashScope 多模态生成接口地址 */
const TTS_ENDPOINT = 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';

/** TTS 模型名称 */
const TTS_MODEL = 'qwen3-tts-flash';

/** TTS 音色（闽南语男声） */
const TTS_VOICE = 'Roy';

/** 合成语种 */
const TTS_LANGUAGE_TYPE = 'Chinese';

/**
 * 获取 Qwen3 TTS 配置
 */
function getConfig() {
  return {
    apiKey: localStorage.getItem('DASHSCOPE_API_KEY'),
  };
}

/**
 * 将 base64 字符串解码为 ArrayBuffer
 *
 * @param {string} base64 - base64 编码的二进制数据
 * @returns {ArrayBuffer} 解码后的二进制数据
 */
function decodeBase64ToArrayBuffer(base64) {
  const binaryStr = atob(base64);
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) {
    bytes[i] = binaryStr.charCodeAt(i);
  }
  return bytes.buffer;
}

/**
 * 从 SSE 事件块中提取 data 行并解析为 JSON
 *
 * @param {string} eventBlock - 以换行分隔的 SSE 事件块
 * @returns {Object|null} 解析后的 JSON 对象，无 data 行时返回 null
 */
function parseSseEvent(eventBlock) {
  const dataLines = eventBlock
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim());

  if (dataLines.length === 0) {
    return null;
  }

  return JSON.parse(dataLines.join(''));
}

/**
 * 调用 Qwen3-TTS-Flash API 进行语音合成（流式模式）
 *
 * 通过 SSE 流式输出 pcm16 格式（24kHz 单声道）的音频块，
 * 每次 yield 一个 base64 解码后的 ArrayBuffer。
 * 固定使用音色 Roy（闽南语男声）。
 *
 * @param {string} text - 要合成语音的文本
 * @param {Object} [options] - 可选参数
 * @param {string} [options.voice='Roy'] - 音色名称
 * @param {string} [options.languageType='Chinese'] - 合成语种（如 Chinese / English / Auto）
 * @returns {AsyncGenerator<ArrayBuffer, void, void>}
 *   每次 yield 一个 pcm16 音频块的 ArrayBuffer（Int16 编码，24kHz 单声道）
 * @throws {Error} DASHSCOPE_API_KEY 未设置、请求失败或响应异常时抛出
 *
 * @example
 * import { streamTts } from './tts.js';
 *
 * for await (const chunk of streamTts('今天天气真好')) {
 *   const samples = new Int16Array(chunk);
 *   // 通过 AudioContext 播放
 * }
 */
export async function* streamTts(text, options = {}) {
  const { apiKey } = getConfig();
  if (!apiKey) {
    throw new Error('DASHSCOPE_API_KEY 未设置，请先在 localStorage 中配置');
  }

  const { voice = TTS_VOICE, languageType = TTS_LANGUAGE_TYPE } = options;

  const response = await fetch(TTS_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'X-DashScope-SSE': 'enable',
    },
    body: JSON.stringify({
      model: TTS_MODEL,
      input: {
        text,
        voice,
        language_type: languageType,
      },
    }),
  });

  if (!response.ok) {
    let message = `TTS 请求失败：HTTP ${response.status}`;
    try {
      const errorBody = await response.json();
      if (errorBody?.message) {
        message = `TTS 请求失败：${errorBody.message}`;
      }
    } catch {
      /* 响应体不是 JSON 时忽略 */
    }
    throw new Error(message);
  }

  if (!response.body) {
    throw new Error('TTS 响应中未包含音频数据');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const processEvent = (eventBlock) => {
    const event = parseSseEvent(eventBlock);
    if (!event) {
      return false;
    }

    if (event.status_code && event.status_code !== 200) {
      throw new Error(`TTS 请求失败：${event.message || event.status_code}`);
    }
    if (event.code) {
      throw new Error(`TTS 请求失败：${event.message || event.code}`);
    }

    const audioData = event.output?.audio?.data;
    if (audioData) {
      return { chunk: decodeBase64ToArrayBuffer(audioData) };
    }
    if (event.output?.finish_reason === 'stop') {
      return { done: true };
    }
    return false;
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const eventBlocks = buffer.split('\n\n');
    buffer = eventBlocks.pop();

    for (const eventBlock of eventBlocks) {
      const result = processEvent(eventBlock);
      if (result?.chunk) {
        yield result.chunk;
      } else if (result?.done) {
        return;
      }
    }
  }

  // 处理末尾可能没有空行分隔的最后一个事件
  if (buffer.trim()) {
    const result = processEvent(buffer);
    if (result?.chunk) {
      yield result.chunk;
    }
  }
}

/**
 * 调用 Qwen3-TTS-Flash API 进行语音合成（非流式）
 *
 * 内部复用 streamTts，将流式返回的所有 pcm16 音频块
 * 拼接为一个完整的 ArrayBuffer（24kHz 单声道 PCM16）。
 *
 * @param {string} text - 要合成语音的文本
 * @param {Object} [options] - 可选参数，透传给 streamTts
 * @returns {Promise<ArrayBuffer>} 完整 pcm16 音频数据
 * @throws {Error} DASHSCOPE_API_KEY 未设置、请求失败或响应异常时抛出
 *
 * @example
 * import { tts } from './tts.js';
 *
 * const audioBuf = await tts('今天天气真好');
 * // audioBuf 是 Int16 编码的 pcm16 数据
 * const samples = new Int16Array(audioBuf);
 */
export async function tts(text, options = {}) {
  const chunks = [];
  let totalBytes = 0;

  for await (const chunk of streamTts(text, options)) {
    chunks.push(chunk);
    totalBytes += chunk.byteLength;
  }

  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(new Uint8Array(chunk), offset);
    offset += chunk.byteLength;
  }
  return merged.buffer;
}
