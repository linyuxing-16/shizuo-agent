# Shizuo Agent — 项目指南

## 项目概述

浏览器端 AI 语音助手，支持唤醒词检测 → 语音识别 → AI 对话 + 长期记忆。

**运行环境**：浏览器（非 Node.js 服务器）。所有模块依赖 Web API（`localStorage`、`getUserMedia`、`Cache API`、`AudioContext`、`MediaRecorder`）。

## 架构

| 模块 | 文件 | 职责 |
|------|------|------|
| Agent | `src/agent.js` | LangChain agent + DeepSeek Chat + Mem0 记忆中间件 |
| ASR | `src/asr.js` | 调用 MIMO API（OpenAI 兼容）进行语音转文字，支持流式/非流式 |
| 记忆 | `src/memory.js` | Mem0 长期记忆：`addMemories`/`searchMemories` + LangChain 中间件 + tool |
| 唤醒词 | `src/wakeword.js` | openWakeWord ONNX 模型实时检测 → VAD 录音 → 调 ASR |
| 配置页 | `config.html` | 管理 localStorage 中的 API Key |

数据流：`唤醒词检测 → MediaRecorder 录音 → VAD 静音判定 → base64 编码 → ASR → AI Agent + 记忆检索/存储`

## 构建与测试

```bash
npm test           # vitest run（运行全部测试）
npm run test:watch # vitest（监听模式）
```

项目使用 **Vite** 打包，**Vitest** 测试。无需编译步骤。

## 代码约定

- **语言**：注释和文档使用中文；代码标识符使用英文
- **模块**：ES Modules（`"type": "module"`），使用 `import`/`export`
- **类型注释**：所有导出函数使用 JSDoc（含 `@param`、`@returns`、`@throws`、`@example`）
- **配置存储**：所有 API Key 通过 `localStorage` 存取（键名：`DEEPSEEK_API_KEY`、`MEM0_API_KEY`、`MEM0_AGENT_ID`、`MEM0_USER_ID`、`MIMO_API_KEY`）
- **测试框架**：Vitest，对浏览器 API 使用 `vi.stubGlobal` + `vi.mock` 进行模拟
- **测试模式**：测试中 `wakeword.js` 的 vi.mock 使用**可变引用模式**（`_ortImpl`、`_asrImpl`）解决变量捕获问题

## 关键依赖

| 包 | 用途 |
|----|------|
| `langchain` / `@langchain/deepseek` | AI Agent 框架 |
| `openai` | MIMO ASR API 客户端（`dangerouslyAllowBrowser: true`） |
| `mem0ai` | 长期记忆服务 |
| `onnxruntime-web` | 唤醒词 ONNX 模型推理（WASM 后端） |
| `vitest` | 单元测试 |

## 常见陷阱

1. **浏览器 API 模拟**：`wakeword.test.js` 需要 stub `AudioContext`、`MediaRecorder`、`getUserMedia`、`Cache API`、`fetch`、`Blob` 等 — 新增测试时注意完整的 mock 依赖链
2. **vi.mock 提升**：`vi.mock` 会被提升到文件顶部，此时 `const` 变量尚未初始化，必须使用可变引用对象（如 `_ortImpl`）间接访问
3. **localStorage 键名**：大小写敏感，测试中需通过 `localStorageMock`（而非真实 `localStorage`）存取
4. **唤醒词白名单**：仅支持 `['alexa', 'hey mycroft', 'hey jarvis', 'hey rhasspy', 'weather', 'timer']`，新增需同步更新模型 URL 映射表
