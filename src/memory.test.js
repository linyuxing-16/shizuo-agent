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

// ── Mock mem0ai ─────────────────────────────────────────────────────────────
const mockAdd = vi.fn();
const mockSearch = vi.fn();

vi.mock('mem0ai', () => {
  const MockMemoryClient = vi.fn(function () {
    return { add: mockAdd, search: mockSearch };
  });
  return { default: MockMemoryClient };
});

// ── Mock langchain ──────────────────────────────────────────────────────────
let capturedAfterAgent = null;

vi.mock('langchain', () => ({
  createMiddleware: vi.fn((config) => {
    capturedAfterAgent = config.afterAgent ?? null;
    return {
      name: config.name,
      afterAgent: config.afterAgent,
      stateSchema: config.stateSchema,
    };
  }),
  tool: vi.fn((func, fields) => {
    return {
      name: fields.name,
      description: fields.description,
      schema: fields.schema,
      invoke: async (input) => func(input, {}),
    };
  }),
}));

// ── Import module under test ────────────────────────────────────────────────
const {
  addMemories,
  searchMemories,
  memoryMiddleware,
  searchMemoryTool,
} = await import('./memory.js');

// ── Tests ───────────────────────────────────────────────────────────────────
beforeEach(() => {
  vi.clearAllMocks();
  localStorageMock.clear();
});

describe('配置读取', () => {
  it('应从 localStorage 读取 API Key', async () => {
    localStorage.setItem('MEM0_API_KEY', 'test-key');
    localStorage.setItem('MEM0_AGENT_ID', 'test-agent');
    localStorage.setItem('MEM0_USER_ID', 'test-user');

    await addMemories([{ role: 'user', content: 'hello' }]);

    // MemoryClient 构造函数应传入正确的 apiKey
    const MemoryClient = (await import('mem0ai')).default;
    expect(MemoryClient).toHaveBeenCalledWith({ apiKey: 'test-key' });
  });

  it('AGENT_ID 和 USER_ID 应有默认值', async () => {
    localStorage.setItem('MEM0_API_KEY', 'test-key');
    localStorage.removeItem('MEM0_AGENT_ID');
    localStorage.removeItem('MEM0_USER_ID');

    await addMemories([{ role: 'user', content: 'hello' }]);

    expect(mockAdd).toHaveBeenCalledWith(
      [{ role: 'user', content: 'hello' }],
      { agentId: 'default-agent', userId: 'default-user' },
    );
  });
});

describe('addMemories', () => {
  it('应调用 MemoryClient.add 并返回结果', async () => {
    localStorage.setItem('MEM0_API_KEY', 'test-key');
    const expected = [{ id: '1', memory: 'test' }];
    mockAdd.mockResolvedValue(expected);

    const messages = [{ role: 'user', content: '我叫小明' }];
    const result = await addMemories(messages);

    expect(mockAdd).toHaveBeenCalledTimes(1);
    expect(mockAdd).toHaveBeenCalledWith(messages, {
      agentId: 'default-agent',
      userId: 'default-user',
    });
    expect(result).toBe(expected);
  });

  it('应处理空消息列表', async () => {
    localStorage.setItem('MEM0_API_KEY', 'test-key');
    mockAdd.mockResolvedValue([]);

    const result = await addMemories([]);
    expect(mockAdd).toHaveBeenCalledWith([], expect.any(Object));
    expect(result).toEqual([]);
  });
});

describe('searchMemories', () => {
  it('应调用 MemoryClient.search 并返回结果', async () => {
    localStorage.setItem('MEM0_API_KEY', 'test-key');
    const expected = { results: [{ id: '1', memory: '喜欢篮球', score: 0.95 }] };
    mockSearch.mockResolvedValue(expected);

    const result = await searchMemories('我的爱好');

    expect(mockSearch).toHaveBeenCalledTimes(1);
    expect(mockSearch).toHaveBeenCalledWith('我的爱好', {
      agentId: 'default-agent',
      userId: 'default-user',
    });
    expect(result).toBe(expected);
  });
});

describe('memoryMiddleware', () => {
  it('应通过 createMiddleware 创建', () => {
    expect(memoryMiddleware).toBeDefined();
    expect(memoryMiddleware.name).toBe('MemoryMiddleware');
  });

  it('afterAgent 应转换消息并调用 addMemories', async () => {
    const mockMessages = [
      { type: 'human', content: '你好' },
      { type: 'ai', content: '你好！我是 AI 助手' },
      { type: 'human', content: '我叫小明' },
    ];

    localStorage.setItem('MEM0_API_KEY', 'test-key');
    mockAdd.mockResolvedValue([]);

    await capturedAfterAgent({ messages: mockMessages }, {});

    expect(mockAdd).toHaveBeenCalledWith(
      [
        { role: 'user', content: '你好' },
        { role: 'assistant', content: '你好！我是 AI 助手' },
        { role: 'user', content: '我叫小明' },
      ],
      expect.objectContaining({
        agentId: 'default-agent',
        userId: 'default-user',
      }),
    );
  });

  it('afterAgent 应处理空消息列表（不调用 addMemories）', async () => {
    localStorage.setItem('MEM0_API_KEY', 'test-key');

    await capturedAfterAgent({ messages: [] }, {});

    expect(mockAdd).not.toHaveBeenCalled();
  });

  it('afterAgent 应处理非字符串内容', async () => {
    const mockMessages = [
      {
        type: 'human',
        content: [{ type: 'text', text: '你好' }],
      },
    ];

    localStorage.setItem('MEM0_API_KEY', 'test-key');
    mockAdd.mockResolvedValue([]);

    await capturedAfterAgent({ messages: mockMessages }, {});

    expect(mockAdd).toHaveBeenCalledWith(
      [
        { role: 'user', content: JSON.stringify([{ type: 'text', text: '你好' }]) },
      ],
      expect.objectContaining({
        agentId: 'default-agent',
        userId: 'default-user',
      }),
    );
  });
});

describe('searchMemoryTool', () => {
  it('应正确命名', () => {
    expect(searchMemoryTool.name).toBe('search_memory');
    expect(searchMemoryTool.description).toContain('长期记忆');
  });

  it('应有正确的 Zod schema', () => {
    expect(searchMemoryTool.schema).toBeDefined();
    // schema 应包含 query 字段
    const shape = searchMemoryTool.schema._def?.shape?.() ?? searchMemoryTool.schema.shape?.();
    expect(shape).toHaveProperty('query');
  });

  it('invoke 时应调用 searchMemories 并返回 JSON', async () => {
    localStorage.setItem('MEM0_API_KEY', 'test-key');
    const mockResults = {
      results: [
        { id: '1', memory: '喜欢篮球', score: 0.95 },
        { id: '2', memory: '喜欢音乐', score: 0.85 },
      ],
    };
    mockSearch.mockResolvedValue(mockResults);

    const output = await searchMemoryTool.invoke({ query: '我的爱好' });

    expect(mockSearch).toHaveBeenCalledWith('我的爱好', {
      agentId: 'default-agent',
      userId: 'default-user',
    });
    expect(output).toBe(JSON.stringify(mockResults.results));
  });

  it('invoke 时应处理空搜索结果', async () => {
    localStorage.setItem('MEM0_API_KEY', 'test-key');
    mockSearch.mockResolvedValue({ results: [] });

    const output = await searchMemoryTool.invoke({ query: '不存在的内容' });

    expect(output).toBe('[]');
  });
});
