import OpenAI from 'openai';

/**
 * 获取 MIMO ASR 配置
 */
function getConfig() {
  return {
    apiKey: localStorage.getItem('MIMO_API_KEY'),
  };
}

/**
 * 调用 MIMO ASR API 进行语音识别（支持说话人区分）
 *
 * @param {string} base64 - 裸 base64 编码的音频数据（不含 data URI 前缀）
 * @param {Object} [options] - 可选参数
 * @param {string} [options.language='auto'] - 音频语言（如 'zh', 'en', 'auto'）
 * @param {string} [options.format='wav'] - 音频格式（如 wav、mp3 等）
 * @param {boolean} [options.stream=true] - 是否使用流式响应
 * @returns {Promise<AsyncIterable<Object>|string>}
 *   当 stream=true 时返回异步可迭代对象，每次 yield 一个 chunk；
 *   当 stream=false 时返回完整的 JSON 字符串。
 *
 * @example
 * import { asr } from './asr.js';
 *
 * // 流式模式（默认）
 * const stream = await asr(audioBase64, { language: 'auto' });
 * for await (const chunk of stream) {
 *   console.log(JSON.stringify(chunk, null, 2));
 * }
 *
 * // 非流式模式
 * const result = await asr(audioBase64, { stream: false });
 * console.log(result);
 */
export async function asr(base64, options = {}) {
  const { apiKey } = getConfig();
  if (!apiKey) {
    throw new Error('MIMO_API_KEY 未设置，请先在 localStorage 中配置');
  }

  const { language = 'auto', format = 'wav', stream = true } = options;

  const client = new OpenAI({
    apiKey,
    baseURL: 'https://api.xiaomimimo.com/v1',
    dangerouslyAllowBrowser: true,
  });

  const completion = await client.chat.completions.create({
    model: 'mimo-v2.5-asr',
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'input_audio',
            input_audio: {
              data: `data:audio/${format};base64,${base64}`,
            },
          },
        ],
      },
    ],
    extra_body: {
      asr_options: {
        language,
      },
    },
    stream,
  });

  if (stream) {
    return completion;
  }

  return JSON.stringify(completion, null, 2);
}
