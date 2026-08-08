# Pi-Mono Harness 调研报告

## 项目概览

**Pi** 是一个开源的 AI 编码代理 (coding agent) 框架，由 Earendil Works 开发。
项目名 `pi-mono` 是其 TypeScript monorepo 的代码仓库名。

**技术栈**: TypeScript, Node.js >= 22, npm workspaces, Vitest, esbuild, Bun (可选运行时)

**核心架构** — 9 个包分层:

| 包 | 职责 |
|---|---|
| `@earendil-works/pi-ai` | 统一多 Provider LLM API (OpenAI, Anthropic, Google, Bedrock, Vertex…) |
| `@earendil-works/pi-agent-core` | Agent 运行时：tool calling、state 管理、**harness** |
| `@earendil-works/pi-coding-agent` | 交互式编码代理 CLI（工具实现、扩展系统、TUI 交互） |
| `@earendil-works/pi-tui` | 终端 UI 库 (differential rendering) |
| `pi-protocol` | 协议定义 |
| `pi-client` | 客户端 |
| `pi-server` | 服务端 |
| `pi-storage` | SQLite 存储 |
| `pi-evals` | 评估框架 |

**关键定位**: Pi 不是 workflow 编排引擎，而是一个**单 Agent 编码助手**。它的 "harness" 概念是**包裹 LLM Agent 的运行时外壳**，负责状态管理、事件系统、工具执行、会话持久化——这与 Octopus 的多执行器 workflow engine 有本质区别。但其中很多机制对 Octopus 的 harness 设计有直接参考价值。

---

## 1. Workflow 执行引擎

### 1.1 执行模型：Agent Loop（非 DAG Workflow）

Pi **没有** YAML 定义的 workflow/DAG 编排。它的执行模型是**单 Agent 循环**：

```
用户输入 → Agent Loop (LLM 调用 → 工具执行 → 结果回传 → 下一轮 LLM 调用) → Agent 结束
```

**核心循环** 在 `packages/agent/src/agent-loop.ts` 的 `runLoop()` 函数中实现：

- **双层循环结构**:
  - **内层循环**: 处理工具调用 + steering 消息（用户在 Agent 运行时插入的消息）
  - **外层循环**: 处理 follow-up 消息（Agent 停止后的后续消息）

- **Turn 生命周期**:
  ```
  turn_start → message_start (用户消息) → message_end →
  streamAssistantResponse (LLM 流式响应) →
  tool_execution_start → tool_execution_end (每个工具) →
  turn_end → prepareNextTurn → (循环或 agent_end)
  ```

### 1.2 "节点类型"（工具类型）

Pi 的 "节点" 就是**工具 (Tools)**。内置工具在 `packages/coding-agent/src/core/tools/` 中：

| 工具 | 功能 |
|------|------|
| `bash` | Shell 命令执行（带超时、输出截断、流式更新） |
| `read` | 读取文件（支持图片、行范围、编码检测） |
| `write` | 写入文件（自动创建父目录） |
| `edit` | 精确编辑（字符串替换，带 diff 验证） |
| `edit_diff` | 基于 diff 的编辑 |
| `grep` | 内容搜索 |
| `find` | 文件模式匹配 |
| `ls` | 目录列表 |
| `image` | 图片处理 |

**工具执行模式** — 两种:
- `sequential`: 工具逐个执行（默认，或工具自行声明）
- `parallel`: 工具并发执行（prepare 阶段串行，execute 阶段并发）

**源码**: `packages/agent/src/agent-loop.ts` 第 489-554 行

### 1.3 编排方式

没有 DAG/Chain/Swarm 编排。Pi 的 "编排" 是通过:
1. **Agent Loop** 自身的循环控制
2. **Steering Queue**: 用户在 Agent 运行时注入消息
3. **Follow-up Queue**: Agent 停止后的后续消息
4. **Next-turn Queue**: 下一轮预设消息
5. **QueueMode**: `"all"` (全部注入) 或 `"one-at-a-time"` (逐个注入)

**源码**: `packages/agent/src/agent-loop.ts` 第 155-275 行

---

## 2. 运行时监控

### 2.1 事件系统（核心亮点 ⭐）

Pi 有**非常完善的类型安全事件系统**，这是最值得 Octopus 借鉴的部分。

**Harness 层事件** (`packages/agent/src/harness/types.ts`):

定义了 20+ 种事件类型，每种都有强类型的事件载荷和返回值：

```typescript
// 事件类型（部分）
type AgentHarnessEvent =
  | QueueUpdateEvent       // 队列更新
  | SavePointEvent         // 保存点
  | AbortEvent             // 中止
  | SettledEvent           // 稳定（所有操作完成）
  | BeforeAgentStartEvent  // Agent 启动前（可注入消息/修改 system prompt）
  | ContextEvent           // 上下文构建（可修改消息列表）
  | BeforeProviderRequestEvent  // Provider 请求前（可修改请求选项）
  | BeforeProviderPayloadEvent  // 载荷发送前（可修改 payload）
  | AfterProviderResponseEvent  // Provider 响应后
  | ToolCallEvent          // 工具调用前（可阻止执行）
  | ToolResultEvent      // 工具结果后（可修改结果）
  | SessionBeforeCompactEvent   // 压缩前（可取消）
  | SessionCompactEvent    // 压缩完成
  | RetryScheduledEvent    // 重试计划
  | RetryAttemptStartEvent // 重试开始
  | RetryFinishedEvent     // 重试结束
  | ModelUpdateEvent       // 模型切换
  | ToolsUpdateEvent       // 工具列表更新
  ...
```

**事件钩子的返回值设计** — 这是关键设计模式:

```typescript
// 每种事件都有对应的 Result 类型
type AgentHarnessEventResultMap = {
  before_agent_start: BeforeAgentStartResult | undefined;  // 可注入消息
  tool_call: ToolCallResult | undefined;                   // 可阻止执行
  tool_result: ToolResultPatch | undefined;                // 可修改结果
  session_before_compact: SessionBeforeCompactResult;      // 可取消压缩
  ...
};
```

**源码**: `packages/agent/src/harness/types.ts` 第 591-848 行

### 2.2 事件分发机制

```typescript
class AgentHarness {
  // 通配订阅（收到所有事件）
  subscribe(listener: (event, signal?) => void): () => void;

  // 按类型订阅（可返回结果影响行为）
  on<TType>(type: TType, handler: (event) => Result): () => void;

  // 内部分发
  private async emitHook<TType>(event): Promise<Result>;  // 可返回结果
  private async emitAny(event): Promise<void>;             // 仅通知
  private async emitOwn(event): Promise<void>;             // Harness 自身事件
}
```

**源码**: `packages/agent/src/harness/agent-harness.ts` 第 237-274 行

### 2.3 状态追踪

**Phase 状态机**:
```typescript
type AgentHarnessPhase = "idle" | "turn" | "compaction" | "branch_summary" | "retry";
```

每次操作前都检查 phase，防止并发冲突：
```typescript
async prompt(text: string) {
  if (this.phase !== "idle") throw new AgentHarnessError("busy", "...");
  this.phase = "turn";
  // ...
}
```

**Session 统计**:
```typescript
interface SessionStats {
  messageCount: number;
  cachedTokens: number;
  uncachedTokens: number;
  totalTokens: number;
  costTotal: number;
}
```

**源码**: `packages/agent/src/harness/agent-harness.ts` 第 583 行; `packages/agent/src/harness/types.ts` 第 474-479 行

### 2.4 任务追踪

```typescript
class AgentHarness {
  private readonly activeTasks = new Map<Promise<void>, TrackedTaskKind>();

  private async track<T>(kind: "operation" | "mutation", operation: () => Promise<T>): Promise<T>;
  private async waitForTasks(kind?: TrackedTaskKind): Promise<void>;
}
```

区分 `operation`（长时间操作如 turn）和 `mutation`（状态修改如 setModel），shutdown 时等待所有 active tasks 完成。

**源码**: `packages/agent/src/harness/agent-harness.ts` 第 357-379 行

### 2.5 Extension 层事件总线

coding-agent 层有自己的事件总线 (`packages/coding-agent/src/core/event-bus.ts`)，基于 Node.js EventEmitter，安全包装每个 handler:

```typescript
function createEventBus(): EventBusController {
  const emitter = new EventEmitter();
  return {
    on: (channel, handler) => {
      const safeHandler = async (data) => {
        try { await handler(data); }
        catch (err) { console.error(`Event handler error (${channel}):`, err); }
      };
      emitter.on(channel, safeHandler);
      return () => emitter.off(channel, safeHandler);
    },
  };
}
```

**源码**: `packages/coding-agent/src/core/event-bus.ts`

---

## 3. 约束与保护机制

### 3.1 超时控制

**命令级超时** (`packages/agent/src/harness/tools/bash.ts`):
```typescript
// Bash 工具支持 timeout 参数（秒）
const bashSchema = Type.Object({
  command: Type.String(),
  timeout: Type.Optional(Type.Number()),  // 可选，无默认值
});

// 最大值保护
const MAX_TIMEOUT_SECONDS = 2_147_483_647 / 1000;  // ~24.8 天
```

**Provider 请求超时** (`packages/agent/src/harness/types.ts`):
```typescript
interface AgentHarnessStreamOptions {
  timeoutMs?: number;       // Provider 请求超时
  maxRetries?: number;      // 最大重试次数
  maxRetryDelayMs?: number; // 重试延迟上限
}
```

**可配置超时** (`packages/coding-agent/src/core/settings-manager.ts`):
```typescript
interface ProviderRetrySettings {
  timeoutMs?: number;       // SDK/provider 请求超时
  maxRetries?: number;      // SDK/provider 重试次数
  maxRetryDelayMs?: number; // 默认 60000ms
}
```

**源码**: `packages/agent/src/harness/tools/bash.ts`; `packages/coding-agent/src/core/settings-manager.ts` 第 22-34 行

### 3.2 进程隔离

Pi **自身不包含内置沙箱**。README 明确说明：

> "Pi does not include a built-in permission system for restricting filesystem, process, network, or credential access."

但提供了 **3 种外部隔离方案**（通过扩展系统实现）:

| 方案 | 隔离方式 | 隔离范围 |
|------|----------|----------|
| **Gondolin 扩展** | 本地 Linux micro-VM (QEMU) | 工具执行路由到 VM，Auth 留在宿主 |
| **Plain Docker** | Docker 容器 | 整个 pi 进程在容器中 |
| **OpenShell** | NVIDIA OpenShell 策略沙箱 | 文件/进程/网络/凭证/推理 全控制 |

**源码**: `packages/coding-agent/docs/containerization.md`

### 3.3 资源限制

**输出截断** (`packages/agent/src/harness/utils/truncate.ts`):
- `DEFAULT_MAX_LINES`: 行数限制
- `DEFAULT_MAX_BYTES`: 字节限制（约 100KB）
- 超出限制时，完整输出保存为临时文件，截断后的输出包含文件路径引用

**文件操作队列** (`packages/coding-agent/src/core/tools/file-mutation-queue.ts`):
```typescript
// 同一文件的写操作串行化，不同文件可并行
export async function withFileMutationQueue<T>(filePath: string, fn: () => Promise<T>): Promise<T>;
```

**源码**: `packages/coding-agent/src/core/tools/file-mutation-queue.ts`; `packages/agent/src/harness/utils/truncate.ts`

---

## 4. 错误处理与恢复

### 4.1 错误分类体系（核心亮点 ⭐）

Pi 定义了**完整的结构化错误类型**，每种都有 error code：

```typescript
// 文件系统错误
type FileErrorCode = "aborted" | "not_found" | "permission_denied"
  | "not_directory" | "is_directory" | "invalid" | "not_supported" | "unknown";

// 执行环境错误
type ExecutionErrorCode = "aborted" | "timeout" | "shell_unavailable"
  | "spawn_error" | "callback_error" | "unknown";

// 压缩错误
type CompactionErrorCode = "aborted" | "summarization_failed"
  | "invalid_session" | "unknown";

// Session 错误
type SessionErrorCode = "not_found" | "invalid_session" | "invalid_entry"
  | "invalid_fork_target" | "storage" | "unknown";

// Harness 顶层错误
type AgentHarnessErrorCode = "busy" | "invalid_state" | "invalid_argument"
  | "session" | "hook" | "auth" | "compaction" | "branch_summary" | "unknown";
```

所有错误都用 `Result<TValue, TError>` 模式（不抛异常）:
```typescript
type Result<TValue, TError> = { ok: true; value: TValue } | { ok: false; error: TError };
```

**源码**: `packages/agent/src/harness/types.ts` 第 24-266 行

### 4.2 重试策略（核心亮点 ⭐）

**两层重试机制**:

**层 1: Provider 级重试** (`packages/ai/src/utils/provider-retry.ts`):
- 模仿 OpenAI/Anthropic SDK 的重试行为，但使 sleep 可中断
- 支持 `x-should-retry` header
- 尊重 `retry-after` / `retry-after-ms` headers
- 指数退避 + 随机抖动: `0.5 * 2^retryIndex * (1 - random * 0.25)` 秒
- 服务端要求的重试延迟有上限保护（默认 60s，超出则立即失败）

```typescript
async function retryProviderRequest<T>(
  request: () => Promise<T>,
  options: { maxRetries?: number; maxRetryDelayMs?: number; signal?: AbortSignal },
): Promise<T>;
```

**层 2: Assistant 级重试** (`packages/ai/src/utils/retry.ts`):
- 有**智能错误分类**，区分可重试 vs 不可重试的错误
- **不可重试**的模式: `GoUsageLimitError`, `FreeUsageLimitError`, `insufficient_quota`, `out of budget`, `quota exceeded`, `billing`
- **可重试**的模式: `overloaded`, `rate limit`, `429`, `500-504`, `524`, `network error`, `timeout`, `stream ended without`, `ResourceExhausted` 等

```typescript
interface RetryPolicy {
  enabled: boolean;
  maxRetries: number;     // 最大重试次数
  baseDelayMs: number;    // 基础延迟（指数退避: baseDelayMs * 2^(attempt-1)）
}

async function retryAssistantCall(
  produce: () => Promise<AssistantMessage>,
  policy: RetryPolicy | undefined,
  signal: AbortSignal | undefined,
  callbacks?: RetryCallbacks,  // onRetryScheduled, onRetryAttemptStart, onRetryFinished
): Promise<AssistantMessage>;
```

**回调机制**:
```typescript
interface RetryCallbacks {
  onRetryScheduled?: (attempt, maxAttempts, delayMs, errorMessage) => void;
  onRetryAttemptStart?: () => void;
  onRetryFinished?: (success: boolean, attempt: number, finalError?: string) => void;
}
```

**源码**: `packages/ai/src/utils/retry.ts`; `packages/ai/src/utils/provider-retry.ts`

### 4.3 截断消息保护

当 LLM 输出达到 token 上限被截断时，**所有工具调用都被标记为失败**而不是执行可能不完整的参数:

```typescript
async function failToolCallsFromTruncatedMessage(toolCalls, emit) {
  for (const toolCall of toolCalls) {
    // 返回错误结果，要求模型重新发起完整的工具调用
    result: createErrorToolResult(
      `Tool call "${toolCall.name}" was not executed: the response hit the output token limit,
       so its arguments may be truncated. Re-issue the tool call with complete arguments.`
    ),
  }
}
```

**源码**: `packages/agent/src/agent-loop.ts` 第 381-406 行

### 4.4 Context Overflow 恢复（核心亮点 ⭐）

Agent Session 层有**自动上下文压缩恢复**:

```typescript
// Case 1: 上下文溢出（provider 报错或 stopReason="length"）
if (isContextOverflow(assistantMessage, contextWindow) || recoverableLength) {
  const willRetry = assistantMessage.stopReason !== "stop";

  // 已尝试过一次则不再重试
  if (this._overflowRecoveryAttempted) {
    // 报错，建议切换更大上下文的模型
    return false;
  }

  this._overflowRecoveryAttempted = true;
  // 移除失败的 assistant 消息
  this.agent.state.messages = messages.slice(0, -1);
  // 触发自动压缩 + 重试
  return await this._runAutoCompaction("overflow", willRetry);
}

// Case 2: 阈值触发（上下文快满了）
if (shouldCompact(contextTokens, contextWindow, settings)) {
  return await this._runAutoCompaction("threshold", false);
}
```

**源码**: `packages/coding-agent/src/core/agent-session.ts` 第 1976-2041 行

### 4.5 失败消息注入

当 Agent 运行失败时，Harness 会构造一个**合成失败消息**注入到会话中，确保 LLM 能感知到错误:

```typescript
function createFailureMessage(model, error, aborted): AssistantMessage {
  return {
    role: "assistant",
    stopReason: aborted ? "aborted" : "error",
    errorMessage: error instanceof Error ? error.message : String(error),
    usage: { input: 0, output: 0, ... total: 0 },
  };
}
```

**源码**: `packages/agent/src/harness/agent-harness.ts` 第 55-73 行

### 4.6 Checkpoint / 断点续跑

**未实现** 传统意义上的 checkpoint。但 Pi 有类似机制:

- **JSONL Session 持久化**: 所有消息、工具调用结果都实时写入 JSONL 文件
- **Save Points**: `turn_end` 事件后自动 flush 待写入的 session entries，发出 `save_point` 事件
- **Session Fork/Tree**: 支持从任意 entry 分叉，创建新的 session 分支
- **Compaction Entry**: 压缩后的 summary 作为新的起点，保留最近的 retained tail

**源码**: `packages/agent/src/harness/session/jsonl-repo.ts`; `packages/agent/src/harness/agent-harness.ts` 第 554-608 行

---

## 5. 验证机制

### 5.1 执行前校验

**工具参数验证**:
```typescript
// 1. Schema 验证 (TypeBox)
const validatedArgs = validateToolArguments(tool, preparedToolCall);

// 2. beforeToolCall 钩子（可阻止执行）
const beforeResult = await config.beforeToolCall({ assistantMessage, toolCall, args, context });
if (beforeResult?.block) {
  return { kind: "immediate", result: createErrorToolResult(beforeResult.reason || "blocked"), isError: true };
}

// 3. prepareArguments 钩子（参数预处理）
if (tool.prepareArguments) {
  const preparedArguments = tool.prepareArguments(toolCall.arguments);
}
```

**Harness 状态验证**:
```typescript
// 每次操作前检查
private assertNotShutDown(): void {
  if (this.isShutdown) throw new AgentHarnessError("invalid_state", "AgentHarness has been shut down");
}

// Phase 检查
if (this.phase !== "idle") throw new AgentHarnessError("busy", "AgentHarness is busy");

// 工具名唯一性验证
private validateUniqueNames(names: string[], message: string): void;
private validateToolNames(toolNames: string[]): void;
```

**源码**: `packages/agent/src/agent-loop.ts` 第 600-664 行; `packages/agent/src/harness/agent-harness.ts` 第 229-552 行

### 5.2 执行中校验

**afterToolCall 钩子** — 可修改工具结果:
```typescript
interface AfterToolCallResult {
  content?: (TextContent | ImageContent)[];  // 替换结果内容
  details?: unknown;                          // 替换详情
  isError?: boolean;                          // 修改错误标志
  usage?: Usage;                              // 替换用量
  terminate?: boolean;                        // 提前终止
}
```

**Extension 层校验**:
- `tool_call` 事件: 扩展可以阻止工具执行或修改参数
- `tool_result` 事件: 扩展可以修改工具结果
- `message_end` 事件: 扩展可以替换消息（必须保持 role 不变）
- `context` 事件: 扩展可以修改发送给 LLM 的消息列表

**源码**: `packages/coding-agent/src/core/extensions/runner.ts` 第 877-930 行

### 5.3 执行后校验

**Session 一致性**:
- `navigateTree` 前验证目标 entry 存在
- Fork 前验证 fork target 合法性
- Compaction 前检查是否有内容可压缩

**源码**: `packages/agent/src/harness/agent-harness.ts` 第 842-940 行

---

## 6. 安全沙箱

### 6.1 Pi 自身不包含内置权限系统

README 明确:
> "Pi does not include a built-in permission system for restricting filesystem, process, network, or credential access. By default, it runs with the permissions of the user and process that launched it."

### 6.2 扩展实现的安全沙箱

**Sandbox 扩展** (`packages/coding-agent/examples/extensions/sandbox/index.ts`):

使用 `@anthropic-ai/sandbox-runtime` 实现 OS 级沙箱:

```typescript
// 配置驱动的安全策略
interface SandboxConfig {
  enabled?: boolean;
  network: {
    allowedDomains: string[];   // 白名单域名
    deniedDomains: string[];    // 黑名单域名
  };
  filesystem: {
    denyRead: string[];         // 禁止读取的路径 (~/.ssh, ~/.aws)
    allowWrite: string[];       // 允许写入的路径 (., /tmp)
    denyWrite: string[];        // 禁止写入的路径 (.env, *.pem)
  };
}

// 默认安全配置
const DEFAULT_CONFIG: SandboxConfig = {
  enabled: true,
  network: {
    allowedDomains: ["npmjs.org", "*.npmjs.org", "github.com", ...],
    deniedDomains: [],
  },
  filesystem: {
    denyRead: ["~/.ssh", "~/.aws", "~/.gnupg"],
    allowWrite: [".", "/tmp"],
    denyWrite: [".env", ".env.*", "*.pem", "*.key"],
  },
};
```

**实现方式**: 用 `SandboxManager.wrapWithSandbox(command)` 包装 bash 命令，底层使用:
- macOS: `sandbox-exec`
- Linux: `bubblewrap`

**进程隔离**: 使用 `detached: true` 的 `child_process.spawn`，abort 时通过 `process.kill(-child.pid, "SIGKILL")` 杀掉整个进程组。

**源码**: `packages/coding-agent/examples/extensions/sandbox/index.ts`

### 6.3 项目信任系统

**Project Trust Store** (`packages/coding-agent/src/core/trust-manager.ts`):

在加载项目级资源（settings.json、extensions、skills、SYSTEM.md 等）前，要求用户确认项目信任:

```typescript
// 需要信任的资源
const TRUST_REQUIRING_PROJECT_CONFIG_RESOURCES = [
  "settings.json", "extensions", "skills", "prompts",
  "themes", "SYSTEM.md", "APPEND_SYSTEM.md",
];

// 信任决策
type ProjectTrustDecision = boolean | null;  // true=信任, false=不信任, null=未决定

// 支持目录层级继承
function findNearestTrustEntry(data: TrustFile, cwd: string): ProjectTrustStoreEntry | null {
  // 从 cwd 向上遍历，找到最近的 trust entry
}
```

**信任选项**:
- Trust (永久)
- Trust parent folder (信任父目录)
- Trust (this session only)
- Do not trust

**源码**: `packages/coding-agent/src/core/trust-manager.ts`

### 6.4 Gondolin 微 VM 隔离

Gondolin 扩展提供最精细的隔离:
- Pi 主进程在宿主运行（保留 API key 等凭证）
- 所有工具执行路由到 Linux micro-VM
- 宿主 cwd 挂载到 VM 的 `/workspace`
- 文件修改会写穿到宿主，但 VM 内其他文件系统操作被隔离

**源码**: `packages/coding-agent/examples/extensions/gondolin/index.ts`

---

## 7. 可借鉴的设计模式

### 7.1 事件驱动 + 钩子返回值（⭐⭐⭐ 强烈推荐）

**Pi 的模式**: 每种事件都有强类型载荷 + 可选返回值，钩子的返回值可以直接影响执行流程。

**对 Octopus 的启发**:
```typescript
// 为 WorkflowEngine 设计类似的事件钩子
interface WorkflowHooks {
  beforeNodeExecute(node, context): { skip?: boolean; overrideInput?: any };
  afterNodeExecute(node, result): { overrideResult?: any; retry?: boolean };
  beforeWorkflowStart(workflow): { cancel?: boolean; modifiedInput?: any };
  onNodeError(node, error): { retry?: boolean; fallback?: any; escalate?: boolean };
}
```

### 7.2 结构化错误 + Result 模式（⭐⭐⭐ 强烈推荐）

**Pi 的模式**: 所有操作返回 `Result<T, E>`，错误有稳定的 error code 枚举。

**对 Octopus 的启发**:
- 为每种执行器定义 `ExecutorErrorCode` 枚举
- 用 `Result` 替代 try/catch，让错误处理更显式
- 错误分类驱动重试策略（区分"可重试"和"不可重试"）

### 7.3 智能重试分类（⭐⭐⭐ 强烈推荐）

**Pi 的模式**: 通过正则匹配错误消息，区分 transient 错误（网络、500、429）和 deterministic 错误（配额不足、参数错误）。

**对 Octopus 的启发**:
- 为节点执行错误建立分类器
- 只对 transient 错误重试，deterministic 错误立即失败
- 重试时不要重复同样的方法（如换一个工具、换一个策略）

### 7.4 Phase 状态机 + Busy Guard（⭐⭐ 推荐）

**Pi 的模式**: `AgentHarnessPhase` 防止并发操作冲突。

**对 Octopus 的启发**:
- Workflow Engine 也需要 phase 状态机
- 防止在 compaction/retry 期间接受新的操作

### 7.5 截断消息保护（⭐⭐ 推荐）

**Pi 的模式**: 输出被截断时，不执行可能不完整的工具调用，而是返回错误让 LLM 重试。

**对 Octopus 的启发**:
- Agent 节点的输出如果被截断，应该标记为错误而非继续执行
- 下游节点应该验证上游输出的完整性

### 7.6 Context Overflow 自动恢复（⭐⭐ 推荐）

**Pi 的模式**: 检测到上下文溢出时，自动触发压缩 + 重试，且限制只尝试一次。

**对 Octopus 的启发**:
- 为 Agent 节点添加 context 管理
- 自动压缩/摘要后重试
- 限制恢复尝试次数，避免无限循环

### 7.7 文件操作串行化（⭐⭐ 推荐）

**Pi 的模式**: 同一文件的写操作串行化，不同文件可并行。

**对 Octopus 的启发**:
- 并行执行器操作同一资源时需要队列化
- 资源锁 + 操作队列

### 7.8 扩展系统作为安全层（⭐⭐ 推荐）

**Pi 的模式**: 安全策略通过扩展实现，不硬编码到核心。

**对 Octopus 的启发**:
- Guardrails 可以做成 plugin/middleware
- 不同项目可以配置不同的安全策略
- 核心引擎保持简洁

### 7.9 Tool Execution 的 before/after 拦截链（⭐⭐ 推荐）

**Pi 的模式**: `beforeToolCall` 可以阻止执行，`afterToolCall` 可以修改结果。多个 handler 链式执行。

**对 Octopus 的启发**:
- 节点执行的 before/after 拦截器
- 用于审计、验证、注入额外上下文

### 7.10 不内置沙箱，提供隔离接口（⭐ 可参考）

**Pi 的模式**: 定义 `ExecutionEnv` 和 `BashOperations` 接口，沙箱通过实现这些接口来替换默认行为。

**对 Octopus 的启发**:
- 定义执行环境接口（FileSystem, Shell）
- 允许不同的 sandbox 实现（Docker, VM, nsjail）通过接口注入

---

## 源码引用

### 核心 Harness 层
| 文件 | 内容 |
|------|------|
| `packages/agent/src/harness/agent-harness.ts` | AgentHarness 主类：状态管理、事件分发、turn 编排 |
| `packages/agent/src/harness/types.ts` | 所有类型定义：事件、错误码、FileSystem、Shell、Session |
| `packages/agent/src/harness/tools/bash.ts` | Bash 工具实现（超时、截断、流式更新） |
| `packages/agent/src/harness/tools/edit.ts` | 文件编辑工具 |
| `packages/agent/src/harness/tools/tool-context.ts` | 工具上下文接口 |
| `packages/agent/src/harness/utils/truncate.ts` | 输出截断工具 |
| `packages/agent/src/harness/utils/shell-output.ts` | Shell 输出捕获 |
| `packages/agent/src/harness/compaction/compaction.ts` | 上下文压缩 |
| `packages/agent/src/harness/session/session.ts` | Session 构建（context 重建） |
| `packages/agent/src/harness/session/jsonl-repo.ts` | JSONL 持久化 |

### Agent Loop 层
| 文件 | 内容 |
|------|------|
| `packages/agent/src/agent-loop.ts` | Agent 循环核心（双层循环、工具执行、消息流） |
| `packages/agent/src/types.ts` | AgentLoopConfig、BeforeToolCall、AfterToolCall |

### AI/Provider 层
| 文件 | 内容 |
|------|------|
| `packages/ai/src/utils/retry.ts` | Assistant 级重试（智能错误分类 + 指数退避） |
| `packages/ai/src/utils/provider-retry.ts` | Provider 级重试（SDK 兼容 + 可中断 sleep） |

### Coding Agent 层
| 文件 | 内容 |
|------|------|
| `packages/coding-agent/src/core/agent-session.ts` | AgentSession（auto-compaction、overflow recovery） |
| `packages/coding-agent/src/core/agent-session-runtime.ts` | 运行时创建/替换 |
| `packages/coding-agent/src/core/bash-executor.ts` | Bash 执行器（流式输出、取消） |
| `packages/coding-agent/src/core/event-bus.ts` | 事件总线 |
| `packages/coding-agent/src/core/trust-manager.ts` | 项目信任管理 |
| `packages/coding-agent/src/core/settings-manager.ts` | 配置管理（超时、重试、压缩） |
| `packages/coding-agent/src/core/output-guard.ts` | stdout 保护 |
| `packages/coding-agent/src/core/diagnostics.ts` | 诊断信息类型 |
| `packages/coding-agent/src/core/tools/file-mutation-queue.ts` | 文件操作串行化 |
| `packages/coding-agent/src/core/extensions/runner.ts` | 扩展运行器（事件分发、工具注册） |
| `packages/coding-agent/src/core/extensions/types.ts` | 扩展系统完整类型定义（30+ 事件类型） |

### 安全/沙箱
| 文件 | 内容 |
|------|------|
| `packages/coding-agent/examples/extensions/sandbox/index.ts` | OS 级沙箱扩展（网络/文件系统策略） |
| `packages/coding-agent/examples/extensions/gondolin/index.ts` | micro-VM 隔离扩展（工具路由） |
| `packages/coding-agent/docs/containerization.md` | 容器化文档 |
