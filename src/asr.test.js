import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock localStorage ──────────────────────────────────────────────────────
const localStorageMock = (() => {
  const store = {};
  return {
    getItem: vi.fn((key) => store[key] ?? null),
    setItem: vi.fn((key, value) => { store[key] = value; }),
    removeItem: vi.fn((key) => { delete store[key]; }),
    clear: vi.fn(() => { Object.keys(store).forEach((k) => delete store[k]); }),
  };
})();
vi.stubGlobal('localStorage', localStorageMock);

// ── Mock openai ─────────────────────────────────────────────────────────────
const mockCreate = vi.fn();

vi.mock('openai', () => {
  const MockOpenAI = vi.fn(function () {
    return {
      chat: {
        completions: {
          create: mockCreate,
        },
      },
    };
  });
  return { default: MockOpenAI };
});

// ── Import module under test ────────────────────────────────────────────────
const { asr } = await import('./asr.js');

// ── Tests ───────────────────────────────────────────────────────────────────
beforeEach(() => {
  vi.clearAllMocks();
  localStorageMock.clear();
});

describe('asr 函数', () => {
  it('应从 localStorage 读取 MIMO_API_KEY 并创建 OpenAI 客户端', async () => {
    localStorage.setItem('MIMO_API_KEY', 'test-mimo-key');

    const mockResponse = {
      id: 'chatcmpl-xxx',
      object: 'chat.completion',
      created: 1700000000,
      model: 'mimo-v2.5-asr',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: '[说话人A]: 你好，今天天气真好。\n[说话人B]: 是啊，我们去散步吧。',
          },
          finish_reason: 'stop',
        },
      ],
      usage: { total_tokens: 100, prompt_tokens: 50, completion_tokens: 50 },
    };
    mockCreate.mockResolvedValue(mockResponse);

    const base64Data = 'dGVzdCBhdWRpbw==';
    const result = await asr(base64Data, { language: 'zh', format: 'wav' });

    // 验证 OpenAI 客户端使用正确的配置
    const OpenAI = (await import('openai')).default;
    expect(OpenAI).toHaveBeenCalledWith({
      apiKey: 'test-mimo-key',
      baseURL: 'https://api.xiaomimimo.com/v1',
      dangerouslyAllowBrowser: true,
    });

    // 验证 API 调用参数
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate).toHaveBeenCalledWith({
      model: 'mimo-v2.5-asr',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'input_audio',
              input_audio: {
                data: `data:audio/wav;base64,${base64Data}`,
              },
            },
          ],
        },
      ],
      extra_body: {
        asr_options: {
          language: 'zh',
        },
      },
    });

    // 验证返回结果为 JSON 字符串
    expect(result).toBe(JSON.stringify(mockResponse, null, 2));
  });

  it('应使用默认参数（language=zh, format=wav）', async () => {
    localStorage.setItem('MIMO_API_KEY', 'test-mimo-key');
    mockCreate.mockResolvedValue({});

    await asr('dGVzdA==');

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        extra_body: {
          asr_options: {
            language: 'zh',
          },
        },
      }),
    );

    // 验证 content 中的 data URI 使用默认 format
    const callArg = mockCreate.mock.calls[0][0];
    const inputAudio = callArg.messages[0].content[0].input_audio;
    expect(inputAudio.data).toBe('data:audio/wav;base64,dGVzdA==');
  });

  it('当 MIMO_API_KEY 未设置时应抛出错误', async () => {
    localStorageMock.clear();

    await expect(asr('dGVzdA==')).rejects.toThrow('MIMO_API_KEY 未设置');
  });

  it('应返回格式化的 JSON 字符串', async () => {
    localStorage.setItem('MIMO_API_KEY', 'test-mimo-key');

    const mockResponse = {
      id: 'chatcmpl-xxx',
      choices: [
        {
          message: {
            content: '[说话人1]: 第一句话\n[说话人2]: 第二句话',
          },
        },
      ],
    };
    mockCreate.mockResolvedValue(mockResponse);

    const result = await asr('dGVzdA==');

    // 返回值应为 JSON 字符串
    expect(typeof result).toBe('string');
    const parsed = JSON.parse(result);
    expect(parsed.choices[0].message.content).toContain('[说话人1]');
    expect(parsed.choices[0].message.content).toContain('[说话人2]');
  });
});
