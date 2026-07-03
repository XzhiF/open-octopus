# 第二章：Octopus 当前 Provider 体系分析

> 源码路径：`c:\xzf\ai\open-octopus`
> 版本：`1.0.0`

---

## 2.1 IAgentProvider 接口

**文件**：`packages/providers/src/types.ts`

```typescript
export interface IAgentProvider {
  sendQuery(
    prompt: string,
    cwd: string,
    resumeSessionId?: string,
    options?: SendQueryOptions
  ): AsyncGenerator<MessageChunk>
  getType(): string
  getLLMCalls?(): LLMCallRecord[]
}
```

### 关键特征

这**不是**纯 LLM 后端接口，而是**完整 Agent 运行时抽象**：

- `sendQuery` 接收 prompt + 工作目录 + 会话 ID + 选项
- 返回 `AsyncGenerator<MessageChunk>` — 丰富的流式事件联合类型
- 现有实现 `ClaudeSDKProvider` 包装 Claude Agent SDK（本身就是完整 agent）
- Provider 需要内部运行完整的 agent loop（LLM 调用 + 工具执行 + 多轮对话）

### SendQueryOptions

```typescript
export interface SendQueryOptions {
  model?: string                           // 模型名称（如 "claude-sonnet-4-20250514"）
  systemPrompt?: SystemPromptInput         // string | { type:'preset', preset:'claude_code', append? }
  abortSignal?: AbortSignal                // 取消信号
  maxBudgetUsd?: number                    // 预算上限
  env?: Record<string, string>             // 环境变量
  agent?: string                           // Agent 角色标识
  skills?: string[]                        // 技能列表
  agents?: Record<string, AgentDefinition> // 子代理定义
  plugins?: Array<{ type: 'local'; path: string }>  // 额外 plugins
  disablePlugins?: string[]                // 禁用 plugins
}
```

**⚠️ 注意**：`agents` 字段使用了 Claude Agent SDK 的 `AgentDefinition` 类型。Pi 集成时需要适配这个类型或定义通用替代。

### TokenUsage & ModelUsageEntry

```typescript
export interface TokenUsage {
  input: number
  output: number
  total?: number
}

export interface ModelUsageEntry {
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens?: number
  cacheCreationInputTokens?: number
  costUsd?: number
}
```

---

## 2.2 MessageChunk 事件类型（18 种）

```typescript
export type MessageChunk =
  // 消息生命周期
  | { type: 'message_start'; messageId: string; inputTokens?: number }
  | { type: 'message_delta'; stopReason: string; outputTokens?: number; messageId: string }
  | { type: 'message_stop'; messageId: string }
  
  // 文本内容
  | { type: 'text_delta'; content: string; messageId: string }
  | { type: 'text_done'; messageId: string }
  
  // 思考/推理
  | { type: 'thinking_start'; messageId: string }
  | { type: 'thinking'; content: string; messageId: string }
  | { type: 'thinking_done'; messageId: string; thinkingDuration?: string }
  
  // 工具调用
  | { type: 'tool_call_start'; toolCallId: string; toolName: string; messageId: string }
  | { type: 'tool_call'; toolCallId: string; toolName: string; toolInput: unknown; messageId: string }
  | { type: 'tool_progress'; toolCallId: string; elapsedSeconds: number }
  | { type: 'tool_result'; toolCallId: string; content: string; isError?: boolean; toolDuration?: string }
  | { type: 'tool_summary'; summary: string; toolCallIds: string[] }
  
  // 用户交互
  | { type: 'ask_user_question'; toolCallId: string; questions: unknown }
  | { type: 'local_command_output'; content: string }
  
  // 系统状态
  | { type: 'status'; status: 'compacting' | 'requesting' | null }
  
  // 结果
  | { type: 'result'; content?: string; sessionId?: string; tokens?: TokenUsage;
      costUsd?: number; modelUsages?: ModelUsageEntry[] }
  | { type: 'error'; code: string; message: string }
```

### 事件生命周期

```
message_start → [thinking_start → thinking* → thinking_done] →
  [text_delta* → text_done] → [tool_call_start → tool_call → tool_progress* → tool_result]* →
  message_delta → message_stop → result
```

---

## 2.3 现有实现：ClaudeSDKProvider

**文件**：`packages/providers/src/claude/provider.ts`

### 工作原理

1. **调用 Claude Agent SDK** — `query({ prompt, options })` 生成流式事件
2. **事件转换** — SDK 的 `SDKStreamEvent` → Octopus 的 `MessageChunk`
3. **工具结果拦截** — 通过 SDK hooks（`PreToolUse`、`PostToolUse`）捕获工具结果，放入 `toolResultQueue`
4. **用户提问拦截** — 拦截 `AskUserQuestion` 工具调用，转为 `ask_user_question` chunk
5. **Token 追踪** — 流式阶段记录元数据，结果阶段用 `result.modelUsage` 校准

### 关键实现细节

```typescript
async *sendQuery(prompt, cwd, resumeSessionId?, options?) {
  // 1. 构建 SDK 选项
  const sdkOptions: Options = {
    model: options?.model,
    cwd,
    permissionMode: 'bypassPermissions',
    // ... systemPrompt, plugins, abortController
  }
  
  // 2. 启动 SDK 流
  const stream = query({ prompt, options: sdkOptions })
  
  // 3. 迭代 SDK 事件，转换为 MessageChunk
  for await (const event of stream) {
    // 转换逻辑...
    yield chunk
  }
  
  // 4. 最终结果
  yield { type: 'result', content: finalText, sessionId, tokens, modelUsages }
}
```

### ClaudeSDKProvider 的局限

- **仅支持 Anthropic** — 绑定 Claude Agent SDK，无法使用其他 LLM
- **黑盒工具执行** — 工具由 SDK 内部管理，Octopus 无法自定义
- **无扩展系统** — 无法在 agent 循环中注入自定义行为
- **Session 管理依赖 SDK** — Session ID 格式和存储由 Claude SDK 决定

---

## 2.4 Provider 注册表

**文件**：`packages/providers/src/registry.ts`

```typescript
type ProviderFactory = () => IAgentProvider

const registry = new Map<string, ProviderFactory>()

export function registerProvider(id: string, factory: ProviderFactory): void
export function getProvider(id: string): IAgentProvider | undefined
export function listProviders(): string[]
```

### 当前注册

```typescript
// packages/providers/src/index.ts
registerProvider('claude', () => new ClaudeSDKProvider())
registerProvider('claude-code', () => new ClaudeSDKProvider())  // 别名
```

### 新增 Pi 注册

```typescript
registerProvider('pi', () => new PiAgentProvider())
```

---

## 2.5 Provider 在引擎中的使用

### 工作流引擎 → 执行器

**文件**：`packages/engine/src/engine.ts`

```typescript
class WorkflowEngine {
  constructor(workflow, providers: Record<string, IAgentProvider>, ...)
  
  createExecutor(node) {
    switch (node.type) {
      case "agent":
        return new AgentExecutor(node, pool, new AgentNodeRunner(provider), ...)
      case "swarm":
        return new SwarmExecutor(node, pool, providers, ...)
      case "loop":
        return new LoopExecutor(node, pool, providers, ...)  // 向下传递 providers
    }
  }
}
```

Provider 解析：`node.engine ?? workflow.engine ?? "claude"` → 查找 `providers[engine]`

### AgentNodeRunner — Provider 桥接器

**文件**：`packages/engine/src/executors/agent-runner.ts`

```typescript
class AgentNodeRunner {
  constructor(provider: IAgentProvider, cwd: string, onEvent?: (event: AgentEvent) => void)
  
  async run(params): Promise<AgentRunResult> {
    const generator = this.provider.sendQuery(prompt, cwd, sessionId, options)
    
    for await (const chunk of generator) {
      // 转换 MessageChunk → AgentEvent
      // 发射事件给 SSE/UI
      // 收集最终文本、token 使用量
    }
    
    return { finalText, sessionId, tokens, modelUsages, events, llmCalls }
  }
}
```

**关键超时机制**：
- 空闲超时：20 分钟无活动
- 重试机制：流断裂时重试
- 心跳监控：活动状态追踪

### SwarmExecutor — 直接消费

**文件**：`packages/engine/src/executors/swarm.ts`

SwarmExecutor **不**通过 AgentNodeRunner，而是直接消费 Provider：

```typescript
async function collectFromProvider(provider, prompt, cwd, model) {
  const generator = provider.sendQuery(prompt, cwd, undefined, {
    model,
    systemPrompt: "You are an expert assistant."
  })
  
  for await (const chunk of generator) {
    if (chunk.type === 'text_delta') text += chunk.content
    if (chunk.type === 'result') tokens = chunk.tokens
    if (chunk.type === 'tool_call') toolCalls.push(chunk)
  }
  
  return { text, tokens, toolCalls }
}
```

**⚠️ 这意味着 Pi Provider 必须产出**：
- `text_delta`（专家输出）
- `result`（token 会计）
- `tool_call`（工具追踪，可选）

---

## 2.6 工作流 YAML 特性清单

### 顶层字段

| 字段 | 类型 | 用途 |
|------|------|------|
| `engine` | string | 全局 Provider（默认 `"claude"`） |
| `model` | string | 全局默认模型 |
| `execution_mode` | `"auto" \| "serial"` | DAG 并行 / 顺序 |
| `variables` | Record | 初始变量池 |
| `auto_answers` | AutoAnswer[] | 全局自动应答 |
| `hooks` | WorkflowHooks | 生命周期钩子（14 个事件） |

### 7 种节点类型

| 类型 | 关键字段 | Provider 相关 |
|------|----------|--------------|
| **agent** | `prompt`, `agent`, `model`, `skills`, `agents`, `goal`, `auto_answers` | ✅ 直接使用 Provider |
| **swarm** | `topic`, `mode`, `experts`, `rounds`, `host` | ✅ 每个专家调用 Provider |
| **loop** | `while`, `break_when`, `nodes` | ✅ 传递 Provider 到子节点 |
| **bash** | `bash` | ❌ 不调用 Provider |
| **python** | `python` | ❌ 不调用 Provider |
| **condition** | `cases` | ❌ 不调用 Provider |
| **approval** | `options` | ❌ 不调用 Provider |

### Agent 节点详细字段

```yaml
- id: my-agent
  type: agent
  engine: pi                     # ← Provider 路由
  model: openai/gpt-4o          # ← 模型选择
  prompt: "Analyze code..."
  agent: "code-reviewer"        # ← 角色标识
  skills: ["skill-a"]           # ← 技能注入
  auto_answers: [...]           # ← 节点级自动应答
  agents:                       # ← 子代理定义
    researcher:
      description: "Research expert"
      prompt: "You are..."
      tools: ["Read", "WebSearch"]
      model: "sonnet"
      maxTurns: 10
  goal: "Refactor auth module"  # ← 目标模式
  constraints: [...]            # ← 约束条件
  resume_from: "$prev.session"  # ← 会话恢复
```

---

## 2.7 对 Pi 集成的影响分析

### Provider 必须支持的最小事件集

| 使用场景 | 必须产出的 MessageChunk |
|----------|------------------------|
| AgentExecutor（AgentNodeRunner） | `text_delta`, `tool_call`, `tool_result`, `result`, `error` |
| SwarmExecutor（collectFromProvider） | `text_delta`, `result` |
| 完整 UI 展示 | 全部 18 种（理想情况） |

### 最小可行 Provider 实现

```typescript
class PiAgentProvider implements IAgentProvider {
  async *sendQuery(prompt, cwd, resumeSessionId?, options?): AsyncGenerator<MessageChunk> {
    // 必须产出：text_delta + result
    // 可选产出：thinking, tool_call, tool_result, error
  }
  
  getType(): string { return 'pi' }
}
```

### 扩展点

Pi Provider 相比 ClaudeSDKProvider 可新增的能力：
- **自定义工具** — 通过 Extension 注册 Octopus 特有工具
- **多模型路由** — 工作流节点级别切换 LLM 提供商
- **上下文注入** — 通过 `before_provider_request` 修改消息
- **子代理编排** — 通过 Extension Tool 实现 YAML `agents` 语义
