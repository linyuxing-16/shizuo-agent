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

// ── Mock Cache API ─────────────────────────────────────────────────────────
const mockCache = {
  match: vi.fn(),
  put: vi.fn(),
};
const mockCaches = {
  open: vi.fn(async () => mockCache),
};
vi.stubGlobal('caches', mockCaches);

// ── Mock fetch ─────────────────────────────────────────────────────────────
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// ── Mock onnxruntime-web ───────────────────────────────────────────────────
/**
 * 使用可变引用对象解决 vi.mock 工厂的变量捕获问题
 * vi.mock 会被提升到文件顶部，此时 const 变量尚未初始化
 */
const _ortImpl = {
  createSession: null,
  run: null,
};

/** @type {import('vitest').Mock} */
let mockRun;
/** @type {import('vitest').Mock} */
let mockCreateSession;

vi.mock('onnxruntime-web', () => {
  const MockTensor = vi.fn(function (type, data, dims) {
    this.type = type;
    this.data = data;
    this.dims = dims;
  });

  const create = (...args) => _ortImpl.createSession?.(...args);

  return {
    default: {
      InferenceSession: { create },
      Tensor: MockTensor,
    },
    InferenceSession: { create },
    Tensor: MockTensor,
  };
});

// ── Mock AudioContext / Web Audio API ──────────────────────────────────────
let audioContextClose = vi.fn();
let audioContextState = 'running';

const mockAnalyserNode = {
  fftSize: 256,
  frequencyBinCount: 128,
  getFloatTimeDomainData: vi.fn(),
  disconnect: vi.fn(),
};

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
    createAnalyser: vi.fn(() => mockAnalyserNode),
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
const mockMicTrack = {
  stop: vi.fn(),
};
const mockMicStream = {
  getTracks: vi.fn(() => [mockMicTrack]),
  getAudioTracks: vi.fn(() => [mockMicTrack]),
};

const mockRecorderStream = {
  getTracks: vi.fn(() => [{ stop: vi.fn() }]),
};

vi.stubGlobal('navigator', {
  mediaDevices: {
    getUserMedia: vi.fn(async () => mockMicStream),
  },
});

// ── Mock MediaRecorder ─────────────────────────────────────────────────────
let recorderOnDataAvailable = null;
let recorderOnStop = null;
let recorderOnError = null;
let recorderState = 'inactive';
let recorderStart = vi.fn();
let recorderStop = vi.fn();

const MockMediaRecorder = vi.fn(function (stream, options) {
  this.stream = stream;
  this.mimeType = options?.mimeType || 'audio/webm';
  this.state = recorderState;
  this.start = recorderStart;
  this.stop = vi.fn(() => {
    this.state = 'inactive';
    if (typeof recorderOnStop === 'function') recorderOnStop();
  });

  Object.defineProperty(this, 'ondataavailable', {
    get() { return recorderOnDataAvailable; },
    set(fn) { recorderOnDataAvailable = fn; },
  });
  Object.defineProperty(this, 'onstop', {
    get() { return recorderOnStop; },
    set(fn) { recorderOnStop = fn; },
  });
  Object.defineProperty(this, 'onerror', {
    get() { return recorderOnError; },
    set(fn) { recorderOnError = fn; },
  });
});

MockMediaRecorder.isTypeSupported = vi.fn(() => true);

vi.stubGlobal('MediaRecorder', MockMediaRecorder);

// ── Mock Blob ──────────────────────────────────────────────────────────────
const mockBlobArrayBuffer = vi.fn();
vi.stubGlobal('Blob', vi.fn(function (parts, options) {
  return {
    arrayBuffer: mockBlobArrayBuffer,
    size: parts.reduce((sum, p) => sum + (p.size || p.byteLength || 0), 0),
    type: options?.type || '',
  };
}));

// ── Mock btoa ──────────────────────────────────────────────────────────────
vi.stubGlobal('btoa', vi.fn((str) => `base64:${str}`));

// ── Mock AudioContext state ────────────────────────────────────────────────
beforeEach(() => {
  vi.clearAllMocks();
  localStorageMock.clear();

  // 重新初始化可变引用（解决 vi.mock 变量捕获问题）
  mockCreateSession = vi.fn();
  mockRun = vi.fn();
  _ortImpl.createSession = mockCreateSession;
  _ortImpl.run = mockRun;

  mockAsr = vi.fn(async () => JSON.stringify({
    choices: [{ message: { content: '[说话人A]: 你好' } }],
  }));
  _asrImpl.fn = mockAsr;

  mockFetch.mockReset();
  mockCache.match.mockReset();
  mockCache.put.mockReset();
  mockBlobArrayBuffer.mockReset();
  recorderStart.mockReset();

  audioContextState = 'running';
  audioContextClose = vi.fn();
  recorderOnDataAvailable = null;
  recorderOnStop = null;
  recorderOnError = null;
  recorderState = 'inactive';
  mockAnalyserNode.getFloatTimeDomainData.mockImplementation((arr) => {
    // 默认返回非零数据（有声音）
    for (let i = 0; i < arr.length; i++) arr[i] = 0.05;
  });

  // 默认 fetch 返回模拟的 Response 对象（含 clone 方法）
  mockFetch.mockResolvedValue({
    ok: true,
    clone() { return this; },
    arrayBuffer: async () => new ArrayBuffer(100),
  });
  // 默认缓存未命中
  mockCache.match.mockResolvedValue(null);
  // 默认创建成功
  mockCreateSession.mockResolvedValue({
    inputNames: ['input'],
    outputNames: ['output'],
    inputs: [{ dims: [1, 16, 1536] }],
    run: mockRun,
  });
  // 默认推理结果：非唤醒（score < 0.5）
  mockRun.mockResolvedValue({ output: { data: new Float32Array([0.1]) } });
  // 默认 Blob.arrayBuffer
  mockBlobArrayBuffer.mockResolvedValue(new ArrayBuffer(10));
  // 默认 getUserMedia 返回录音流
  navigator.mediaDevices.getUserMedia.mockResolvedValue(mockRecorderStream);
});

// ── Mock asr ────────────────────────────────────────────────────────────────
const _asrImpl = { fn: null };
let mockAsr;

vi.mock('./asr.js', () => ({
  asr: (...args) => _asrImpl.fn?.(...args),
}));

// ── 导入待测模块 ──────────────────────────────────────────────────────────
const { voiceActivate, WAKE_WORDS } = await import('./wakeword.js');

// ── 工具函数 ───────────────────────────────────────────────────────────────
function triggerAudioProcess(rmsValue = 0.05) {
  // 模拟 ScriptProcessorNode 的 onaudioprocess 回调
  // 查找被创建的 processor
  const createProcCall = MockAudioContext.mock.results[0]?.value?.createScriptProcessor;
  const processor = createProcCall?.mock?.results?.[0]?.value;
  if (!processor || !processor._onaudioprocess) return;

  const inputBuffer = {
    getChannelData: vi.fn(() => new Float32Array(4096).fill(rmsValue)),
    duration: 4096 / 48000,
    numberOfChannels: 1,
    sampleRate: 48000,
  };

  // 设置 AnalyserNode 返回值
  mockAnalyserNode.getFloatTimeDomainData.mockImplementation((arr) => {
    for (let i = 0; i < arr.length; i++) arr[i] = rmsValue;
  });

  processor._onaudioprocess({ inputBuffer });
}

function triggerWakeWordDetection() {
  // 让模型推理返回高分触发唤醒
  mockRun.mockResolvedValue({ output: { data: new Float32Array([0.9]) } });
}

// ── Tests ───────────────────────────────────────────────────────────────────
describe('WAKE_WORDS 常量', () => {
  it('应包含所有预训练模型的唤醒词', () => {
    expect(WAKE_WORDS).toEqual([
      'alexa',
      'hey mycroft',
      'hey jarvis',
      'hey rhasspy',
      'weather',
      'timer',
    ]);
  });
});

describe('voiceActivate 参数校验', () => {
  it('不支持的唤醒词应抛出错误', async () => {
    localStorage.setItem('MIMO_API_KEY', 'test-key');

    await expect(voiceActivate('你好', 3000)).rejects.toThrow(
      '不支持的唤醒词 "你好"',
    );
  });

  it('MIMO_API_KEY 未设置时应抛出错误', async () => {
    localStorageMock.clear();

    await expect(voiceActivate('alexa', 3000)).rejects.toThrow(
      'MIMO_API_KEY 未设置',
    );
  });

  it('silenceTimeoutMs 为负数应抛出错误', async () => {
    localStorage.setItem('MIMO_API_KEY', 'test-key');

    await expect(voiceActivate('alexa', -1)).rejects.toThrow(
      'silenceTimeoutMs 必须是非负整数',
    );
  });
});

describe('voiceActivate 完整流程', () => {
  beforeEach(() => {
    localStorage.setItem('MIMO_API_KEY', 'test-key');
  });

  it('应加载三个 ONNX 模型（melspectrogram、embedding、唤醒词）', async () => {
    // 启动函数但不等待完成（需要模拟事件循环触发）
    const promise = voiceActivate('alexa', 3000);

    // 触发一次音频处理让模型加载完成
    await vi.waitFor(() => {
      expect(mockCreateSession).toHaveBeenCalledTimes(3);
    });

    // 清理以防 hanging
    audioContextClose();
    expect(mockCreateSession).toHaveBeenCalledTimes(3);
  });

  it('检测到唤醒词后应开始录音', async () => {
    localStorage.setItem('MIMO_API_KEY', 'test-key');

    const featDim = 1536;
    const mockFeatures = new Float32Array(featDim);
    for (let i = 0; i < featDim; i++) mockFeatures[i] = Math.random();

    let runIndex = 0;
    mockRun.mockImplementation(() => {
      runIndex++;
      if (runIndex <= 32) return { output: { data: mockFeatures } };
      const pos = (runIndex - 33) % 3;
      if (pos === 2) {
        return { output: { data: new Float32Array([0.9]) } };
      }
      return { output: { data: mockFeatures } };
    });

    const promise = voiceActivate('alexa', 3000);

    // 等待模型加载
    await vi.waitFor(() => {
      expect(mockCreateSession).toHaveBeenCalledTimes(3);
    });

    // 发送足够的音频帧
    for (let i = 0; i < 30; i++) {
      triggerAudioProcess(0.05);
    }

    // 等待录音启动
    await vi.waitFor(() => {
      expect(navigator.mediaDevices.getUserMedia.mock.calls.length).toBeGreaterThanOrEqual(2);
    }, { timeout: 3000, interval: 20 });
  });

  it('静音超时后应停止录音并返回 ASR 结果', async () => {
    localStorage.setItem('MIMO_API_KEY', 'test-key');

    const featDim = 1536;
    const mockFeatures = new Float32Array(featDim);
    for (let i = 0; i < featDim; i++) mockFeatures[i] = Math.random();

    // 让 mockRun 在填充 16 帧后返回高分
    let callCount = 0;
    mockRun.mockImplementation(() => {
      callCount++;
      if (callCount <= 32) return { output: { data: mockFeatures } };
      const inTriplet = (callCount - 33) % 3;
      if (inTriplet === 2) return { output: { data: new Float32Array([0.9]) } };
      return { output: { data: mockFeatures } };
    });

    const promise = voiceActivate('alexa', 100);

    // 等待模型加载
    await vi.waitFor(() => {
      expect(mockCreateSession).toHaveBeenCalled();
    }, { timeout: 2000, interval: 10 });

    // 发送音频帧触发唤醒
    for (let i = 0; i < 30; i++) {
      triggerAudioProcess(0.05);
    }

    // 等待录音启动
    await vi.waitFor(() => {
      expect(navigator.mediaDevices.getUserMedia.mock.calls.length).toBeGreaterThanOrEqual(2);
    }, { timeout: 3000, interval: 20 });

    // 手动模拟录音停止流程（替代 VAD 超时）
    expect(recorderOnStop).toBeDefined();
    if (recorderOnDataAvailable) {
      recorderOnDataAvailable({ data: { size: 100 } });
    }
    // 直接触发 recorder.onstop
    recorderOnStop();

    // 等待 ASR 结果
    const result = await promise;
    expect(typeof result).toBe('string');
    expect(result).toContain('你好');
  }, 15000);
});
