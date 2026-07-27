import { createAgent } from 'langchain';
import { ChatDeepSeek } from '@langchain/deepseek';
import { MemorySaver } from '@langchain/langgraph-checkpoint';
import { memoryMiddleware, searchMemoryTool } from './memory.js';

/**
 * AI 助手 agent，集成记忆系统
 *
 * - 使用 DeepSeek Chat 作为底层模型
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

const model = new ChatDeepSeek({
  model: 'deepseek-chat',
  apiKey: localStorage.getItem('DEEPSEEK_API_KEY'),
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

/**
 * 流式调用 agent，逐块返回 AI 回复内容
 *
 * 使用 LangGraph 的 streamMode: 'messages' 实现 token 级别的流式输出。
 * 每次 yield 一个文本片段，调用方可以实时追加到 UI。
 *
 * @param {import('langchain').BaseMessage[]} messages - 输入消息列表
 * @param {object} config - 配置对象（需包含 configurable.threadId）
 * @yields {string} AI 回复的文本片段
 * @throws {Error} API 调用失败时抛出
 * @example
 * let full = '';
 * for await (const chunk of streamAgent(
 *   [{ role: 'user', content: '你好' }],
 *   { configurable: { threadId: 'thread-1' } },
 * )) {
 *   full += chunk;
 *   console.log('收到片段:', chunk);
 * }
 */
export async function* streamAgent(messages, config) {
  const stream = await agent.stream(
    { messages },
    { ...config, streamMode: 'messages' },
  );

  for await (const event of stream) {
    const [chunk, metadata] = event;
    if (metadata?.node === 'agent' && chunk?.content) {
      yield chunk.content;
    }
  }
}
