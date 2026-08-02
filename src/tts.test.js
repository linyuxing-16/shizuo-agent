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

// ── Mock fetch ─────────────────────────────────────────────────────────────
const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

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
 * 创建模拟的流式 SSE 事件
 *
 * @param {Object} options - 事件字段
 * @param {string|null} options.data - audio.data 值（base64）
 * @param {string|null} [options.finishReason='null'] - finish_reason 值
 * @param {number} [options.statusCode=200] - status_code 值
 * @param {string} [options.message=''] - message 值
 * @param {string} [options.code=''] - code 值
 * @returns {Object} DashScope SSE 事件对象
 */
function createSseEvent({
  data,
  finishReason = null,
  statusCode = 200,
  message = '',
  code = '',
}) {
  return {
    status_code: statusCode,
    request_id: 'req_xxx',
    code,
    message,
    output: {
      text: null,
      finish_reason: finishReason,
      choices: null,
      audio: {
        data: data ?? '',
        url: finishReason === 'stop' ? 'http://mock.oss.wav' : '',
        id: 'audio_xxx',
        expires_at: 1800000000,
      },
    },
    usage: { input_tokens: 0, output_tokens: 0, characters: 10 },
  };
}

/**
 * 创建模拟的 SSE fetch 响应
 *
 * @param {Array<string>} sseChunks - 原始 SSE 文本块（可切分为多段模拟分块读取）
 * @param {Object} [options] - 响应选项
 * @param {boolean} [options.ok=true] - 是否成功响应
 * @param {number} [options.status=200] - HTTP 状态码
 * @returns {Object} 模拟 Response 对象
 */
function createSseResponse(sseChunks, { ok = true, status = 200 } = {}) {
  const encoder = new TextEncoder();
  const byteChunks = sseChunks.map((chunk) => encoder.encode(chunk));
  let index = 0;
  const reader = {
    read: async () => {
      if (index < byteChunks.length) {
        return { done: false, value: byteChunks[index++] };
      }
      return { done: true, value: undefined };
    },
    releaseLock: vi.fn(),
  };
  return {
    ok,
    status,
    body: { getReader: () => reader },
    json: async () => ({ message: '模拟错误信息' }),
  };
}

/**
 * 将事件数组序列化为 SSE 文本
 */
function serializeSse(events) {
  return events.map((event) => `data:${JSON.stringify(event)}\n\n`).join('');
}

// ── Tests ───────────────────────────────────────────────────────────────────
beforeEach(() => {
  vi.clearAllMocks();
  localStorageMock.clear();
});

describe('streamTts 函数（流式）', () => {
  it('应从 localStorage 读取配置并调用 DashScope API 流式合成', async () => {
    localStorage.setItem('DASHSCOPE_API_KEY', 'test-dashscope-key');

    const chunk1Data = createMockPcmBase64();
    const chunk2Data = createMockPcmBase64();
    fetchMock.mockResolvedValue(
      createSseResponse([
        serializeSse([
          createSseEvent({ data: chunk1Data }),
          createSseEvent({ data: chunk2Data }),
          createSseEvent({ data: null, finishReason: 'stop' }),
        ]),
      ]),
    );

    const collected = [];
    for await (const chunk of streamTts('今天天气真好')) {
      collected.push(chunk);
    }

    // 验证请求地址、请求头和请求体
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
    );
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer test-dashscope-key',
      'X-DashScope-SSE': 'enable',
    });
    expect(JSON.parse(init.body)).toEqual({
      model: 'qwen3-tts-flash',
      input: {
        text: '今天天气真好',
        voice: 'Roy',
        language_type: 'Chinese',
      },
    });

    // 验证收集到 2 个音频块且内容正确
    expect(collected).toHaveLength(2);
    expect(collected[0]).toBeInstanceOf(ArrayBuffer);
    expect(collected[1]).toBeInstanceOf(ArrayBuffer);
    const samples1 = new Int16Array(collected[0]);
    expect(samples1[0]).toBe(0);
    expect(samples1[1]).toBe(1000);
  });

  it('当 DASHSCOPE_API_KEY 未设置时应抛出错误', async () => {
    const iter = streamTts('测试');
    await expect(iter.next()).rejects.toThrow('DASHSCOPE_API_KEY 未设置');
  });

  it('应跳过不含音频数据的 chunk 并在 stop 时结束', async () => {
    localStorage.setItem('DASHSCOPE_API_KEY', 'test-dashscope-key');
    fetchMock.mockResolvedValue(
      createSseResponse([
        serializeSse([
          createSseEvent({ data: null }),
          createSseEvent({ data: '' }),
          createSseEvent({ data: createMockPcmBase64() }),
          createSseEvent({ data: null, finishReason: 'stop' }),
          createSseEvent({ data: createMockPcmBase64() }),
        ]),
      ]),
    );

    const collected = [];
    for await (const chunk of streamTts('测试')) {
      collected.push(chunk);
    }

    // stop 之后的事件不再处理，只有第3个 chunk 包含有效音频
    expect(collected).toHaveLength(1);
  });

  it('应正确处理跨分块读取的 SSE 事件', async () => {
    localStorage.setItem('DASHSCOPE_API_KEY', 'test-dashscope-key');

    const sseText = serializeSse([
      createSseEvent({ data: createMockPcmBase64() }),
      createSseEvent({ data: null, finishReason: 'stop' }),
    ]);
    // 在中间位置切分为两段，模拟网络分块
    const splitAt = Math.floor(sseText.length / 2);
    fetchMock.mockResolvedValue(
      createSseResponse([sseText.slice(0, splitAt), sseText.slice(splitAt)]),
    );

    const collected = [];
    for await (const chunk of streamTts('测试')) {
      collected.push(chunk);
    }

    expect(collected).toHaveLength(1);
  });

  it('HTTP 非 2xx 时应抛出错误并携带服务端消息', async () => {
    localStorage.setItem('DASHSCOPE_API_KEY', 'test-dashscope-key');
    fetchMock.mockResolvedValue(createSseResponse([], { ok: false, status: 500 }));

    const iter = streamTts('测试');
    await expect(iter.next()).rejects.toThrow('TTS 请求失败：模拟错误信息');
  });

  it('SSE 事件中 status_code 非 200 时应抛出错误', async () => {
    localStorage.setItem('DASHSCOPE_API_KEY', 'test-dashscope-key');
    fetchMock.mockResolvedValue(
      createSseResponse([
        serializeSse([createSseEvent({ data: null, statusCode: 400, message: '参数错误' })]),
      ]),
    );

    const iter = streamTts('测试');
    await expect(iter.next()).rejects.toThrow('TTS 请求失败：参数错误');
  });

  it('响应缺少 body 时应抛出错误', async () => {
    localStorage.setItem('DASHSCOPE_API_KEY', 'test-dashscope-key');
    fetchMock.mockResolvedValue({ ok: true, body: null });

    const iter = streamTts('测试');
    await expect(iter.next()).rejects.toThrow('TTS 响应中未包含音频数据');
  });
});

describe('tts 函数（非流式）', () => {
  it('应将所有流式 chunk 聚合为单个 ArrayBuffer', async () => {
    localStorage.setItem('DASHSCOPE_API_KEY', 'test-dashscope-key');

    const chunk1Data = createMockPcmBase64();
    const chunk2Data = createMockPcmBase64();
    fetchMock.mockResolvedValue(
      createSseResponse([
        serializeSse([
          createSseEvent({ data: chunk1Data }),
          createSseEvent({ data: chunk2Data }),
          createSseEvent({ data: null, finishReason: 'stop' }),
        ]),
      ]),
    );

    const result = await tts('今天天气真好');

    expect(result).toBeInstanceOf(ArrayBuffer);
    expect(result.byteLength).toBe(32); // 2 个 chunk，每个 16 字节
    const samples = new Int16Array(result);
    expect(samples).toHaveLength(16);
    expect(samples[0]).toBe(0);
    expect(samples[1]).toBe(1000);
    expect(samples[8]).toBe(0);
    expect(samples[9]).toBe(1000);
  });

  it('当 DASHSCOPE_API_KEY 未设置时应抛出错误', async () => {
    await expect(tts('测试')).rejects.toThrow('DASHSCOPE_API_KEY 未设置');
  });
});
