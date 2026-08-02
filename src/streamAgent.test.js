import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── 可控 mock：向 streamAgent 注入合成事件 ────────────────────────────────
// streamAgent 经由模块内惰性创建的 agent 调用底层 stream，
// 这里 mock 掉 langchain 相关模块，用可变引用注入测试事件。
const { createAgentMock, streamEvents, streamState } = vi.hoisted(() => ({
  createAgentMock: vi.fn(),
  streamEvents: [],
  streamState: { lastConfig: null },
}));

vi.mock('langchain', () => ({
  createAgent: createAgentMock,
  summarizationMiddleware: vi.fn(() => ({})),
}));

vi.mock('@langchain/deepseek', () => ({
  ChatDeepSeek: class {},
}));

vi.mock('@langchain/langgraph-checkpoint', () => ({
  MemorySaver: class {},
}));

vi.mock('./indexedDbCheckpointer.js', () => ({
  IndexedDBCheckpointer: class {
    ready = Promise.resolve();
  },
}));

vi.mock('./memory.js', () => ({
  memoryMiddleware: {},
  searchMemoryTool: {},
}));

// ── Mock localStorage（getAgent 仅在调用时读取） ──────────────────────────
const store = {};
vi.stubGlobal('localStorage', {
  getItem: vi.fn((key) => store[key] ?? null),
  setItem: vi.fn((key, value) => { store[key] = value; }),
  removeItem: vi.fn((key) => { delete store[key]; }),
  clear: vi.fn(() => { Object.keys(store).forEach((k) => delete store[k]); }),
});

const { streamAgent } = await import('./agent.js');

function makeFakeAgent() {
  return {
    stream: (input, config) => {
      streamState.lastConfig = config;
      return (async function* () {
        yield* streamEvents;
      })();
    },
  };
}

async function collect(gen) {
  const chunks = [];
  for await (const chunk of gen) chunks.push(chunk);
  return chunks;
}

describe('streamAgent 流式事件过滤', () => {
  beforeEach(() => {
    store.DEEPSEEK_API_KEY = 'test-key';
    createAgentMock.mockReturnValue(makeFakeAgent());
    streamEvents.length = 0;
    streamState.lastConfig = null;
  });

  it('仅产出 model_request 节点且有内容的文本 chunk，并正确拼接', async () => {
    streamEvents.push(
      [{ content: '' }, { langgraph_node: 'model_request' }], // 空内容跳过
      [{ content: '你' }, { langgraph_node: 'model_request' }],
      [{ content: '好' }, { langgraph_node: 'tools' }], // 非 agent 节点跳过
      [{}, { langgraph_node: 'model_request' }], // 无 content 跳过
      [{ content: '！' }, { langgraph_node: 'model_request' }],
    );

    const chunks = await collect(
      streamAgent(
        [{ role: 'user', content: '你好' }],
        { configurable: { thread_id: 'thread-1' } },
      ),
    );

    expect(chunks).toEqual(['你', '！']);
  });

  it('以 streamMode: messages 调用底层 agent 并透传完整回复', async () => {
    streamEvents.push([{ content: '完整回复' }, { langgraph_node: 'model_request' }]);

    const chunks = await collect(
      streamAgent(
        [{ role: 'user', content: 'hi' }],
        { configurable: { thread_id: 'thread-2' } },
      ),
    );

    expect(streamState.lastConfig.streamMode).toBe('messages');
    expect(chunks).toEqual(['完整回复']);
  });

  it('全部事件被过滤时产出为空且不抛错', async () => {
    streamEvents.push(
      [{ content: 'x' }, { langgraph_node: 'tools' }],
      [{ content: '' }, { langgraph_node: 'model_request' }],
    );

    const chunks = await collect(
      streamAgent(
        [{ role: 'user', content: 'hi' }],
        { configurable: { thread_id: 'thread-3' } },
      ),
    );

    expect(chunks).toEqual([]);
  });
});
