# IAgentProvider 扩展调研：Mastra vs pi

> 调研目标：评估将 [mastra-ai/mastra](https://github.com/mastra-ai/mastra) 与 [earendil-works/pi](https://github.com/earendil-works/pi) 集成为 Octopus `IAgentProvider` 新实现的可行性、映射关系与工程方案。
> 调研日期：2026-06-18
> 源码版本：Mastra `@mastra/core@1.44.0-alpha.1` (main) / pi `v0.79.6` (main)

---

## 一、Octopus IAgentProvider 契约（扩展目标）

`packages/providers/src/types.ts:59` 定义：

```typescript
export interface IAgentProvider {
  sendQuery(prompt, cwd, resumeSessionId?, options?): AsyncGenerator<MessageChunk>
  getType(): string
  getLLMCalls?(): LLMCallRecord[]
}
```

### 关键特征

这不是一个纯 LLM 后端接口，而是一个**完整 Agent 运行时抽象**：

- `sendQuery` 接收 prompt + 工作目录 + 会话 + 选项（model/systemPrompt/skills/agents/abortSignal/maxBudgetUsd）
- 返回 `AsyncGenerator<MessageChunk>`——丰富的流式事件联合类型（text/thinking/tool_call/tool_result/ask_user_question/result/error）
- 现有实现 `ClaudeSDKProvider`（`packages/providers/src/claude/provider.ts:118`）包装 Claude Agent SDK（本身就是完整 agent：工具循环、文件操作、会话管理）
- 注册机制：`registerProvider(id, factory)` 工厂模式（`packages/providers/src/registry.ts`）

### MessageChunk 事件类型

```typescript
export type MessageChunk =
  | { type: 'message_start'; messageId: string; inputTokens?: number }
  | { type: 'message_delta'; stopReason: string; outputTokens?: number; messageId: string }
  | { type: 'message_stop'; messageId: string }
  | { type: 'text_delta'; content: string; messageId: string }
  | { type: 'text_done'; messageId: string }
  | { type: 'thinking_start'; messageId: string }
  | { type: 'thinking'; content: string; messageId: string }
  | { type: 'thinking_done'; messageId: string; thinkingDuration?: string }
  | { type: 'tool_call_start'; toolCallId: string; toolName: string; messageId: string }
  | { type: 'tool_call'; toolCallId: string; toolName: string; toolInput: unknown; messageId: string }
  | { type: 'tool_progress'; toolCallId: string; elapsedSeconds: number }
  | { type: 'tool_result'; toolCallId: string; content: string; isError?: boolean; toolDuration?: string }
  | { type: 'tool_summary'; summary: string; toolCallIds: string[] }
  | { type: 'ask_user_question'; toolCallId: string; questions: unknown }
  | { type: 'local_command_output'; content: string }
  | { type: 'status'; status: 'compacting' | 'requesting' | null }
  | { type: 'result'; content?: string; sessionId?: string; tokens?: TokenUsage; costUsd?: number; modelUsages?: ModelUsageEntry[] }
  | { type: 'error'; code: string; message: string }
```

### SendQueryOptions

```typescript
export interface SendQueryOptions {
  model?: string
  systemPrompt?: SystemPromptInput          // string | { type:'preset', preset:'claude_code', append? }
  abortSignal?: AbortSignal
  maxBudgetUsd?: number
  env?: Record<string, string>
  agent?: string
  skills?: string[]
  agents?: Record<string, AgentDefinition>   // Claude Agent SDK 子代理定义
}
```

---

## 二、两项目对比总览

| 维度 | **Mastra** (`@mastra/core`) | **pi** (`@earendil-works/pi-agent-core`) |
|------|----------------|----------------|
| 定位 | TS AI 应用/Agent 框架（25.2k★, Apache-2.0） | AI agent 工具集（63.6k★） |
| Agent 类 | `Agent`（`packages/core/src/agent/agent.ts:339`） | `Agent`（`packages/agent/src/agent.ts`） |
| LLM 绑定 | `model: MastraModelConfig`（magic string/实例/函数/回退链） | `streamFn: StreamFn`（函数注入） |
| Schema 库 | **zod**（与 octopus 一致 ✅） | **typebox**（需转换 ⚠️） |
| 流式协议 | `MastraModelOutput.fullStream`（AI SDK 扩展 chunk） | `AssistantMessageEventStream`（结构化事件） |
| 工具循环 | 内建 loop 引擎（maxSteps/stopWhen/审批/并发） | 内建 agent-loop（before/after 钩子/并发） |
| 记忆 | `MastraMemory`（thread/resource/持久化） | `AgentState.messages` + compaction + session JSONL |
| 子代理 | ✅ network 委派 + DelegationConfig | ❌ 单 agent（多角色在上层编排） |
| Node 要求 | ≥22.13.0 | ≥22.19.0 |
| 模块格式 | ESM + CJS 产物 | ESM only |
| Provider 解耦 | 松耦合（resolveModelConfig 运行时解析） | 极松耦合（streamFn 函数签名契约） |
| 稳定性 | 高（v1.44） | 中（v0.79，API 仍在变） |

---

## 三、Mastra 架构详解

### 3.1 项目概览

Mastra 是来自 Gatsby 团队的 TypeScript AI 应用/Agent 框架。核心能力：

- **Model Routing** — 通过统一接口连接 40+ provider（OpenAI/Anthropic/Gemini 等），支持 magic string `"openai/gpt-4o"` 直接路由
- **Agents** — 自主 Agent，LLM + 工具循环，支持多步推理、子代理委派、网络编排
- **Workflows** — 图工作流引擎（`.then()/.branch()/.parallel()`），支持 suspend/resume
- **Memory** — 对话历史 + 观察记忆
- **MCP** — Model Context Protocol server/client

### 3.2 Monorepo 包结构

| 包 | npm 名 | 职责 |
|----|--------|------|
| **core** | `@mastra/core` | 核心框架：Agent / LLM / Tools / Workflows / Memory / Storage / Stream / Loop |
| memory | `@mastra/memory` | 记忆系统（独立包） |
| evals | `@mastra/core/evals` | 评估器 |
| mcp | `@mastra/core/mcp` | MCP 集成 |
| server | `@mastra/server` | Hono REST API + SSE + WebSocket |
| cli | `@mastra/cli` | 命令行工具 |
| schema-compat | `@mastra/schema-compat` | Schema 兼容层（OpenAI/Anthropic/Google/DeepSeek/Meta） |

`packages/core/src/` 关键目录：
- `agent/` — Agent 类、MessageList、子代理、goal、durable agent
- `llm/model/` — Model 抽象核心：router / resolve-model / aisdk 包装层 / provider-registry / gateways
- `loop/` — Agent 执行循环引擎
- `stream/` — 流式输出抽象（`MastraModelOutput`, `FullOutput`）
- `tools/` / `tool-provider/` — 工具系统
- `memory/` — 记忆抽象

### 3.3 Agent 类

文件：`packages/core/src/agent/agent.ts:339`

```typescript
export class Agent<
  TAgentId extends string = string,
  TTools extends ToolsInput = ToolsInput,
  TOutput = undefined,
  TRequestContext extends Record<string, any> | unknown = unknown,
> extends MastraBase
  implements SubAgent<TAgentId, TRequestContext>
```

#### 构造参数（AgentConfig，`agent/types.ts:740`）

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` / `name` | `string` | 标识 |
| `instructions` | `DynamicArgument<AgentInstructions>` | 系统指令，**可为函数**（运行时按 requestContext 解析） |
| **`model`** | `DynamicArgument<MastraModelConfig \| ModelWithRetries[]>` | **模型配置**，必填，支持 string/对象/实例/函数/回退数组 |
| `tools` | `DynamicArgument<TTools>` | 工具集 |
| `memory` | `DynamicArgument<MastraMemory>` | 记忆实例 |
| `agents` | `Record<string, SubAgent>` | 子代理（用于 network 委派） |
| `scorers` | `MastraScorers` | 评估器 |
| `mastra` | `Mastra` | DI 容器（可选，缺省创建 ephemeral Mastra） |

> `DynamicArgument<T, RC>` = `T | ((args) => T | Promise<T>)`，几乎所有配置都支持运行时动态解析。

#### 核心方法

| 方法 | 位置 | 签名要点 |
|------|------|---------|
| `generate(messages, options?)` | `agent.ts:6923` | 非流式，返回 `Promise<FullOutput<OUTPUT>>`；支持 `structuredOutput`（Zod/JSONSchema） |
| `stream(messages, options?)` | `agent.ts:7294` | 流式，返回 `Promise<MastraModelOutput<OUTPUT>>`；支持 `untilIdle` 后台任务续跑 |
| `network(...)` | `agent.ts:6733` | 多代理网络编排（supervisor 模式） |
| `getLLM({requestContext, model?})` | `agent.ts:2377` | 返回 `MastraLLM`（LLM 包装实例） |
| `getModel({requestContext, model?})` | `agent.ts:2616` | 返回解析后的底层模型实例 |

### 3.4 LLM Provider 抽象

**核心设计**：Mastra **没有自创 provider 接口**，直接复用 Vercel AI SDK 的 `LanguageModelV1/V2/V3`，仅用 `Omit &` 重写 `doGenerate`/`doStream` 返回类型以统一为流式。

核心类型（`packages/core/src/llm/model/shared.types.ts`）：

```typescript
export type MastraLanguageModelV2 = Omit<LanguageModelV2, 'doGenerate' | 'doStream'> & {
  doGenerate: (options) => DoStreamResultPromiseV2;
  doStream: (options) => DoStreamResultPromiseV2;
};

export type MastraModelConfig =
  | LanguageModelV1            // AI SDK v4 实例
  | LanguageModelV2            // AI SDK v5 实例
  | LanguageModelV3            // AI SDK v6 实例
  | ModelRouterModelId         // magic string，如 "openai/gpt-4o"
  | OpenAICompatibleConfig     // {id:"provider/model"} | {providerId, modelId, url?, apiKey?, headers?}
  | MastraLanguageModel;       // 已包装的 Mastra 模型
```

**统一解析函数**（`llm/model/resolve-model.ts`）：`resolveModelConfig()` 按优先级解析——函数调用 → 已包装实例 → `specificationVersion` 字段判断版本 → magic string 路由 → 抛错。

**Magic string 路由**（`llm/model/router.ts:118`）：`ModelRouterLanguageModel` 通过 Gateway 系统（Netlify/Mastra/models.dev）把 `"openai/gpt-4o"` 解析为真实 provider 实例。

### 3.5 工具调用机制

- 工具创建：`createTool()`，基于 `@standard-schema/spec` + Zod
- 工具循环：`MastraLLMVNext` 内部用 `loop()`（`packages/core/src/loop/`），支持 `maxSteps` / `stopWhen`（如 `stepCountIs(5)`）
- 高级能力：`prepareStep`（每步前回调）、`onStepFinish`、`requireToolApproval`（人工审批）、`toolCallConcurrency`（并发）、`ToolHooks`（前后置钩子）
- 委派：子代理作为工具调用，`DelegationConfig` 提供 `onDelegationStart`/`onDelegationComplete`/`messageFilter` 钩子

### 3.6 流式输出机制

- `agent.stream()` 返回 `MastraModelOutput<OUTPUT>`（`packages/core/src/stream/base/output.ts`），暴露 `fullStream`（async iterable）、`text`、`object`、`usage`
- `MastraLanguageModelV2/V3` 统一了 `doGenerate`/`doStream`：**`doGenerate` 也返回 stream 格式**（"一切皆流"设计）
- `untilIdle` 模式：后台任务完成后自动续跑 LLM

---

## 四、pi 架构详解

### 4.1 项目概览

pi 是一套 AI agent 工具集，标语 "AI agent toolkit: unified LLM API, agent loop, TUI, coding agent CLI"。核心由三层组成：

| 层 | 包 | 职责 |
|----|----|------|
| LLM 抽象层 | `@earendil-works/pi-ai` | 统一多厂商 LLM API，自动模型发现、provider 注册表、流式协议 |
| Agent 运行时 | `@earendil-works/pi-agent-core` | 有状态 agent：工具循环、事件流、上下文压缩、会话持久化 |
| Coding Agent | `@earendil-works/pi-coding-agent` | 交互式 CLI + 扩展机制 |

### 4.2 仓库结构

```
packages/
├── ai/            ← @earendil-works/pi-ai（LLM provider 抽象）
│   └── src/
│       ├── types.ts              ← 核心类型（StreamFunction/Context/Message/Model/Tool）
│       ├── api-registry.ts       ← ApiProvider 接口 + 全局注册表
│       ├── stream.ts             ← stream/streamSimple/complete/completeSimple 入口
│       ├── models.ts             ← getModel/getModels 模型发现
│       ├── utils/event-stream.ts ← AssistantMessageEventStream（流返回类型）
│       └── providers/            ← 9 个内置 provider 实现
├── agent/         ← @earendil-works/pi-agent-core（agent 运行时）
│   └── src/
│       ├── agent.ts              ← Agent 类（有状态包装器）
│       ├── agent-loop.ts         ← runAgentLoop 低层循环
│       ├── types.ts              ← StreamFn/AgentTool/AgentLoopConfig/AgentEvent
│       ├── proxy.ts              ← streamProxy（自定义 StreamFn 参考实现）
│       └── harness/              ← compaction/session/skills/system-prompt
├── coding-agent/  ← CLI（含 examples/extensions/custom-provider-* 示例）
└── tui/
```

### 4.3 Agent 类

文件：`packages/agent/src/agent.ts`

```typescript
export interface AgentOptions {
  initialState?: Partial<{
    systemPrompt; model: Model<any>; thinkingLevel;
    tools: AgentTool<any>[]; messages: AgentMessage[]
  }>;
  convertToLlm?: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
  streamFn?: StreamFn;                 // ← LLM 绑定点
  getApiKey?: (provider: string) => Promise<string | undefined>;
  beforeToolCall?; afterToolCall?; prepareNextTurn?;
  steeringMode?: QueueMode; followUpMode?: QueueMode;
  sessionId?; thinkingBudgets?; transport?; toolExecution?;
}

export class Agent {
  constructor(options: AgentOptions = {}) { /* streamFn 默认 = streamSimple */ }
  async prompt(input: string | AgentMessage | AgentMessage[], images?): Promise<void>;
  async continue(): Promise<void>;
  subscribe(listener: (event: AgentEvent, signal: AbortSignal) => void | Promise<void>): () => void;
  steer(message: AgentMessage): void;   // 运行中插入转向消息
  followUp(message: AgentMessage): void;// agent 本要停止时再注入
  abort(): void; waitForIdle(): Promise<void>; reset(): void;
  get state(): AgentState;
}
```

**关键设计**：主要方法不是 `generate/run`，而是 **`prompt()` / `continue()`**（事件驱动，返回 `Promise<void>`）。结果通过 `subscribe()` 的事件流获取。

### 4.4 LLM Provider 抽象

**核心接口**：`ApiProvider`（`packages/ai/src/api-registry.ts`）——按 **API 协议**注册，不是按厂商：

```typescript
export interface ApiProvider<TApi extends Api, TOptions extends StreamOptions> {
  api: TApi;
  stream: StreamFunction<TApi, TOptions>;        // 原始选项
  streamSimple: StreamFunction<TApi, SimpleStreamOptions>;  // reasoning-aware
}

export type StreamFunction<TApi extends Api, TOptions extends StreamOptions> = (
  model: Model<TApi>,
  context: Context,
  options?: TOptions,
) => AssistantMessageEventStream;

export interface Context {
  systemPrompt?: string;
  messages: Message[];
  tools?: Tool[];
}
```

`Api` 是协议标识符（`KnownApi` = `openai-completions | openai-responses | anthropic-messages | google-generative-ai | google-vertex | mistral-conversations | bedrock-converse-stream | azure-openai-responses | openai-codex-responses`）。

**注册机制**：全局 Map 按 `api` 字符串键，`registerApiProvider()` / `getApiProvider()` / `unregisterApiProviders(sourceId)` / `clearApiProviders()`。`register-builtins.ts` 在模块加载时自动注册全部 9 个内置 API（懒加载）。

**provider 需要实现**：两个函数 `stream` 和 `streamSimple`，签名都是 `(model, context, options?) => AssistantMessageEventStream`。契约：
- **不得 throw**，失败必须编码进返回流（`error` 事件 + `stopReason:"error"|"aborted"`）
- 必须先发 `start`，再发增量，以 `done` 或 `error` 终止
- 需正确填充 `AssistantMessage.usage`（input/output/cacheRead/cacheWrite/cost）

### 4.5 工具调用机制

```typescript
export interface AgentTool<TParameters extends TSchema = TSchema> extends Tool<TParameters> {
  label: string;
  prepareArguments?: (args: unknown) => Static<TParameters>;
  execute: (toolCallId, params, signal?, onUpdate?) => Promise<AgentToolResult>;
  executionMode?: ToolExecutionMode;  // "sequential" | "parallel"
}
```

- 参数 schema 用 **typebox**（`Type.Object(...)`），非 zod
- 循环逻辑：assistant 消息含 `ToolCall` → loop 校验参数 → `beforeToolCall` 钩子（可 block）→ 并发/顺序执行 → `afterToolCall` 钩子 → 把 `ToolResultMessage` 喂回 LLM → 下一轮
- 工具失败应 **throw**（被捕获后以 `isError:true` 报给 LLM）

### 4.6 流式输出机制

`AssistantMessageEventStream`（`packages/ai/src/utils/event-stream.ts`）返回结构化事件：

`start | text_start | text_delta | text_end | thinking_* | toolcall_* | done | error`

每个事件都带 `partial: AssistantMessage`（累积中的完整消息）。`.result(): Promise<AssistantMessage>` 用于非流式取最终结果。

### 4.7 高级特性

- **Steering / Follow-up 队列**：运行中 `steer()` 插入消息；`followUp()` 在 agent 本要停止时再注入续跑
- **上下文压缩**：`harness/compaction/`（`compact()`、`shouldCompact()`、`generateSummary()`）
- **会话持久化**：`harness/session/`（JSONL 落盘）
- **理由模型（thinking）**：`thinkingLevel: off|minimal|low|medium|high|xhigh`

---

## 五、Mastra 集成方案

### 5.1 映射关系

| IAgentProvider | Mastra 对应 |
|----------------|-------------|
| `sendQuery()` | `agent.generate()` / `agent.stream()` |
| `MessageChunk.text_delta` | `fullStream` 的 `text-delta` part |
| `MessageChunk.tool_call/result` | `fullStream` 的 `tool-call`/`tool-result` part |
| `MessageChunk.thinking` | `fullStream` 的 reasoning part |
| `MessageChunk.result` | `stream.usage` + `stream.text` |
| `SendQueryOptions.model` | `Agent.model`（magic string 如 `"anthropic/claude-sonnet-4-5"`） |
| `SendQueryOptions.systemPrompt` | `Agent.instructions` |
| `SendQueryOptions.agents` | `Agent.agents`（SubAgent 委派） |
| `SendQueryOptions.abortSignal` | `generate(stream, { abortSignal })` |
| `getLLMCalls()` | 需自行拦截（Mastra 无直接暴露，可用 OTel 或包装 doStream） |

### 5.2 集成骨架

```typescript
import { Agent } from '@mastra/core/agent'
import type { IAgentProvider, SendQueryOptions, MessageChunk } from '../types'

export class MastraProvider implements IAgentProvider {
  getType() { return 'mastra' }

  async *sendQuery(
    prompt: string,
    cwd: string,
    resumeSessionId?: string,
    options?: SendQueryOptions
  ): AsyncGenerator<MessageChunk> {
    const agent = new Agent({
      id: 'octopus-agent',
      name: 'Octopus Agent',
      instructions: typeof options?.systemPrompt === 'string' ? options.systemPrompt : '',
      model: options?.model ?? 'anthropic/claude-sonnet-4-5',  // magic string
      // tools: { ... },  // 需用 mastra createTool 包装
    })

    const stream = await agent.stream(prompt, { abortSignal: options?.abortSignal })

    for await (const part of stream.fullStream) {
      // mastra chunk → MessageChunk 转换
      if (part.type === 'text-delta') {
        yield { type: 'text_delta', content: part.textDelta, messageId: 'mastra' }
      } else if (part.type === 'tool-call') {
        yield { type: 'tool_call', toolCallId: part.toolCallId, toolName: part.toolName, toolInput: part.input, messageId: 'mastra' }
      } else if (part.type === 'tool-result') {
        yield { type: 'tool_result', toolCallId: part.toolCallId, content: String(part.result), messageId: 'mastra' }
      }
      // ... thinking/reasoning 等
    }

    const usage = stream.usage
    yield {
      type: 'result',
      tokens: { input: usage.promptTokens, output: usage.completionTokens },
      modelUsages: [...]
    }
  }
}
```

### 5.3 需要引入的 npm 包

```
@mastra/core
zod (^3.25 || ^4)              # peerDep
+ 至少一个 provider 途径（二选一）：
  (a) magic string 模式：无需额外包，依赖 gateway 网络（或 MASTRA_OFFLINE + 缓存）
  (b) 显式实例模式：@ai-sdk/openai 或对应 @ai-sdk/*-v5/-v6 别名包
```

### 5.4 关键风险

1. **chunk 协议差异**：Mastra 的 `fullStream` chunk 类型是 AI SDK 扩展版（含 runId/scoring/tripwire），需逐一映射到 `MessageChunk`
2. **三版本 SDK 并存**：v4/v5/v6 通过 npm 别名共存，引入额外 provider 包必须用对应别名版本，否则 `specificationVersion` 对不上
3. **V1 模型方法分裂**：AI SDK v4 模型不能用 `agent.generate()`/`stream()`，必须用 `generateLegacy()`/`streamLegacy()`，新集成应直接用 v5/v6
4. **Mastra DI 依赖**：Agent 强依赖 `Mastra` 实例，裸 `new Agent()` 创建 ephemeral Mastra（无持久化/可观测性），生产集成建议显式构造 `new Mastra({...})`
5. **Gateway 网络依赖**：magic string 模式默认访问外部网关获取 provider 元数据，内网需 `MASTRA_OFFLINE=true` 并预置缓存
6. **cwd 语义**：Mastra Agent 无 "工作目录" 概念（不像 Claude SDK 在 cwd 执行命令），需通过工具自行实现文件/bash 操作
7. **skills/agents 语义**：octopus 的 `skills`/`agents`(AgentDefinition) 是 Claude SDK 特有概念，Mastra 无直接对应，需映射为 tools 或 instructions
8. **zod v4 子路径**：Mastra 全量 `import { z } from 'zod/v4'`，要求 zod ≥ 4 或 zod 3.25+ 的 v4 兼容入口
9. **EE 目录许可**：`packages/core/src/auth/ee/`、`agent-builder/ee/` 等是企业许可，生产使用需授权

---

## 六、pi 集成方案

### 6.1 映射关系

| IAgentProvider | pi 对应 |
|----------------|---------|
| `sendQuery()` | `agent.prompt()` + `agent.subscribe()` |
| `MessageChunk.text_delta` | `AgentEvent`(`message_update`) → `AssistantMessageEvent.text_delta` |
| `MessageChunk.tool_call/result` | `AssistantMessageEvent.toolcall_*` |
| `MessageChunk.thinking` | `AssistantMessageEvent.thinking_*` |
| `MessageChunk.result` | `stream.result()` 的 `usage` + `stopReason` |
| `SendQueryOptions.model` | `initialState.model`（`getModel(provider, modelId)`） |
| `SendQueryOptions.systemPrompt` | `initialState.systemPrompt` |
| `SendQueryOptions.abortSignal` | `agent.abort()` |
| `getLLMCalls()` | 需包装 `streamFn` 拦截 |

### 6.2 集成骨架

```typescript
import { Agent } from '@earendil-works/pi-agent-core'
import { getModel, type Context, type Message } from '@earendil-works/pi-ai'
import type { IAgentProvider, SendQueryOptions, MessageChunk } from '../types'

export class PiAgentProvider implements IAgentProvider {
  getType() { return 'pi' }

  async *sendQuery(
    prompt: string,
    cwd: string,
    resumeSessionId?: string,
    options?: SendQueryOptions
  ): AsyncGenerator<MessageChunk> {
    const agent = new Agent({
      initialState: {
        systemPrompt: typeof options?.systemPrompt === 'string' ? options.systemPrompt : '',
        model: getModel('anthropic', options?.model ?? 'claude-sonnet-4-5'),
        // tools: piAgentTools,  // 需用 typebox 定义
      },
      // streamFn: 默认 streamSimple，或传自定义
    })

    const queue: MessageChunk[] = []
    let done = false

    agent.subscribe((event) => {
      // pi AgentEvent → MessageChunk 转换
      if (event.type === 'message_update') {
        const ev = event.update
        if (ev.type === 'text_delta') {
          queue.push({ type: 'text_delta', content: ev.delta, messageId: 'pi' })
        } else if (ev.type === 'toolcall_end') {
          queue.push({ type: 'tool_call', toolCallId: ev.toolCall.id, toolName: ev.toolCall.name, toolInput: ev.toolCall.input, messageId: 'pi' })
        }
        // ... thinking 等
      } else if (event.type === 'agent_done') {
        done = true
      }
    })

    await agent.prompt(prompt)

    // 排空队列
    while (!done || queue.length) {
      if (queue.length) yield queue.shift()!
      else await new Promise(r => setTimeout(r, 10))
    }

    const lastMsg = agent.state.messages.at(-1)
    yield {
      type: 'result',
      tokens: { input: lastMsg?.usage?.input ?? 0, output: lastMsg?.usage?.output ?? 0 }
    }
  }
}
```

### 6.3 需要引入的 npm 包

```jsonc
{
  "dependencies": {
    "@earendil-works/pi-ai": "^0.79.6",
    "@earendil-works/pi-agent-core": "^0.79.6",
    "typebox": "1.1.38"    // 定义 Tool parameters schema（pi 用 typebox 不用 zod）
  },
  "engines": { "node": ">=22.19.0" }
}
```

### 6.4 替代方案：仅用 pi-ai 做 LLM 后端（最小侵入）

若不需要完整 agent 运行时，可直接用 `streamSimple`：

```typescript
import { streamSimple, getModel, type Context } from '@earendil-works/pi-ai'

// 实现 IAgentProvider，内部调 streamSimple，把 AssistantMessageEventStream 转为 MessageChunk
const s = streamSimple(model, context, { apiKey, signal, reasoning, maxTokens })
for await (const ev of s) {
  if (ev.type === 'text_delta') yield { type: 'text_delta', content: ev.delta, messageId: 'pi' }
  // ...
}
```

或实现自定义 `ApiProvider` 注册新协议后端：

```typescript
import { registerApiProvider, createAssistantMessageEventStream } from '@earendil-works/pi-ai'

const myStreamSimple = (model, context, options) => {
  const s = createAssistantMessageEventStream()
  // 调你的后端，逐块 push text_delta / toolcall_delta ...
  return s
}
registerApiProvider({ api: 'my-backend', stream: myStreamSimple, streamSimple: myStreamSimple })
```

### 6.5 关键风险

1. **typebox vs zod**：pi 的 `Tool.parameters` 用 typebox `TSchema`，octopus/Claude SDK 用 zod，需双向转换或以 JSON Schema 中转
2. **事件驱动非返回值**：`prompt()` 返回 `Promise<void>`，结果从 `subscribe()` 取，需桥接为 AsyncGenerator
3. **cwd 语义**：同 Mastra，pi Agent 无 "工作目录" 概念，需通过工具实现
4. **无内建 sub-agent**：octopus 的 `agents`(AgentDefinition map) 无法直接映射
5. **skills 语义**：octopus 的 skills 是 Claude Code 特有，pi 无对应
6. **ESM only**：octopus 若有 CJS 部分需动态 import
7. **全局注册表有状态**：`registerApiProvider` 写全局 Map，多实例需注意隔离（或用 `streamFn` 旁路）
8. **StreamFunction 契约严苛**：不得 throw，所有失败必须编码进流，否则 agent loop 卡住
9. **版本快速迭代**：v0.79.6，API 仍在变，需锁定精确版本

---

## 七、集成难度对比与建议

### 7.1 评估矩阵

| 评估项 | Mastra | pi |
|--------|--------|-----|
| chunk 协议映射 | 中（AI SDK chunk 类型多但有规律） | 中（结构化事件，映射清晰） |
| schema 兼容 | ✅ 低（都用 zod） | ⚠️ 高（typebox↔zod 转换） |
| agent 工具循环 | ✅ 内建完整 | ✅ 内建完整 |
| sub-agent 支持 | ✅ network 委派 | ❌ 需上层编排 |
| cwd/bash 工具 | ❌ 需自行实现 | ❌ 需自行实现 |
| skills 映射 | ⚠️ 需映射为 tools/instructions | ⚠️ 需映射为 tools/instructions |
| getLLMCalls 拦截 | 中（OTel 或包装 doStream） | 低（包装 streamFn 即可） |
| 依赖体积 | 大（三版本 AI SDK + gateway） | 中（按需 import 子路径） |
| 稳定性 | 高（v1.44，Apache-2.0） | 中（v0.79，API 仍在变） |
| API 模式契合度 | 高（generate/stream 返回值模式） | 中（事件驱动需桥接） |

### 7.2 建议

**优先集成 Mastra**：

- zod 兼容是决定性优势——octopus 全栈 zod，pi 的 typebox 会带来持续的 schema 转换负担
- sub-agent/network 委派能更好映射 octopus 的 `agents` 选项
- `agent.generate()`/`stream()` 是返回值模式，比 pi 的事件驱动更接近 `sendQuery()` 的 AsyncGenerator 契约
- v1.x 稳定性高于 pi 的 v0.x

**pi 作为第二优先级**：

- `streamFn` 函数注入设计极干净，`getLLMCalls` 拦截最容易
- 若未来需要轻量级 provider（不引入完整 agent 运行时，只用 pi-ai 的 `streamSimple` 做 LLM 后端），pi 的 `ApiProvider` 接口是最小侵入方案

### 7.3 两者共同缺口

- **都无 "cwd 工作目录" 语义**——octopus 的 `sendQuery(prompt, cwd)` 要求在指定目录执行 agent，两个框架都需自行实现 bash/文件工具并绑定 cwd
- **都无 "skills" 概念**——需将 octopus skills 内容注入为 systemPrompt 或 tools
- **`MessageChunk` 特有事件**——`ask_user_question` / `local_command_output` / `tool_summary` / `status(compacting)` 等 octopus 特有事件类型，两个框架都无直接对应，需在上层补充

---

## 八、关键源码索引

### Mastra

| 关注点 | 文件:行 |
|--------|---------|
| Agent 类 | `packages/core/src/agent/agent.ts:339` |
| AgentConfig 类型 | `packages/core/src/agent/types.ts:740` |
| generate / stream / network | `agent.ts:6923` / `agent.ts:7294` / `agent.ts:6733` |
| getLLM / getModel | `agent.ts:2377` / `agent.ts:2616` |
| MastraLanguageModel 定义 | `packages/core/src/llm/model/shared.types.ts` |
| MastraModelConfig | `shared.types.ts` |
| resolveModelConfig | `packages/core/src/llm/model/resolve-model.ts` |
| AISDK 包装层 | `packages/core/src/llm/model/aisdk/{v4,v5,v6}/model.ts` |
| ModelRouterLanguageModel | `packages/core/src/llm/model/router.ts:118` |
| Provider 注册表 | `packages/core/src/llm/model/provider-registry.ts` |
| MastraLLMVNext | `packages/core/src/llm/model/model.loop.ts:19` |
| core package.json | `packages/core/package.json` |

### pi

| 关注点 | 文件 |
|--------|------|
| LLM 接口 | `packages/ai/src/types.ts`（StreamFunction/Context/Message/Model/Tool） |
| ApiProvider 注册 | `packages/ai/src/api-registry.ts` |
| LLM 入口 | `packages/ai/src/stream.ts`（streamSimple/completeSimple） |
| 流类型 | `packages/ai/src/utils/event-stream.ts` |
| 内置注册 | `packages/ai/src/providers/register-builtins.ts` |
| Agent 类 | `packages/agent/src/agent.ts` |
| Agent 类型 | `packages/agent/src/types.ts`（StreamFn/AgentTool/AgentEvent） |
| 自定义 StreamFn 范例 | `packages/agent/src/proxy.ts`（streamProxy） |
| 自定义 provider 范例 | `packages/coding-agent/examples/extensions/custom-provider-anthropic/index.ts` |

### Octopus

| 关注点 | 文件:行 |
|--------|---------|
| IAgentProvider 接口 | `packages/providers/src/types.ts:59` |
| MessageChunk 类型 | `packages/providers/src/types.ts:39` |
| SendQueryOptions | `packages/providers/src/types.ts:28` |
| Provider 注册表 | `packages/providers/src/registry.ts` |
| ClaudeSDKProvider | `packages/providers/src/claude/provider.ts:118` |
| LLMCallTracker | `packages/providers/src/llm-call-tracker.ts` |
| 导出 | `packages/providers/src/index.ts` |
