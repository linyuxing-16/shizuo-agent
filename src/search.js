import { TavilySearch } from '@langchain/tavily';

/**
 * 创建 Tavily 联网搜索工具
 *
 * 从 localStorage 读取 TAVILY_API_KEY；未配置时返回 null，
 * 此时 agent 不注册搜索工具，其余能力不受影响。
 * 配置后返回 TavilySearch 实例（工具名 tavily_search），
 * agent 在需要实时、最新或事实核查信息时自动调用。
 *
 * @returns {import('@langchain/tavily').TavilySearch|null} 已配置 API Key 时返回搜索工具，否则返回 null
 * @example
 * import { createSearchTool } from './search.js';
 *
 * const searchTool = createSearchTool();
 * // searchTool 为 null 或 TavilySearch 实例
 */
export function createSearchTool() {
  const apiKey = localStorage.getItem('TAVILY_API_KEY');
  if (!apiKey) {
    return null;
  }
  return new TavilySearch({
    tavilyApiKey: apiKey,
    maxResults: 5,
  });
}
