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
 * @param {string} [options.language='zh'] - 音频语言
 * @param {string} [options.format='wav'] - 音频格式（如 wav、mp3 等）
 * @returns {Promise<string>} 包含说话人信息的识别结果 JSON 字符串
 *
 * @example
 * import { asr } from './asr.js';
 *
 * const result = await asr(audioBase64, { language: 'zh' });
 * console.log(result);
 * // {"id":"...","choices":[{"message":{"role":"assistant","content":"[说话人1]: 你好\n[说话人2]: 请问..."}}],...}
 */
export async function asr(base64, options = {}) {
  const { apiKey } = getConfig();
  if (!apiKey) {
    throw new Error('MIMO_API_KEY 未设置，请先在 localStorage 中配置');
  }

  const { language = 'zh', format = 'wav' } = options;

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
  });

  return JSON.stringify(completion, null, 2);
}
