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

/**
 * 创建一个模拟的异步可迭代流
 * @param {Array} chunks
 * @returns {AsyncIterable}
 */
async function* createMockStream(chunks) {
  for (const chunk of chunks) {
    yield chunk;
  }
}

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
const { tts, streamTts } = await import('./tts.js');

// ── Helpers ─────────────────────────────────────────────────────────────────
/**
 * 创建一个模拟的 base64 PCM16 数据（8个样本）
 */
function createMockPcmBase64() {
  const samples = new Int16Array([0, 1000, 2000, 3000, -1000, -2000, -3000, 0]);
  const bytes = new Uint8Array(samples.buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * 创建模拟的 TTS 非流式响应
 */
function createMockTtsResponse(base64Data) {
  return {
    id: 'chatcmpl-tts-xxx',
    object: 'chat.completion',
    created: 1700000000,
    model: 'mimo-v2.5-tts',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: '',
          audio: {
            id: 'aud_xxx',
            data: base64Data,
            expires_at: 1800000000,
            transcript: '测试文本',
          },
        },
        finish_reason: 'stop',
      },
    ],
    usage: { total_tokens: 50, prompt_tokens: 10, completion_tokens: 40 },
  };
}

/**
 * 创建模拟的流式 TTS chunk
 */
function createMockStreamChunk(base64Data) {
  return {
    id: 'chatcmpl-tts-xxx',
    object: 'chat.completion.chunk',
    created: 1700000000,
    model: 'mimo-v2.5-tts',
    choices: [
      {
        index: 0,
        delta: {
          audio: {
            id: 'aud_xxx',
            data: base64Data,
            expires_at: 1800000000,
          },
        },
        finish_reason: null,
      },
    ],
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────
beforeEach(() => {
  vi.clearAllMocks();
  localStorageMock.clear();
});

describe('tts 函数（非流式）', () => {
  it('应从 localStorage 读取配置并调用 MIMO TTS API', async () => {
    localStorage.setItem('MIMO_API_KEY', 'test-mimo-key');
    localStorage.setItem('MIMO_TTS_DIALECT', '闽南语');
    localStorage.setItem('MIMO_TTS_VOICE', 'Chloe');

    const mockPcmData = createMockPcmBase64();
    mockCreate.mockResolvedValue(createMockTtsResponse(mockPcmData));

    const result = await tts('今天天气真好');

    // 验证 OpenAI 客户端使用正确的配置
    const OpenAI = (await import('openai')).default;
    expect(OpenAI).toHaveBeenCalledWith({
      apiKey: 'test-mimo-key',
      baseURL: 'https://api.xiaomimimo.com/v1',
      dangerouslyAllowBrowser: true,
    });

    // 验证 API 调用参数（应自动添加方言标签）
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate).toHaveBeenCalledWith({
      model: 'mimo-v2.5-tts',
      messages: [
        {
          role: 'assistant',
          content: '(闽南语)今天天气真好',
        },
      ],
      audio: {
        format: 'wav',
        voice: 'Chloe',
      },
    });

    // 验证返回 ArrayBuffer
    expect(result).toBeInstanceOf(ArrayBuffer);
    const resultSamples = new Int16Array(result);
    expect(resultSamples[0]).toBe(0);
    expect(resultSamples[1]).toBe(1000);
  });

  it('当 MIMO_API_KEY 未设置时应抛出错误', async () => {
    await expect(tts('测试')).rejects.toThrow('MIMO_API_KEY 未设置');
  });

  it('应使用默认方言（闽南语）和音色（Chloe）', async () => {
    localStorage.setItem('MIMO_API_KEY', 'test-mimo-key');
    mockCreate.mockResolvedValue(createMockTtsResponse(createMockPcmBase64()));

    await tts('测试文本');

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          {
            role: 'assistant',
            content: '(闽南语)测试文本',
          },
        ],
        audio: expect.objectContaining({
          format: 'wav',
          voice: 'Chloe',
        }),
      }),
    );
  });

  it('应支持自定义方言和音色参数覆盖默认值', async () => {
    localStorage.setItem('MIMO_API_KEY', 'test-mimo-key');
    mockCreate.mockResolvedValue(createMockTtsResponse(createMockPcmBase64()));

    await tts('测试文本', { dialect: '粤语', voice: 'mimo_default', format: 'pcm16' });

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          {
            role: 'assistant',
            content: '(粤语)测试文本',
          },
        ],
        audio: {
          format: 'pcm16',
          voice: 'mimo_default',
        },
      }),
    );
  });

  it('不传方言时应不添加方言标签', async () => {
    localStorage.setItem('MIMO_API_KEY', 'test-mimo-key');
    mockCreate.mockResolvedValue(createMockTtsResponse(createMockPcmBase64()));

    await tts('测试文本', { dialect: '' });

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          {
            role: 'assistant',
            content: '测试文本',
          },
        ],
      }),
    );
  });

  it('响应中缺少音频数据时应抛出错误', async () => {
    localStorage.setItem('MIMO_API_KEY', 'test-mimo-key');
    mockCreate.mockResolvedValue({
      id: 'chatcmpl-xxx',
      choices: [{ message: { role: 'assistant', content: '', audio: null } }],
    });

    await expect(tts('测试')).rejects.toThrow('TTS 响应中未包含音频数据');
  });
});

describe('streamTts 函数（流式）', () => {
  it('应流式产出 pcm16 音频块', async () => {
    localStorage.setItem('MIMO_API_KEY', 'test-mimo-key');
    localStorage.setItem('MIMO_TTS_DIALECT', '闽南语');
    localStorage.setItem('MIMO_TTS_VOICE', 'Chloe');

    const chunk1Data = createMockPcmBase64();
    const chunk2Data = createMockPcmBase64();

    mockCreate.mockResolvedValue(
      createMockStream([
        createMockStreamChunk(chunk1Data),
        createMockStreamChunk(chunk2Data),
        {
          id: 'chatcmpl-tts-xxx',
          object: 'chat.completion.chunk',
          created: 1700000000,
          model: 'mimo-v2.5-tts',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        },
      ]),
    );

    const collected = [];
    for await (const chunk of streamTts('今天天气真好')) {
      collected.push(chunk);
    }

    // 验证 API 调用参数
    expect(mockCreate).toHaveBeenCalledWith({
      model: 'mimo-v2.5-tts',
      messages: [
        {
          role: 'assistant',
          content: '(闽南语)今天天气真好',
        },
      ],
      audio: {
        format: 'pcm16',
        voice: 'Chloe',
      },
      stream: true,
    });

    // 验证收集到 2 个音频块
    expect(collected).toHaveLength(2);
    expect(collected[0]).toBeInstanceOf(ArrayBuffer);
    expect(collected[1]).toBeInstanceOf(ArrayBuffer);

    // 验证音频数据内容
    const samples1 = new Int16Array(collected[0]);
    expect(samples1[0]).toBe(0);
    expect(samples1[1]).toBe(1000);
  });

  it('当 MIMO_API_KEY 未设置时应抛出错误', async () => {
    const iter = streamTts('测试');
    await expect(iter.next()).rejects.toThrow('MIMO_API_KEY 未设置');
  });

  it('应跳过不含音频数据的 chunk', async () => {
    localStorage.setItem('MIMO_API_KEY', 'test-mimo-key');
    mockCreate.mockResolvedValue(
      createMockStream([
        { id: 'x', choices: [{ index: 0, delta: {}, finish_reason: null }] },
        { id: 'y', choices: [] },
        createMockStreamChunk(createMockPcmBase64()),
        { id: 'z', choices: [{ index: 0, delta: { audio: null }, finish_reason: null }] },
      ]),
    );

    const collected = [];
    for await (const chunk of streamTts('测试')) {
      collected.push(chunk);
    }

    // 只有第3个 chunk 包含有效音频
    expect(collected).toHaveLength(1);
  });

  it('应支持自定义流式参数', async () => {
    localStorage.setItem('MIMO_API_KEY', 'test-mimo-key');
    mockCreate.mockResolvedValue(createMockStream([]));

    const iter = streamTts('测试', { dialect: '东北话', voice: 'mimo_default' });
    await iter.next();

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          {
            role: 'assistant',
            content: '(东北话)测试',
          },
        ],
        audio: {
          format: 'pcm16',
          voice: 'mimo_default',
        },
        stream: true,
      }),
    );
  });
});
