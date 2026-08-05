import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── 可控 mock：验证 IndexedDB 不可用时的 MemorySaver 回退路径 ────────────
const { createAgentMock, MemorySaverMock } = vi.hoisted(() => ({
  createAgentMock: vi.fn(),
  MemorySaverMock: class {
    deleteThread = vi.fn(async () => {});
  },
}));

vi.mock('langchain', () => ({
  createAgent: createAgentMock,
  createMiddleware: vi.fn(() => ({})),
  summarizationMiddleware: vi.fn(() => ({})),
  tool: vi.fn(() => ({})),
}));

vi.mock('@langchain/deepseek', () => ({
  ChatDeepSeek: class {},
}));

vi.mock('@langchain/tavily', () => ({
  TavilySearch: class {
    constructor(params) {
      this.params = params;
    }
  },
}));

vi.mock('@langchain/langgraph-checkpoint', () => ({
  MemorySaver: MemorySaverMock,
}));

vi.mock('./indexedDbCheckpointer.js', () => ({
  IndexedDBCheckpointer: class {
    ready = Promise.reject(new Error('mock: IndexedDB 不可用'));
  },
}));

// ── Mock localStorage（agent 惰性初始化后仅在调用时读取） ──────────────────
const store = {};
vi.stubGlobal('localStorage', {
  getItem: vi.fn((key) => store[key] ?? null),
  setItem: vi.fn((key, value) => { store[key] = value; }),
  removeItem: vi.fn((key) => { delete store[key]; }),
  clear: vi.fn(() => { Object.keys(store).forEach((k) => delete store[k]); }),
});

// ── 导入待测模块：模块加载本身不应因缺少 key 抛错 ────────────────────────
const { default: agent, streamAgent } = await import('./agent.js');

describe('agent 惰性初始化', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('缺少 DEEPSEEK_API_KEY 时模块导入不抛错', () => {
    expect(agent).toBeTruthy();
    expect(typeof agent.invoke).toBe('function');
    expect(typeof agent.stream).toBe('function');
  });

  it('agent.invoke 在缺少 key 时以中文错误拒绝', async () => {
    await expect(agent.invoke({ messages: [] }, {})).rejects.toThrow(
      'DEEPSEEK_API_KEY 未设置',
    );
  });

  it('agent.stream 在缺少 key 时拒绝并给出中文提示', async () => {
    await expect(agent.stream({ messages: [] }, {})).rejects.toThrow(
      'DEEPSEEK_API_KEY 未设置',
    );
  });

  it('streamAgent 在缺少 key 时拒绝并给出中文提示', async () => {
    const gen = streamAgent(
      [{ role: 'user', content: '你好' }],
      { configurable: { thread_id: 'thread-test' } },
    );
    await expect(gen.next()).rejects.toThrow('DEEPSEEK_API_KEY 未设置');
  });

  it('IndexedDB 不可用时回退到 MemorySaver，clearThread 复用同一实例', async () => {
    store.DEEPSEEK_API_KEY = 'test-key';
    createAgentMock.mockReturnValue({
      invoke: async () => 'ok',
      stream: async () => {},
    });

    await expect(
      agent.invoke({ messages: [] }, { configurable: { thread_id: 't' } }),
    ).resolves.toBe('ok');

    expect(createAgentMock).toHaveBeenCalledTimes(1);
    const { checkpointer } = createAgentMock.mock.calls[0][0];
    expect(checkpointer).toBeInstanceOf(MemorySaverMock);

    await agent.clearThread('t');
    expect(checkpointer.deleteThread).toHaveBeenCalledWith('t');
  });
});

describe('联网搜索工具注册', () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    createAgentMock.mockReset();
  });

  it('设置 TAVILY_API_KEY 时注册搜索工具并附带联网搜索提示词', async () => {
    store.DEEPSEEK_API_KEY = 'test-key';
    store.TAVILY_API_KEY = 'tvly-test';

    const captured = {};
    createAgentMock.mockImplementation((config) => {
      captured.tools = config.tools;
      captured.systemPrompt = config.systemPrompt;
      return { invoke: async () => 'ok', stream: async () => {} };
    });

    const { default: freshAgent } = await import('./agent.js');
    await freshAgent.invoke(
      { messages: [] },
      { configurable: { thread_id: 't' } },
    );

    expect(createAgentMock).toHaveBeenCalledTimes(1);
    expect(captured.tools).toHaveLength(2);
    expect(captured.tools[1].params).toEqual({
      tavilyApiKey: 'tvly-test',
      maxResults: 5,
    });
    expect(captured.systemPrompt).toContain('联网搜索');
  });

  it('未设置 TAVILY_API_KEY 时不注册搜索工具且提示词不含联网搜索', async () => {
    store.DEEPSEEK_API_KEY = 'test-key';

    const captured = {};
    createAgentMock.mockImplementation((config) => {
      captured.tools = config.tools;
      captured.systemPrompt = config.systemPrompt;
      return { invoke: async () => 'ok', stream: async () => {} };
    });

    const { default: freshAgent } = await import('./agent.js');
    await freshAgent.invoke(
      { messages: [] },
      { configurable: { thread_id: 't' } },
    );

    expect(createAgentMock).toHaveBeenCalledTimes(1);
    expect(captured.tools).toHaveLength(1);
    expect(captured.systemPrompt).not.toContain('联网搜索');
  });
});
