import { describe, it, expect, vi, beforeEach } from 'vitest';

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

  it('agent.stream 在缺少 key 时抛出中文错误', () => {
    expect(() => agent.stream({ messages: [] }, {})).toThrow(
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
});
