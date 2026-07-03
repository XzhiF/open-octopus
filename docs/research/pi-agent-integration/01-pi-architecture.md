# 第一章：Pi Agent SDK 三层架构深度分析

> 源码路径：`C:\MiYuan\github\pi-mono`
> 版本：`0.80.3` | 许可证：MIT | 作者：Mario Zechner / Earendil Works
> 运行时要求：Node ≥ 22.19 | Schema 库：TypeBox v1.1.38

---

## 1.1 Monorepo 结构

```
pi-mono/
├── packages/
│   ├── ai/              ← @earendil-works/pi-ai        统一多提供商 LLM API
│   ├── agent/           ← @earendil-works/pi-agent-core Agent 运行时 + 循环 + 状态
│   ├── coding-agent/    ← @earendil-works/pi-coding-agent 编码 Agent CLI + Extension SDK
│   ├── orchestrator/    ← @earendil-works/pi-orchestrator 实验性多代理编排
│   └── tui/             ← @earendil-works/pi-tui        终端 UI 库（差分渲染）
├── package.json         ← npm workspaces（注意：不是 pnpm）
└── scripts/
```

**构建顺序**：`tui → ai → agent → coding-agent → orchestrator`

**依赖链**：
```
pi-coding-agent → pi-agent-core → pi-ai
pi-coding-agent → pi-tui
```

---

## 1.2 Layer 1：`@earendil-works/pi-ai` — 统一 LLM API

### 核心定位

隐藏所有 LLM 提供商的差异，提供统一的流式调用协议。类似于 LiteLLM 但 TypeScript 原生实现。

### 支持的提供商（40+）

```
amazon-bedrock, anthropic, azure-openai-responses, openai-codex,
google, google-vertex, openai, mistral, deepseek, xai, groq,
cerebras, openrouter, github-copilot, nvidia, fireworks, together,
huggingface, cloudflare-workers-ai, moonshotai, minimax, ...
```

### 关键类型

```typescript
// === 流式事件协议 ===
type AssistantMessageEvent =
  | { type: "start"; partial: AssistantMessage }
  | { type: "text_start" | "text_delta" | "text_end"; contentIndex: number; ... }
  | { type: "thinking_start" | "thinking_delta" | "thinking_end"; contentIndex: number; ... }
  | { type: "toolcall_start" | "toolcall_delta" | "toolcall_end"; contentIndex: number; ... }
  | { type: "done"; reason: "stop" | "length" | "toolUse"; message: AssistantMessage }
  | { type: "error"; reason: "aborted" | "error"; error: AssistantMessage };

// === 消息类型 ===
interface UserMessage { role: "user"; content: string | (TextContent | ImageContent)[]; timestamp: number; }
interface AssistantMessage {
  role: "assistant";
  content: (TextContent | ThinkingContent | ToolCall)[];
  api: Api; provider: ProviderId; model: string;
  usage: Usage;  // { input, output, cacheRead, cacheWrite, reasoning?, totalTokens, cost }
  stopReason: StopReason;  // "stop" | "length" | "toolUse" | "error" | "aborted"
}
interface ToolResultMessage<TDetails = any> {
  role: "toolResult"; toolCallId: string; toolName: string;
  content: (TextContent | ImageContent)[]; details?: TDetails; isError: boolean;
}

// === 模型描述 ===
interface Model<TApi extends Api> {
  id: string; name: string; api: TApi; provider: ProviderId; baseUrl: string;
  reasoning: boolean; contextWindow: number; maxTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; };
}
```

### EventStream — 推送式事件流

```typescript
class EventStream<T, R = T> implements AsyncIterable<T> {
  push(event: T): void;       // 生产者推送事件
  end(result?: R): void;      // 终止信号
  result(): Promise<R>;       // 获取最终结果
  async *[Symbol.asyncIterator](): AsyncIterator<T>;  // 消费者迭代
}

class AssistantMessageEventStream extends EventStream<AssistantMessageEvent, AssistantMessage> {}
```

**关键模式**：PUSH-based。提供商将事件推入 stream，消费者通过 `for await` 迭代。Stream 内部是带 waiter 通知的队列。

### 提供商注册系统

```typescript
interface Models {
  getProviders(): readonly Provider[];
  getModels(provider?: string): readonly Model<Api>[];
  streamSimple(model, context, options?): AssistantMessageEventStream;
  completeSimple(model, context, options?): Promise<AssistantMessage>;
}

// 创建实例
function createModels(options?: CreateModelsOptions): MutableModels;
```

### 流式选项

```typescript
interface SimpleStreamOptions extends StreamOptions {
  reasoning?: ThinkingLevel;     // "minimal" | "low" | "medium" | "high" | "xhigh"
  thinkingBudgets?: ThinkingBudgets;
}

interface StreamOptions {
  temperature?: number; maxTokens?: number; signal?: AbortSignal;
  apiKey?: string; transport?: "sse" | "websocket" | "auto";
  timeoutMs?: number; maxRetries?: number; env?: ProviderEnv;
}
```

### 架构启示

pi-ai 是一个纯粹的 LLM 协议层，不包含任何 agent 逻辑。它：
- 标准化了 40+ 提供商的 API 差异
- 提供了统一的流式事件协议
- 支持多种传输方式（SSE、WebSocket）
- 内置了重试、超时、诊断等基础设施

---

## 1.3 Layer 2：`@earendil-works/pi-agent-core` — Agent 运行时

### 核心定位

提供商无关的 Agent 循环引擎。不知道什么是"编码"——只知道消息、工具和循环。

### Agent 类

```typescript
class Agent {
  constructor(options: AgentOptions);
  
  // 状态
  get state(): AgentState;      // systemPrompt, model, tools, messages, isStreaming, ...
  get signal(): AbortSignal;
  
  // 生命周期
  subscribe(listener: (event: AgentEvent, signal: AbortSignal) => void): () => void;
  async prompt(input: string, images?: ImageContent[]): Promise<void>;
  async continue(): Promise<void>;      // 从现有 transcript 恢复
  abort(): void;
  async waitForIdle(): Promise<void>;
  reset(): void;
  
  // 消息队列（关键特性！）
  steer(message: AgentMessage): void;      // 在当前 turn 之间注入消息
  followUp(message: AgentMessage): void;   // 仅在 agent 将要停止时注入
  clearAllQueues(): void;
}
```

### AgentEvent — 完整生命周期事件

```typescript
type AgentEvent =
  // Agent 生命周期
  | { type: "agent_start" }
  | { type: "agent_end"; messages: AgentMessage[] }
  // Turn 生命周期
  | { type: "turn_start" }
  | { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }
  // 消息生命周期
  | { type: "message_start"; message: AgentMessage }
  | { type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
  | { type: "message_end"; message: AgentMessage }
  // 工具执行生命周期
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: any }
  | { type: "tool_execution_update"; toolCallId: string; toolName: string; args: any; partialResult: any }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: any; isError: boolean };
```

### Agent Loop 内部架构

```
outer while (true):                           // follow-up 队列排空
  inner while (hasToolCalls || pending):      // 工具/steering 循环
    inject pending messages (steering)
    streamAssistantResponse()                 // 1 次 LLM 调用
    if error/aborted → agent_end, return
    executeToolCalls()                        // sequential 或 parallel
    emit turn_end
    prepareNextTurn() → swap context/model/thinking
    shouldStopAfterTurn()? → agent_end
    poll steering queue
  poll follow-up queue → continue outer or break
emit agent_end
```

### 工具执行三阶段管道

```
prepareToolCall()          → 查找工具, prepareArguments, validate, beforeToolCall hook
executePreparedToolCall()  → tool.execute(id, args, signal, onUpdate)
finalizeExecutedToolCall() → afterToolCall hook (可覆盖 content/details/isError/terminate)
```

**关键设计**：
- 工具可通过 `terminate: true` 提前终止循环
- 并行模式下，只有所有工具都设置 `terminate: true` 时才终止
- `beforeToolCall` / `afterToolCall` 是异步钩子，支持拦截和覆盖

### AgentTool 定义

```typescript
interface AgentTool<TParameters extends TSchema = TSchema, TDetails = any> extends Tool<TParameters> {
  label: string;
  prepareArguments?: (args: unknown) => Static<TParameters>;
  execute(
    toolCallId: string, params: Static<TParameters>,
    signal?: AbortSignal, onUpdate?: AgentToolUpdateCallback<TDetails>
  ): Promise<AgentToolResult<TDetails>>;
  executionMode?: "sequential" | "parallel";
}

interface AgentToolResult<T> {
  content: (TextContent | ImageContent)[];
  details: T;
  terminate?: boolean;
}
```

### AgentLoopConfig — 循环配置

```typescript
interface AgentLoopConfig extends SimpleStreamOptions {
  model: Model<any>;
  convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
  transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
  getApiKey?: (provider: string) => Promise<string | undefined>;
  shouldStopAfterTurn?: (context: ShouldStopAfterTurnContext) => boolean;
  prepareNextTurn?: (context) => AgentLoopTurnUpdate | undefined;
  getSteeringMessages?: () => Promise<AgentMessage[]>;
  getFollowUpMessages?: () => Promise<AgentMessage[]>;
  beforeToolCall?: (context, signal?) => Promise<BeforeToolCallResult | undefined>;
  afterToolCall?: (context, signal?) => Promise<AfterToolCallResult | undefined>;
  toolExecution?: "sequential" | "parallel";
}
```

### 两个队列通道

| 队列 | 注入时机 | 用途 |
|------|----------|------|
| `steer()` | 当前 turn 之间（工具执行后） | 中途修正、上下文注入 |
| `followUp()` | Agent 将要停止时 | 后续指令、反馈循环 |

两者都支持 `QueueMode: "all" | "one-at-a-time"`。

### Harness 层（高级抽象）

`agent/src/harness/` 在 Agent 之上提供了更高层的运行时：
- `FileSystem` / `Shell` — 可插拔的执行环境抽象
- `Session` — JSONL 或内存中的会话持久化
- Compaction — 分支摘要压缩
- Skills / PromptTemplates — 技能和提示模板
- Hook 系统 — `before_provider_request` / `after_provider_response` 等

---

## 1.4 Layer 3：`@earendil-works/pi-coding-agent` — 编码 Agent

### 核心定位

完整的编码 Agent CLI + Extension SDK。提供开箱即用的工具、扩展系统和 Session 管理。

### createAgentSession() — 主入口

```typescript
interface CreateAgentSessionOptions {
  cwd?: string;                          // 工作目录
  agentDir?: string;                     // 全局配置目录（默认 ~/.pi/agent）
  authStorage?: AuthStorage;             // 凭据存储
  modelRegistry?: ModelRegistry;         // 模型注册表
  model?: Model<any>;                    // 使用的模型
  thinkingLevel?: ThinkingLevel;         // 推理级别
  noTools?: "all" | "builtin";           // 工具抑制
  tools?: string[];                      // 工具白名单
  excludeTools?: string[];               // 工具黑名单
  customTools?: ToolDefinition[];        // 额外工具
  sessionManager?: SessionManager;       // Session 持久化
  settingsManager?: SettingsManager;     // 设置管理
}

interface CreateAgentSessionResult {
  session: AgentSession;
  extensionsResult: LoadExtensionsResult;
  modelFallbackMessage?: string;
}
```

### AgentSession 类

```typescript
class AgentSession {
  readonly agent: Agent;
  readonly sessionManager: SessionManager;
  readonly modelRegistry: ModelRegistry;
  
  // 核心操作
  async prompt(text: string, options?: PromptOptions): Promise<void>;
  async abort(): Promise<void>;
  async setModel(model: Model<any>): Promise<void>;
  setThinkingLevel(level: ThinkingLevel): void;
  async compact(customInstructions?: string): Promise<CompactionResult>;
  
  // 事件订阅
  subscribe(listener: AgentSessionEventListener): () => void;
  
  // 工具管理
  getActiveToolNames(): string[];
  getAllTools(): ToolInfo[];
  setActiveToolsByName(toolNames: string[]): void;
  
  // Session 管理
  get sessionId(): string;
  get messages(): AgentMessage[];
  setSessionName(name: string): void;
  async navigateTree(targetId, options?): Promise<...>;
  
  dispose(): void;
}
```

### AgentSessionEvent — 会话级事件

```typescript
type AgentSessionEvent =
  | Exclude<AgentEvent, { type: "agent_end" }>
  | { type: "agent_end"; messages: AgentMessage[]; willRetry: boolean }
  | { type: "queue_update"; steering: readonly string[]; followUp: readonly string[] }
  | { type: "compaction_start"; reason: "manual" | "threshold" | "overflow" }
  | { type: "compaction_end"; result: CompactionResult | undefined; aborted: boolean }
  | { type: "entry_appended"; entry: SessionEntry }
  | { type: "session_info_changed"; name: string | undefined }
  | { type: "thinking_level_changed"; level: ThinkingLevel }
  | { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number }
  | { type: "auto_retry_end"; success: boolean; attempt: number };
```

### 内置工具（7 种）

| 工具 | 工厂函数 | 功能 |
|------|----------|------|
| `read` | `createReadTool(cwd)` | 读取文件内容 |
| `bash` | `createBashTool(cwd)` | 执行 shell 命令 |
| `edit` | `createEditTool(cwd)` | 精确字符串替换编辑 |
| `write` | `createWriteTool(cwd)` | 写入/创建文件 |
| `grep` | `createGrepTool(cwd)` | 内容搜索（ripgrep） |
| `find` | `createFindTool(cwd)` | 文件名模式搜索 |
| `ls` | `createLsTool(cwd)` | 列出目录内容 |

```typescript
// 便捷集合
createCodingTools(cwd)    // → [read, bash, edit, write]
createReadOnlyTools(cwd)  // → [read, grep, find, ls]
createAllTools(cwd)       // → Record<ToolName, Tool>
```

### Extension 系统

```typescript
// 扩展工厂函数
type ExtensionFactory = (pi: ExtensionAPI) => void | Promise<void>;

// 扩展 API（30+ 事件订阅 + 注册能力）
interface ExtensionAPI {
  // 事件订阅
  on(event: "session_start" | "agent_start" | "agent_end" | "turn_start" | "turn_end"
    | "message_start" | "message_update" | "message_end"
    | "tool_execution_start" | "tool_execution_update" | "tool_execution_end"
    | "tool_call" | "tool_result"              // 可拦截工具调用和结果
    | "context"                                 // 每次 LLM 调用前可修改消息
    | "before_provider_request" | "after_provider_response"
    | "before_agent_start" | "model_select" | "thinking_level_select"
    | "input" | "user_bash" | ..., handler): void;
  
  // 注册能力
  registerTool(tool: ToolDefinition): void;
  registerCommand(name, options): void;
  registerProvider(name, config: ProviderConfig): void;
  unregisterProvider(name): void;
  
  // 动作
  sendMessage(msg, options?): void;
  sendUserMessage(content, options?): void;
  setModel(model): Promise<boolean>;
  setActiveTools(toolNames): void;
}
```

### ToolDefinition — 扩展工具定义

```typescript
interface ToolDefinition<TParams extends TSchema = TSchema, TDetails = unknown> {
  name: string;
  label: string;
  description: string;
  parameters: TParams;              // TypeBox schema
  executionMode?: "sequential" | "parallel";
  execute(
    toolCallId: string, params: Static<TParams>,
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<TDetails> | undefined,
    ctx: ExtensionContext
  ): Promise<AgentToolResult<TDetails>>;
}

// 类型安全的工具创建辅助
function defineTool<TParams, TDetails>(tool: ToolDefinition<TParams, TDetails>): ToolDefinition<...>;
```

### ModelRegistry — 模型注册表

```typescript
class ModelRegistry {
  static create(authStorage: AuthStorage, modelsJsonPath?: string): ModelRegistry;
  static inMemory(authStorage: AuthStorage): ModelRegistry;
  
  getAll(): Model<Api>[];
  getAvailable(): Model<Api>[];    // 仅已配置认证的模型
  find(provider: string, modelId: string): Model<Api> | undefined;
  async getApiKeyAndHeaders(model: Model<Api>): Promise<ResolvedRequestAuth>;
  registerProvider(name: string, config: ProviderConfigInput): void;
  unregisterProvider(name: string): void;
}
```

### Session 管理

- **存储格式**：JSONL（每行一个 JSON 对象）
- **树形结构**：支持分支、fork、压缩
- **关键操作**：`appendMessage()`、`getBranch()`、`buildSessionContext()`

---

## 1.5 架构洞察总结

### 三层分离的设计哲学

```
┌──────────────────────────────────────────────────────┐
│  pi-coding-agent (应用层)                              │
│  • 工具（Bash/Read/Write/Edit/Grep/Find/Ls）          │
│  • Extension 系统（30+ 事件 + 注册 API）               │
│  • Session 管理（JSONL 持久化 + 树形分支）              │
│  • ModelRegistry（40+ 提供商认证管理）                  │
├──────────────────────────────────────────────────────┤
│  pi-agent-core (运行时层)                              │
│  • Agent 循环（stream → tool execute → repeat）        │
│  • 状态管理（AgentState）                              │
│  • 消息队列（steer + followUp）                        │
│  • 工具执行三阶段管道                                   │
│  • Harness（FileSystem/Shell/Session 抽象）             │
├──────────────────────────────────────────────────────┤
│  pi-ai (协议层)                                        │
│  • 统一流式协议（AssistantMessageEventStream）           │
│  • 40+ 提供商适配器                                    │
│  • 模型目录 + 成本计算                                  │
│  • 传输层（SSE/WebSocket）                              │
└──────────────────────────────────────────────────────┘
```

### 对 Octopus 集成的关键启示

1. **每层可独立使用** — 可以只用 pi-ai 做 LLM 调用，或用 pi-agent-core 做循环，或用完整的 pi-coding-agent
2. **推送式事件模型** — `EventStream` 是核心原语，既是生产者（push/end）又是异步迭代器
3. **声明合并扩展消息** — `CustomAgentMessages` 通过 TypeScript 声明合并添加领域特定消息类型
4. **工具执行是可拦截的** — before/after 钩子可以拦截、修改、覆盖工具调用和结果
5. **提供商注册是动态的** — 扩展可在运行时调用 `registerProvider()` 添加自定义模型和 API
