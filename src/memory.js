import MemoryClient from 'mem0ai';
import { createMiddleware, tool } from 'langchain';
import { z } from 'zod';

function getConfig() {
  return {
    apiKey: localStorage.getItem('MEM0_API_KEY'),
    agentId: localStorage.getItem('MEM0_AGENT_ID') || 'default-agent',
    userId: localStorage.getItem('MEM0_USER_ID') || 'default-user',
  };
}

function getClient() {
  const { apiKey } = getConfig();
  return new MemoryClient({ apiKey });
}

/**
 * 将 LangChain BaseMessage 数组转换为 mem0 的消息格式
 */
function toMem0Messages(messages) {
  const roleMap = { human: 'user', ai: 'assistant', system: 'system', tool: 'tool' };
  return messages.map((msg) => ({
    role: roleMap[msg.type] || msg.type,
    content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
  }));
}

/**
 * 向记忆系统添加消息列表
 * @param {Array<{role: string, content: string}>} messages - 消息列表
 * @returns {Promise<Array>} 添加的记忆结果
 */
export async function addMemories(messages) {
  const client = getClient();
  const { agentId, userId } = getConfig();
  return await client.add(messages, { agentId, userId });
}

/**
 * 在记忆系统中搜索相关内容
 * @param {string} query - 搜索查询字符串
 * @returns {Promise<{results: Array}>} 搜索结果
 */
export async function searchMemories(query) {
  const client = getClient();
  const { agentId, userId } = getConfig();
  return await client.search(query, { agentId, userId });
}

/**
 * LangChain agent 的 after_agent 中间件
 * 在 agent 执行完毕后自动将上下文消息列表保存到 mem0
 *
 * @example
 * import { createAgent } from 'langchain/agents';
 * import { memoryMiddleware } from './memory.js';
 *
 * const agent = createAgent({
 *   model: llm,
 *   tools: [...],
 *   middleware: [memoryMiddleware],
 * });
 *
 * const result = await agent.invoke({ messages: [...] });
 */
export const memoryMiddleware = createMiddleware({
  name: 'MemoryMiddleware',
  afterAgent: (state) => {
    const messages = toMem0Messages(state.messages);
    if (messages.length > 0) {
      addMemories(messages).catch((err) => {
        console.warn('记忆保存失败（非关键错误）:', err.message);
      });
    }
  },
});

/**
 *搜索记忆的 LangChain tool
 *可在 agent 中直接调用，用于检索历史记忆
 *
 * @example
 * import { createAgent } from 'langchain/agents';
 * import { searchMemoryTool } from './memory.js';
 *
 * const agent = createAgent({
 *   model: llm,
 *   tools: [searchMemoryTool],
 * });
 */
export const searchMemoryTool = tool(
  async ({ query }) => {
    const result = await searchMemories(query);
    return JSON.stringify(result.results);
  },
  {
    name: 'search_memory',
    description: '搜索 AI 助手的长期记忆，根据查询关键词返回相关的历史对话记忆',
    schema: z.object({
      query: z.string().describe('要搜索的记忆关键词或问题'),
    }),
  },
);
