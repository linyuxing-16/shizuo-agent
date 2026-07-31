import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Stub globalThis browser APIs ───────────────────────────────────────────
vi.stubGlobal('window', globalThis);

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

// ── Mock btoa（默认返回带前缀的假 base64） ─────────────────────────────────
vi.stubGlobal('btoa', vi.fn((str) => `base64:${str}`));

// ── Mock AudioContext / Web Audio API ──────────────────────────────────────
let audioContextClose = vi.fn();
let audioContextState = 'running';

const mockScriptProcessorNode = {
  onaudioprocess: null,
  connect: vi.fn(),
  disconnect: vi.fn(),
};

const mockMediaStreamSource = {
  connect: vi.fn(),
  disconnect: vi.fn(),
};

const MockAudioContext = vi.fn(function () {
  return {
    sampleRate: 48000,
    state: audioContextState,
    createMediaStreamSource: vi.fn(() => mockMediaStreamSource),
    createScriptProcessor: vi.fn(() => {
      const proc = Object.create(mockScriptProcessorNode);
      proc.onaudioprocess = null;
      Object.defineProperty(proc, 'onaudioprocess', {
        get() { return this._onaudioprocess; },
        set(fn) { this._onaudioprocess = fn; },
      });
      return proc;
    }),
    close: audioContextClose,
  };
});

vi.stubGlobal('AudioContext', MockAudioContext);
vi.stubGlobal('webkitAudioContext', undefined);

// ── Mock getUserMedia ──────────────────────────────────────────────────────
const mockMicTrack = { stop: vi.fn() };
const mockMicStream = {
  getTracks: vi.fn(() => [mockMicTrack]),
  getAudioTracks: vi.fn(() => [mockMicTrack]),
};

vi.stubGlobal('navigator', {
  mediaDevices: {
    getUserMedia: vi.fn(async () => mockMicStream),
  },
});

// ── Mock asr ────────────────────────────────────────────────────────────────
// 使用可变引用对象解决 vi.mock 工厂的变量捕获问题
const _asrImpl = { fn: null };
let mockAsr;

vi.mock('./asr.js', () => ({
  asr: (...args) => _asrImpl.fn?.(...args),
}));

// ── 初始化 mock 状态 ────────────────────────────────────────────────────────
beforeEach(() => {
  vi.clearAllMocks();
  localStorageMock.clear();

  mockAsr = vi.fn(async () => JSON.stringify({
    choices: [{ message: { content: '[说话人A]: 你好' } }],
  }));
  _asrImpl.fn = mockAsr;

  audioContextState = 'running';
  audioContextClose = vi.fn();
  navigator.mediaDevices.getUserMedia.mockResolvedValue(mockMicStream);
});

// ── 导入待测模块 ──────────────────────────────────────────────────────────
const {
  voiceActivate,
  WAKE_WORD_SUGGESTIONS,
  normalizeTranscript,
  containsWakeWord,
  int16ToWavBase64,
} = await import('./wakeword.js');

// ── 工具函数 ───────────────────────────────────────────────────────────────
/**
 * 触发一次 onaudioprocess，模拟一帧（4096 @48kHz → 约 1365 样本 @16kHz）
 * @param {number} rmsValue - 帧内样本幅值（>0.01 视为语音，<0.01 视为静音）
 */
function triggerAudioProcess(rmsValue = 0.05) {
  const context = MockAudioContext.mock.results[0]?.value;
  const processor = context?.createScriptProcessor?.mock?.results?.[0]?.value;
  if (!processor || !processor._onaudioprocess) return;

  const inputBuffer = {
    getChannelData: vi.fn(() => new Float32Array(4096).fill(rmsValue)),
    duration: 4096 / 48000,
    numberOfChannels: 1,
    sampleRate: 48000,
  };

  return processor._onaudioprocess({ inputBuffer });
}

/** 生成含唤醒词的 ASR JSON 字符串 */
function asrJson(text) {
  return JSON.stringify({ choices: [{ message: { content: text } }] });
}

// ── Tests ───────────────────────────────────────────────────────────────────
describe('WAKE_WORD_SUGGESTIONS 常量', () => {
  it('应导出建议唤醒词列表', () => {
    expect(WAKE_WORD_SUGGESTIONS.length).toBeGreaterThan(0);
    expect(WAKE_WORD_SUGGESTIONS).toContain('hey jarvis');
  });
});

describe('文本匹配工具', () => {
  it('normalizeTranscript 应去除说话人前缀、标点并小写化', () => {
    expect(normalizeTranscript('[说话人A]: Hey, Jarvis! 今天天气怎么样？'))
      .toBe('heyjarvis今天天气怎么样');
  });

  it('containsWakeWord 应匹配含空白/大小写的唤醒词', () => {
    expect(containsWakeWord('heyjarvis今天天气', 'hey jarvis')).toBe(true);
    expect(containsWakeWord('今天天气不错', 'hey jarvis')).toBe(false);
    expect(containsWakeWord('嘿时作帮我查一下', '嘿 时作')).toBe(true);
  });
});

describe('int16ToWavBase64', () => {
  it('应生成合法的 WAV 头与 PCM 数据', () => {
    const realBtoa = (str) => Buffer.from(str, 'binary').toString('base64');
    vi.stubGlobal('btoa', realBtoa);
    try {
      const base64 = int16ToWavBase64(new Int16Array([0, 100, -100]));
      const bytes = new Uint8Array(Buffer.from(base64, 'base64'));
      const ascii = (off, len) => String.fromCharCode(...bytes.slice(off, off + len));
      expect(ascii(0, 4)).toBe('RIFF');
      expect(ascii(8, 4)).toBe('WAVE');
      expect(ascii(12, 4)).toBe('fmt ');
      expect(ascii(36, 4)).toBe('data');
      expect(bytes.length).toBe(44 + 3 * 2);
    } finally {
      vi.stubGlobal('btoa', vi.fn((str) => `base64:${str}`));
    }
  });
});

describe('voiceActivate 参数校验', () => {
  it('空唤醒词应抛出错误', async () => {
    localStorage.setItem('MIMO_API_KEY', 'test-key');
    await expect(voiceActivate('', 3000)).rejects.toThrow('唤醒词不能为空');
    await expect(voiceActivate('   ', 3000)).rejects.toThrow('唤醒词不能为空');
  });

  it('仅含标点的唤醒词应抛出错误', async () => {
    localStorage.setItem('MIMO_API_KEY', 'test-key');
    await expect(voiceActivate('!!!', 3000)).rejects.toThrow('唤醒词无效');
  });

  it('MIMO_API_KEY 未设置时应抛出错误', async () => {
    localStorageMock.clear();
    await expect(voiceActivate('hey jarvis', 3000)).rejects.toThrow(
      'MIMO_API_KEY 未设置',
    );
  });

  it('silenceTimeoutMs 为负数应抛出错误', async () => {
    localStorage.setItem('MIMO_API_KEY', 'test-key');
    await expect(voiceActivate('hey jarvis', -1)).rejects.toThrow(
      'silenceTimeoutMs 必须是非负整数',
    );
  });
});

describe('voiceActivate 完整流程（ASR 周期检测）', () => {
  beforeEach(() => {
    localStorage.setItem('MIMO_API_KEY', 'test-key');
  });

  it('检测到唤醒词后静音超时应返回含唤醒词的 ASR 结果', async () => {
    // 第一次调用为唤醒检测，用 deferred 精确控制完成时机
    let resolveDetection;
    mockAsr.mockImplementationOnce(() => new Promise((resolve) => {
      resolveDetection = resolve;
    }));
    // 后续调用（最终指令 ASR）直接返回含唤醒词的结果
    mockAsr.mockImplementation(async () => asrJson('[说话人A]: hey jarvis 今天天气怎么样'));

    const promise = voiceActivate('hey jarvis', 100);

    // 发送足够的语音帧（每帧约 1365 样本 @16kHz，12 帧 ≈ 1s 触发检测）
    for (let i = 0; i < 15; i++) {
      await triggerAudioProcess(0.05);
    }

    // 等待唤醒检测调用 asr
    await vi.waitFor(() => {
      expect(resolveDetection).toBeDefined();
    });

    // 完成检测：返回含唤醒词的文本 → wakeDetected = true
    resolveDetection(asrJson('hey jarvis 今天天气怎么样'));

    // 发送静音帧（100ms 静音 ≈ 2 帧）触发指令采集结束
    for (let i = 0; i < 5; i++) {
      await triggerAudioProcess(0.001);
    }

    // 等待最终 ASR 结果
    const result = await promise;
    expect(typeof result).toBe('string');
    expect(result).toContain('hey jarvis');

    // 应至少调用两次 asr（唤醒检测 + 最终），且使用 WAV 非流式
    expect(mockAsr.mock.calls.length).toBeGreaterThanOrEqual(2);
    for (const call of mockAsr.mock.calls) {
      expect(call[1]).toMatchObject({ format: 'wav', stream: false });
    }
  }, 15000);

  it('未检测到唤醒词时不应触发指令采集', async () => {
    mockAsr.mockResolvedValue(asrJson('[说话人A]: 今天天气怎么样'));

    const promise = voiceActivate('hey jarvis', 100);

    // 发送语音帧，唤醒检测返回不含唤醒词的文本
    for (let i = 0; i < 15; i++) {
      await triggerAudioProcess(0.05);
    }
    await vi.waitFor(() => {
      expect(mockAsr).toHaveBeenCalled();
    });

    // 静音帧不应触发最终 ASR（未唤醒）
    for (let i = 0; i < 10; i++) {
      await triggerAudioProcess(0.001);
    }
    expect(mockAsr.mock.calls.length).toBeLessThanOrEqual(1);

    // promise 应保持 pending
    let settled = false;
    promise.finally(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 50));
    expect(settled).toBe(false);
  }, 15000);
});
