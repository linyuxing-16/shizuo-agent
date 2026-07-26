import { createAgent } from 'langchain';
import { ChatOpenAI } from '@langchain/openai';
import { MemorySaver } from '@langchain/langgraph-checkpoint';
import { memoryMiddleware, searchMemoryTool } from './memory.js';

/**
 * AI 助手 agent，集成记忆系统
 *
 * - 使用 OpenAI GPT-4o 作为底层模型
 * - 通过 searchMemoryTool 检索历史记忆
 * - 通过 memoryMiddleware 自动将对话保存到长期记忆
 * - 通过 MemorySaver checkpointer 实现短期对话记忆
 *
 * @example
 * import agent from './agent.js';
 *
 * // 同一 threadId 的多轮对话会保持上下文
 * const result = await agent.invoke(
 *   { messages: [{ role: 'user', content: '你好，我叫小明' }] },
 *   { configurable: { threadId: 'thread-1' } },
 * );
 */

const model = new ChatOpenAI({
  model: 'gpt-4o',
  apiKey: localStorage.getItem('OPENAI_API_KEY'),
});

const checkpointer = new MemorySaver();

const agent = createAgent({
  model,
  tools: [searchMemoryTool],
  middleware: [memoryMiddleware],
  checkpointer,
  systemPrompt:
    '你是一个智能 AI 助手，拥有长期记忆能力。' +
    '你可以使用 search_memory 工具搜索历史对话记忆，' +
    '以记住用户之前提到过的信息。' +
    '在回答时，如果有相关记忆，请基于记忆内容提供个性化回复。',
});

export default agent;
