import OpenAI from 'openai';

/**
 * 获取 MIMO TTS 配置
 */
function getConfig() {
  return {
    apiKey: localStorage.getItem('MIMO_API_KEY'),
    dialect: localStorage.getItem('MIMO_TTS_DIALECT') || '闽南语',
    voice: localStorage.getItem('MIMO_TTS_VOICE') || 'Chloe',
  };
}

/**
 * 调用 MIMO TTS API 进行语音合成（非流式）
 *
 * 会自动在文本前拼接方言标签，如 `(闽南语)待合成文本`。
 *
 * @param {string} text - 要合成语音的文本
 * @param {Object} [options] - 可选参数
 * @param {string} [options.format='wav'] - 音频格式（wav / pcm16）
 * @param {string} [options.voice] - 音色名称，默认从 localStorage 读取
 * @param {string} [options.dialect] - 方言，默认从 localStorage 读取
 * @returns {Promise<ArrayBuffer>} 解码后的音频二进制数据
 * @throws {Error} MIMO_API_KEY 未设置时抛出
 *
 * @example
 * import { tts } from './tts.js';
 *
 * const audioBuf = await tts('今天天气真好');
 * // audioBuf 可直接用于 AudioContext.decodeAudioData 或保存为文件
 */
export async function tts(text, options = {}) {
  const { apiKey, dialect: defaultDialect, voice: defaultVoice } = getConfig();
  if (!apiKey) {
    throw new Error('MIMO_API_KEY 未设置，请先在 localStorage 中配置');
  }

  const { format = 'wav', voice = defaultVoice, dialect = defaultDialect } = options;

  const client = new OpenAI({
    apiKey,
    baseURL: 'https://api.xiaomimimo.com/v1',
    dangerouslyAllowBrowser: true,
  });

  const assistantContent = dialect ? `(${dialect})${text}` : text;

  const audioOptions = { format };
  if (voice) {
    audioOptions.voice = voice;
  }

  const completion = await client.chat.completions.create({
    model: 'mimo-v2.5-tts',
    messages: [
      {
        role: 'assistant',
        content: assistantContent,
      },
    ],
    audio: audioOptions,
  });

  const audioData = completion.choices[0]?.message?.audio?.data;
  if (!audioData) {
    throw new Error('TTS 响应中未包含音频数据');
  }

  const binaryStr = atob(audioData);
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) {
    bytes[i] = binaryStr.charCodeAt(i);
  }
  return bytes.buffer;
}

/**
 * 调用 MIMO TTS API 进行语音合成（流式模式）
 *
 * 流式输出 pcm16 格式的音频块，每个 chunk 包含 base64 编码的 PCM 数据。
 * 会自动在文本前拼接方言标签，如 `(闽南语)待合成文本`。
 *
 * @param {string} text - 要合成语音的文本
 * @param {Object} [options] - 可选参数
 * @param {string} [options.format='pcm16'] - 音频格式（流式建议用 pcm16）
 * @param {string} [options.voice] - 音色名称，默认从 localStorage 读取
 * @param {string} [options.dialect] - 方言，默认从 localStorage 读取
 * @returns {AsyncGenerator<ArrayBuffer, void, void>}
 *   每次 yield 一个 pcm16 音频块的 ArrayBuffer（Int16 编码，24kHz 单声道）
 * @throws {Error} MIMO_API_KEY 未设置时抛出
 *
 * @example
 * import { streamTts } from './tts.js';
 *
 * for await (const chunk of streamTts('今天天气真好')) {
 *   // chunk 是 Int16Array 的原始 buffer
 *   const samples = new Int16Array(chunk);
 *   // 通过 AudioContext 播放
 * }
 */
export async function* streamTts(text, options = {}) {
  const { apiKey, dialect: defaultDialect, voice: defaultVoice } = getConfig();
  if (!apiKey) {
    throw new Error('MIMO_API_KEY 未设置，请先在 localStorage 中配置');
  }

  const { format = 'pcm16', voice = defaultVoice, dialect = defaultDialect } = options;

  const client = new OpenAI({
    apiKey,
    baseURL: 'https://api.xiaomimimo.com/v1',
    dangerouslyAllowBrowser: true,
  });

  const assistantContent = dialect ? `(${dialect})${text}` : text;

  const audioOptions = { format };
  if (voice) {
    audioOptions.voice = voice;
  }

  const stream = await client.chat.completions.create({
    model: 'mimo-v2.5-tts',
    messages: [
      {
        role: 'assistant',
        content: assistantContent,
      },
    ],
    audio: audioOptions,
    stream: true,
  });

  for await (const chunk of stream) {
    if (!chunk.choices || chunk.choices.length === 0) {
      continue;
    }
    const delta = chunk.choices[0].delta;
    const audio = delta?.audio;
    if (!audio || !audio.data) {
      continue;
    }

    const binaryStr = atob(audio.data);
    const bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) {
      bytes[i] = binaryStr.charCodeAt(i);
    }
    yield bytes.buffer;
  }
}
