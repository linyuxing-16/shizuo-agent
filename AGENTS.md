# Shizuo Agent — 项目指南

## 项目概述

Shizuo Agent 是一个**浏览器端 AI 语音助手**，实现语音唤醒 → ASR 识别 → LLM 推理 → TTS 语音合成 → Live2D 角色展示的完整语音交互闭环。

```
唤醒词检测 + 指令识别（ASR 周期检测）→ AI 推理（DeepSeek + Mem0 记忆）→ TTS（Qwen3-TTS-Flash API）→ PCM16 播放（Web Audio API）
```

## 构建与测试

| 命令 | 用途 |
|------|------|
| `npm run dev` | 启动 Vite 开发服务器 |
| `npm run build` | 构建到 `dist/` 目录 |
| `npm run preview` | 预览构建产物 |
| `npm test` | 运行所有测试（`vitest run`） |
| `npm run test:watch` | 监听模式运行测试 |

## 架构

### 关键模块

- **`src/agent.js`** — LangGraph agent，使用 `ChatDeepSeek` + IndexedDB 持久化 checkpointer，流式输出通过 `streamMode: 'messages'` + `metadata?.node === 'agent'` 过滤
- **`src/indexedDbCheckpointer.js`** — 基于 IndexedDB 的 `BaseCheckpointSaver` 实现（数据库 `shizuo-agent-checkpoints`），对话上下文刷新后仍保留；IndexedDB 不可用时 `agent.js` 自动回退到内存 `MemorySaver`
- **`src/asr.js`** — MIMO ASR API（OpenAI 兼容客户端），返回含说话人标签的文本
- **`src/tts.js`** — DashScope Qwen3-TTS-Flash API（`qwen3-tts-flash`，音色 Roy 闽南语）；`tts()` 非流式（聚合 PCM16），`streamTts()` 流式（SSE，24kHz 单声道 pcm16，yield `ArrayBuffer`）
- **`src/wakeword.js`** — ASR 周期检测唤醒词 + VAD（RMS 阈值 0.01），`voiceActivate(wakeWord, silenceTimeoutMs)` 返回 ASR 结果 JSON 字符串（含唤醒词）
- **`src/audioPlayer.js`** — 纯 Web Audio API，`playPcm16(Int16Array)` 24kHz 播放
- **`src/memory.js`** — Mem0 长期记忆；`memoryMiddleware`（`after_agent` 中间件）自动保存对话，`searchMemoryTool`（名称 `search_memory`）供 agent 使用
- **`src/search.js`** — Tavily 联网搜索；`createSearchTool()` 从 localStorage 读取 `TAVILY_API_KEY`，未配置时返回 `null`（agent 不注册搜索工具），配置后注册 `TavilySearch`（工具名 `tavily_search`）
- **`index.html`** — 主界面 + Live2D（oh-my-live2d）+ 语音循环
- **`config.html`** — 配置页，所有 API Key 存 `localStorage`

### 数据流

1. `voiceActivate` 唤醒检测（ASR 周期检测）→ 指令识别（ASR）→ agent 推理（含记忆搜索与联网搜索） → TTS → 音频播放
2. 用户可通过 `AbortController` + `Promise.race` 中断语音循环

### 依赖说明

- `openai` SDK 复用于 MIMO API（非 OpenAI），base URL `https://api.xiaomimimo.com/v1`
- `langchain` 的 `tool` 和 `createMiddleware` 从 `'langchain'` 直接导入
- `@langchain/tavily` 提供 `TavilySearch` 搜索工具，浏览器端通过 `fetch` 直连 `https://api.tavily.com`（支持 CORS，无需代理）
- Vite 构建时 `oh-my-live2d` / `mem0ai` 的 Node.js 模块引用会被 tree-shake 移除，不影响浏览器运行

## 编码规范

### 导入风格

- ESM 模块（`"type": "module"`），相对路径导入，含 `.js` 后缀
- 具名导出优先：`export async function xxx`
- 默认导出：仅 `agent.js` 使用 `export default agent`

### 命名规范

| 类别 | 规范 | 示例 |
|------|------|------|
| 变量/函数 | `camelCase` | `getConfig`, `normalizeTranscript` |
| 常量 | `UPPER_SNAKE_CASE` | `WAKE_WORD_SUGGESTIONS`, `SAMPLE_RATE` |
| 导出函数 | 动词开头 | `asr()`, `streamTts()`, `voiceActivate()` |
| 文件名 | `camelCase.js` | `agent.js`, `audioPlayer.js` |
| 测试文件 | `xxx.test.js` | `asr.test.js` |

### 错误处理

- 函数入口防御性校验，不满足时 `throw new Error('中文错误信息')`
- 浏览器 API 兼容检查（`getUserMedia`、`AudioContext`）
- 清理阶段的非关键错误静默捕获：`catch { /* ignore */ }`

### JSDoc

所有导出函数写完整 JSDoc（含 `@param`、`@returns`、`@throws`、`@example`）。注释和错误信息使用中文。

### 测试（Vitest）

- `vi.mock('module', factory)` 模块级 mock
- `vi.stubGlobal('name', value)` 模拟全局 API
- 可变引用对象（如 `_asrImpl`）解决 `vi.mock` 工厂函数的变量捕获问题
- 使用 `vi.waitFor(() => { expect(...).to... })` 异步等待条件
- `wakeword.test.js` 中需手动触发 `onaudioprocess`、模拟音频帧，驱动 ASR 检测与静音结束

## 配置项

所有配置存 `localStorage`：

| Key | 说明 | 必需 |
|-----|------|------|
| `DEEPSEEK_API_KEY` | DeepSeek Chat API Key | ✅ |
| `MEM0_API_KEY` | Mem0 记忆服务 API Key | ✅ |
| `MIMO_API_KEY` | MIMO ASR API Key | ✅ |
| `MEM0_AGENT_ID` | Mem0 Agent ID（默认 `default-agent`） | ❌ |
| `MEM0_USER_ID` | Mem0 User ID（默认 `default-user`） | ❌ |
| `DASHSCOPE_API_KEY` | 阿里云百炼 API Key（Qwen3 TTS） | ✅ |
| `TAVILY_API_KEY` | Tavily 联网搜索 API Key（未配置时不注册搜索工具） | ❌ |
| `WAKE_WORD` | 自定义唤醒词（默认 `你好 助手`） | ❌ |

## 部署

- 构建命令：`npm run build` → 输出到 `dist/`
- GitHub Pages 自动部署：推送 `main` 分支触发，详见 `.github/workflows/deploy.yml`
- 生产路径：`/shizuo-agent/`
