import { createAgent, summarizationMiddleware } from 'langchain';
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
 * - 通过 summarizationMiddleware 自动摘要历史消息，防止超出上下文窗口
 *
 * @example
 * import agent from './agent.js';
 *
 * // 同一 threadId 的多轮对话会保持上下文
 * const result = await agent.invoke(
 *   { messages: [{ role: 'user', content: '你好，我叫小明' }] },
 *   { configurable: { threadId: 'thread-1' } },
 * );
 *
 * // agent 内部已配置 summarizationMiddleware，
 * // 当消息 token 数达到 128000 时自动摘要历史消息，保留最近 20 条
 */

const SYSTEM_PROMPT =
  '你是一个智能 AI 助手，拥有长期记忆能力。' +
  '你可以使用 search_memory 工具搜索历史对话记忆，' +
  '以记住用户之前提到过的信息。' +
  '在回答时，如果有相关记忆，请基于记忆内容提供个性化回复。';

/** @type {import('langchain').Agent|null} 惰性创建的 agent 实例 */
let agentInstance = null;

/**
 * 获取（必要时创建）agent 实例
 *
 * 首次调用时校验并实例化 ChatDeepSeek 模型，避免模块加载阶段因缺少
 * API Key 抛错导致整个页面脚本中断（按钮无响应）。
 *
 * @returns {import('langchain').Agent} 已创建的 agent 实例
 * @throws {Error} DEEPSEEK_API_KEY 未设置时抛出中文提示
 */
function getAgent() {
  if (!agentInstance) {
    const apiKey = localStorage.getItem('DEEPSEEK_API_KEY');
    if (!apiKey) {
      throw new Error('DEEPSEEK_API_KEY 未设置，请先在配置页设置');
    }

    const model = new ChatDeepSeek({ model: 'deepseek-chat', apiKey });
    const checkpointer = new MemorySaver();

    agentInstance = createAgent({
      model,
      tools: [searchMemoryTool],
      middleware: [
        summarizationMiddleware({
          model,
          trigger: { tokens: 128000 },
          keep: { messages: 20 },
        }),
        memoryMiddleware,
      ],
      checkpointer,
      systemPrompt: SYSTEM_PROMPT,
    });
  }
  return agentInstance;
}

/**
 * 默认导出的 agent 委托对象
 *
 * 延迟到实际调用时才创建底层 LangGraph agent；本仓库当前仅使用
 * invoke / stream 两个方法。
 */
const agent = {
  invoke: async (input, config) => getAgent().invoke(input, config),
  stream: (input, config) => getAgent().stream(input, config),
};

export default agent;

/**
 * 流式调用 agent，逐块返回 AI 回复内容
 *
 * 使用 LangGraph 的 streamMode: 'messages' 实现 token 级别的流式输出。
 * 每个事件为 [message, metadata] 二元组，仅过滤 agent 节点（model_request）
 * 且有文本内容的消息，逐个 yield 文本片段，调用方可以实时追加到 UI。
 *
 * @param {import('langchain').BaseMessage[]} messages - 输入消息列表
 * @param {object} config - 配置对象（需包含 configurable.thread_id）
 * @yields {string} AI 回复的文本片段
 * @throws {Error} API 调用失败时抛出
 * @example
 * let full = '';
 * for await (const chunk of streamAgent(
 *   [{ role: 'user', content: '你好' }],
 *   { configurable: { thread_id: 'thread-1' } },
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

  for await (const [message, metadata] of stream) {
    // langchain 1.5.x 的 ReactAgent 中，LLM 节点名为 model_request（旧版本为 agent）
    if (metadata?.langgraph_node === 'model_request' && message?.content) {
      yield message.content;
    }
  }
}
