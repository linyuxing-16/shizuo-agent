# Shizuo Agent — 项目指南

## 项目概述

Shizuo Agent 是一个**浏览器端 AI 语音助手**，实现语音唤醒 → ASR 识别 → LLM 推理 → TTS 语音合成 → Live2D 角色展示的完整语音交互闭环。

```
唤醒词检测（openWakeWord ONNX）→ 录音 → ASR（MIMO API）→ AI 推理（DeepSeek + Mem0 记忆）→ TTS（MIMO API）→ PCM16 播放（Web Audio API）
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

- **`src/agent.js`** — LangGraph agent，使用 `ChatDeepSeek` + `MemorySaver`（checkpointer），流式输出通过 `streamMode: 'messages'` + `metadata?.node === 'agent'` 过滤
- **`src/asr.js`** — MIMO ASR API（OpenAI 兼容客户端），返回含说话人标签的文本
- **`src/tts.js`** — MIMO TTS API，默认闽南语合成；`tts()` 非流式，`streamTts()` 流式（默认 `pcm16` 格式，yield `ArrayBuffer`）
- **`src/wakeword.js`** — openWakeWord ONNX 模型 + VAD（RMS 阈值 0.01），`voiceActivate(wakeWord, silenceTimeoutMs)` 返回 ASR 结果 JSON 字符串
- **`src/audioPlayer.js`** — 纯 Web Audio API，`playPcm16(Int16Array)` 24kHz 播放
- **`src/memory.js`** — Mem0 长期记忆；`memoryMiddleware`（`after_agent` 中间件）自动保存对话，`searchMemoryTool`（名称 `search_memory`）供 agent 使用
- **`index.html`** — 主界面 + Live2D（oh-my-live2d）+ 语音循环
- **`config.html`** — 配置页，所有 API Key 存 `localStorage`

### 数据流

1. `voiceActivate` 唤醒 → 录音 → ASR → agent 推理（含记忆搜索） → TTS → 音频播放
2. 用户可通过 `AbortController` + `Promise.race` 中断语音循环

### 依赖说明

- `openai` SDK 复用于 MIMO API（非 OpenAI），base URL `https://api.xiaomimimo.com/v1`
- `langchain` 的 `tool` 和 `createMiddleware` 从 `'langchain'` 直接导入
- `onnxruntime-web` 使用 WASM 执行后端
- Vite 构建时 `oh-my-live2d` / `mem0ai` 的 Node.js 模块引用会被 tree-shake 移除，不影响浏览器运行

## 编码规范

### 导入风格

- ESM 模块（`"type": "module"`），相对路径导入，含 `.js` 后缀
- 具名导出优先：`export async function xxx`
- 默认导出：仅 `agent.js` 使用 `export default agent`

### 命名规范

| 类别 | 规范 | 示例 |
|------|------|------|
| 变量/函数 | `camelCase` | `getConfig`, `wakeWordDetected` |
| 常量 | `UPPER_SNAKE_CASE` | `WAKE_WORDS`, `SAMPLE_RATE` |
| 导出函数 | 动词开头 | `asr()`, `streamTts()`, `voiceActivate()` |
| 文件名 | `camelCase.js` | `agent.js`, `audioPlayer.js` |
| 测试文件 | `xxx.test.js` | `asr.test.js` |

### 错误处理

- 函数入口防御性校验，不满足时 `throw new Error('中文错误信息')`
- 浏览器 API 兼容检查（`getUserMedia`、`AudioContext`、`MediaRecorder`、`caches`）
- 清理阶段的非关键错误静默捕获：`catch { /* ignore */ }`

### JSDoc

所有导出函数写完整 JSDoc（含 `@param`、`@returns`、`@throws`、`@example`）。注释和错误信息使用中文。

### 测试（Vitest）

- `vi.mock('module', factory)` 模块级 mock
- `vi.stubGlobal('name', value)` 模拟全局 API
- 可变引用对象（如 `_ortImpl`、`_asrImpl`）解决 `vi.mock` 工厂函数的变量捕获问题
- 使用 `vi.waitFor(() => { expect(...).to... })` 异步等待条件
- `wakeword.test.js` 中需手动触发 `onaudioprocess`、模拟音频帧、调用 `recorderOnStop`

## 配置项

所有配置存 `localStorage`：

| Key | 说明 | 必需 |
|-----|------|------|
| `DEEPSEEK_API_KEY` | DeepSeek Chat API Key | ✅ |
| `MEM0_API_KEY` | Mem0 记忆服务 API Key | ✅ |
| `MIMO_API_KEY` | MIMO ASR/TTS API Key | ✅ |
| `MEM0_AGENT_ID` | Mem0 Agent ID（默认 `default-agent`） | ❌ |
| `MEM0_USER_ID` | Mem0 User ID（默认 `default-user`） | ❌ |
| `MIMO_TTS_DIALECT` | TTS 方言（默认 `闽南语`） | ❌ |
| `MIMO_TTS_VOICE` | TTS 音色（默认 `Chloe`） | ❌ |

## 部署

- 构建命令：`npm run build` → 输出到 `dist/`
- GitHub Pages 自动部署：推送 `main` 分支触发，详见 `.github/workflows/deploy.yml`
- 生产路径：`/shizuo-agent/`
