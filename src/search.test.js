import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── 可控 mock：捕获 TavilySearch 构造参数 ──────────────────────────────
const { TavilySearchMock } = vi.hoisted(() => ({
  TavilySearchMock: vi.fn(function (params) {
    this.params = params;
  }),
}));

vi.mock('@langchain/tavily', () => ({
  TavilySearch: TavilySearchMock,
}));

// ── Mock localStorage ──────────────────────────────────────────────────
const store = {};
vi.stubGlobal('localStorage', {
  getItem: vi.fn((key) => store[key] ?? null),
  setItem: vi.fn((key, value) => { store[key] = value; }),
  removeItem: vi.fn((key) => { delete store[key]; }),
  clear: vi.fn(() => { Object.keys(store).forEach((k) => delete store[k]); }),
});

const { createSearchTool } = await import('./search.js');

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

describe('createSearchTool', () => {
  it('未配置 TAVILY_API_KEY 时返回 null 且不构造工具', () => {
    const tool = createSearchTool();

    expect(tool).toBeNull();
    expect(TavilySearchMock).not.toHaveBeenCalled();
  });

  it('TAVILY_API_KEY 为空字符串时视为未配置，返回 null', () => {
    localStorage.setItem('TAVILY_API_KEY', '');

    expect(createSearchTool()).toBeNull();
    expect(TavilySearchMock).not.toHaveBeenCalled();
  });

  it('配置 TAVILY_API_KEY 时返回 TavilySearch 实例且构造参数正确', () => {
    localStorage.setItem('TAVILY_API_KEY', 'tvly-test-key');

    const tool = createSearchTool();

    expect(tool).toBeInstanceOf(TavilySearchMock);
    expect(TavilySearchMock).toHaveBeenCalledWith({
      tavilyApiKey: 'tvly-test-key',
      maxResults: 5,
    });
  });
});
