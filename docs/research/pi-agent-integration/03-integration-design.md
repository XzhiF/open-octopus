# 第三章：集成架构设计（核心）

> 本章是集成方案的核心设计文档，覆盖事件映射、异步桥接、文件结构和关键代码模式。

---

## 3.1 总体架构

```
┌───────────────────────────────────────────────────────────────────┐
│                      WorkflowEngine                                │
│                                                                   │
│  providers: { "claude": ClaudeSDKProvider, "pi": PiAgentProvider }│
│                                                                   │
│  node.engine = "pi" → PiAgentProvider                            │
│  node.engine = "claude" → ClaudeSDKProvider                      │
└─────────────────────────────┬─────────────────────────────────────┘
                              │
          ┌───────────────────▼───────────────────────┐
          │         PiAgentProvider                     │
          │  implements IAgentProvider                  │
          │                                             │
          │  sendQuery() ──→ AsyncGenerator<MsgChunk>  │
          │       │                                     │
          │       ▼                                     │
          │  ┌─────────────────────────────────────┐   │
          │  │  createAgentSession()                 │   │
          │  │  (pi-coding-agent SDK)                │   │
          │  │                                       │   │
          │  │  AgentSession                          │   │
          │  │    ├── Agent (pi-agent-core)           │   │
          │  │    │     └── agentLoop()               │   │
          │  │    │           └── streamFn()          │   │
          │  │    │                 └── pi-ai          │   │
          │  │    ├── Tools (Bash/Read/Edit/Write...) │   │
          │  │    ├── Extensions (sub-agent-tool)      │   │
          │  │    ├── ModelRegistry (40+ providers)   │   │
          │  │    └── SessionManager (JSONL)          │   │
          │  └─────────────────────────────────────┘   │
          │       │                                     │
          │  ┌────▼────────────────────────────────┐   │
          │  │  AsyncBridge                         │   │
          │  │  subscribe() → AsyncGenerator        │   │
          │  └─────────────────────────────────────┘   │
          │       │                                     │
          │  ┌────▼────────────────────────────────┐   │
          │  │  EventMapper                         │   │
          │  │  AgentSessionEvent → MessageChunk    │   │
          │  └─────────────────────────────────────┘   │
          └───────────────────────────────────────────────┘
```

---

## 3.2 文件结构

```
packages/providers/src/
├── pi/
│   ├── provider.ts              # PiAgentProvider 主类（IAgentProvider 实现）
│   ├── async-bridge.ts          # 事件订阅 → AsyncGenerator 桥接
│   ├── event-mapper.ts          # Pi AgentSessionEvent → Octopus MessageChunk 映射
│   ├── model-resolver.ts        # Octopus model 字符串 → Pi Model<Api> 对象
│   ├── token-aggregator.ts      # Pi Usage → Octopus TokenUsage + ModelUsageEntry[]
│   ├── session-cache.ts         # AgentSession 生命周期管理（按 cwd 缓存）
│   └── extensions/
│       ├── sub-agent-tool.ts    # 子代理委派工具
│       └── octopus-hooks.ts     # Octopus 生命周期钩子
├── types.ts                     # （现有，不修改）
├── registry.ts                  # （现有，添加 pi 工厂）
└── index.ts                     # （现有，添加 export）
```

---

## 3.3 核心难点 1：异步桥接

### 问题

- Pi 的 `AgentSession.prompt()` 返回 `Promise<void>` — 事件在执行过程中通过 `subscribe()` 推送
- Octopus 的 `sendQuery()` 必须返回 `AsyncGenerator<MessageChunk>` — 消费者拉取事件

**本质**：push-based 事件系统 → pull-based 异步生成器的转换。

### 解决方案：EventQueue 桥接

```typescript
// packages/providers/src/pi/async-bridge.ts

interface QueuedItem<T> {
  value?: T
  done?: boolean
  error?: Error
}

export class AsyncEventBridge<TIn, TOut> {
  private queue: QueuedItem<TOut>[] = []
  private waiters: Array<(item: QueuedItem<TOut>) => void> = []
  private finished = false
  
  constructor(
    private mapper: (event: TIn) => TOut | TOut[] | null
  ) {}
  
  /** 生产者调用：推送 Pi 事件 */
  push(event: TIn): void {
    if (this.finished) return
    const mapped = this.mapper(event)
    if (mapped === null) return
    const items = Array.isArray(mapped) ? mapped : [mapped]
    for (const item of items) {
      const queued: QueuedItem<TOut> = { value: item }
      const waiter = this.waiters.shift()
      if (waiter) {
        waiter(queued)
      } else {
        this.queue.push(queued)
      }
    }
  }
  
  /** 生产者调用：标记结束 */
  end(): void {
    this.finished = true
    const waiter = this.waiters.shift()
    if (waiter) waiter({ done: true })
  }
  
  /** 生产者调用：标记错误 */
  fail(error: Error): void {
    this.finished = true
    const waiter = this.waiters.shift()
    if (waiter) waiter({ error })
  }
  
  /** 消费者使用：AsyncGenerator */
  async *generator(): AsyncGenerator<TOut> {
    while (true) {
      const item = await this.next()
      if (item.error) throw item.error
      if (item.done) return
      yield item.value!
    }
  }
  
  private next(): Promise<QueuedItem<TOut>> {
    if (this.queue.length > 0) {
      return Promise.resolve(this.queue.shift()!)
    }
    if (this.finished) {
      return Promise.resolve({ done: true })
    }
    return new Promise(resolve => this.waiters.push(resolve))
  }
}
```

### 使用模式

```typescript
// provider.ts 内部
async *sendQuery(prompt, cwd, resumeSessionId?, options?): AsyncGenerator<MessageChunk> {
  const bridge = new AsyncEventBridge<AgentSessionEvent, MessageChunk>(
    (event) => mapPiEventToChunks(event, ctx)  // 返回 MessageChunk | MessageChunk[] | null
  )
  
  // 1. 订阅 Pi 事件 → 推送到 bridge
  const unsubscribe = session.subscribe((event) => {
    try {
      bridge.push(event)
    } catch (err) {
      bridge.fail(err instanceof Error ? err : new Error(String(err)))
    }
  })
  
  // 2. 启动 agent（不等待完成，事件通过 subscribe 推送）
  const runPromise = session.prompt(prompt, { /* options */ })
    .then(() => bridge.end())
    .catch((err) => bridge.fail(err))
  
  // 3. 通过 bridge 消费事件
  try {
    yield* bridge.generator()
  } finally {
    unsubscribe()
    // 确保 prompt promise 被处理
    await runPromise.catch(() => {})
  }
}
```

### 并发安全性分析

- **push 是同步的** — subscribe 回调中直接 push，无异步间隙
- **waiter 通知是即时的** — push 时如果有等待的消费者，直接唤醒
- **end/fail 只触发一次** — `finished` 标志防止重复终止
- **unsubscribe 清理** — finally 块确保不再接收事件

---

## 3.4 核心难点 2：事件映射

### Pi AgentSessionEvent → Octopus MessageChunk 完整映射

```typescript
// packages/providers/src/pi/event-mapper.ts

interface MapperContext {
  messageId: string          // 当前消息 ID（在 message_start 时生成）
  currentToolCallId?: string // 当前工具调用 ID
  toolStartTimes: Map<string, number>  // 工具执行开始时间
  tokenAggregator: TokenAggregator
}

export function mapPiEventToChunks(
  event: AgentSessionEvent,
  ctx: MapperContext
): MessageChunk | MessageChunk[] | null {
  switch (event.type) {
    
    // ═══════════════════════════════════════════
    // 消息生命周期
    // ═══════════════════════════════════════════
    case "message_start": {
      ctx.messageId = generateId()
      return {
        type: 'message_start',
        messageId: ctx.messageId,
      }
    }
    
    case "message_update": {
      const sub = event.assistantMessageEvent
      return mapAssistantEvent(sub, ctx)
    }
    
    case "message_end": {
      return [
        { type: 'text_done', messageId: ctx.messageId },
        { type: 'message_stop', messageId: ctx.messageId },
      ]
    }
    
    // ═══════════════════════════════════════════
    // 工具执行生命周期
    // ═══════════════════════════════════════════
    case "tool_execution_start": {
      ctx.toolStartTimes.set(event.toolCallId, Date.now())
      return [
        {
          type: 'tool_call_start',
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          messageId: ctx.messageId,
        },
        {
          type: 'tool_call',
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          toolInput: event.args,
          messageId: ctx.messageId,
        },
      ]
    }
    
    case "tool_execution_update": {
      const startTime = ctx.toolStartTimes.get(event.toolCallId) ?? Date.now()
      return {
        type: 'tool_progress',
        toolCallId: event.toolCallId,
        elapsedSeconds: Math.round((Date.now() - startTime) / 1000),
      }
    }
    
    case "tool_execution_end": {
      const startTime = ctx.toolStartTimes.get(event.toolCallId)
      const duration = startTime
        ? `${((Date.now() - startTime) / 1000).toFixed(1)}s`
        : undefined
      ctx.toolStartTimes.delete(event.toolCallId)
      
      // 从 result.content 提取文本
      const content = Array.isArray(event.result?.content)
        ? event.result.content
            .filter((c: any) => c.type === 'text')
            .map((c: any) => c.text)
            .join('\n')
        : String(event.result ?? '')
      
      return {
        type: 'tool_result',
        toolCallId: event.toolCallId,
        content,
        isError: event.isError,
        toolDuration: duration,
      }
    }
    
    // ═══════════════════════════════════════════
    // Agent 生命周期
    // ═══════════════════════════════════════════
    case "agent_end": {
      return {
        type: 'result',
        content: extractFinalText(event.messages),
        sessionId: undefined,  // 从 session manager 获取
        tokens: ctx.tokenAggregator.toTokenUsage(),
        costUsd: ctx.tokenAggregator.totalCost(),
        modelUsages: ctx.tokenAggregator.toModelUsages(),
      }
    }
    
    // ═══════════════════════════════════════════
    // 压缩事件
    // ═══════════════════════════════════════════
    case "compaction_start": {
      return { type: 'status', status: 'compacting' }
    }
    
    case "compaction_end": {
      return { type: 'status', status: null }
    }
    
    // ═══════════════════════════════════════════
    // 自动重试
    // ═══════════════════════════════════════════
    case "auto_retry_start": {
      return { type: 'status', status: 'requesting' }
    }
    
    case "auto_retry_end": {
      return { type: 'status', status: null }
    }
    
    // ═══════════════════════════════════════════
    // 忽略的事件（不需要映射）
    // ═══════════════════════════════════════════
    case "agent_start":
    case "turn_start":
    case "turn_end":
    case "queue_update":
    case "entry_appended":
    case "session_info_changed":
    case "thinking_level_changed":
      return null
  }
}

// ═══════════════════════════════════════════
// AssistantMessageEvent 子事件映射
// ═══════════════════════════════════════════
function mapAssistantEvent(
  event: AssistantMessageEvent,
  ctx: MapperContext
): MessageChunk | MessageChunk[] | null {
  switch (event.type) {
    case "text_delta":
      return {
        type: 'text_delta',
        content: event.delta,
        messageId: ctx.messageId,
      }
    
    case "thinking_start":
      return {
        type: 'thinking_start',
        messageId: ctx.messageId,
      }
    
    case "thinking_delta":
      return {
        type: 'thinking',
        content: event.delta,
        messageId: ctx.messageId,
      }
    
    case "thinking_end":
      return {
        type: 'thinking_done',
        messageId: ctx.messageId,
      }
    
    case "toolcall_start":
    case "toolcall_delta":
      // tool_call_start 和 tool_call 在 tool_execution_start 时产出
      return null
    
    case "toolcall_end":
      // tool_execution_start 会处理完整的工具调用信息
      return null
    
    case "done":
      // 在 message_end 和 agent_end 中处理
      return null
    
    case "error":
      return {
        type: 'error',
        code: event.reason,
        message: event.error.errorMessage ?? 'Agent error',
      }
    
    case "start":
    case "text_start":
    case "text_end":
      return null
  }
}
```

### 映射总结表

| Pi AgentSessionEvent | Octopus MessageChunk | 备注 |
|---|---|---|
| `message_start` | `message_start` | 生成 messageId |
| `message_update` → `text_delta` | `text_delta` | 文本增量 |
| `message_update` → `thinking_start` | `thinking_start` | 思考开始 |
| `message_update` → `thinking_delta` | `thinking` | 思考增量 |
| `message_update` → `thinking_end` | `thinking_done` | 思考结束 |
| `message_update` → `error` | `error` | LLM 错误 |
| `message_end` | `text_done` + `message_stop` | 消息结束 |
| `tool_execution_start` | `tool_call_start` + `tool_call` | 工具调用开始 |
| `tool_execution_update` | `tool_progress` | 工具执行中 |
| `tool_execution_end` | `tool_result` | 工具结果 |
| `agent_end` | `result` | 最终结果（含 token） |
| `compaction_start` | `status: 'compacting'` | 上下文压缩 |
| `compaction_end` | `status: null` | 压缩结束 |
| `auto_retry_start` | `status: 'requesting'` | 自动重试 |
| `auto_retry_end` | `status: null` | 重试结束 |
| `agent_start`, `turn_start`, `turn_end`, `queue_update`, ... | _(丢弃)_ | 不需要映射 |

### 不可映射的 Octopus 事件

| Octopus MessageChunk | Pi 等价 | 处理方式 |
|---|---|---|
| `message_delta` | Pi 在 `done` 事件中有 stopReason | 可在 `message_end` 时补充 |
| `tool_summary` | Pi 没有等价 | 不产出（非关键） |
| `ask_user_question` | Pi 没有 AskUserQuestion | 通过 `beforeToolCall` hook 拦截 |
| `local_command_output` | Pi 的 bash 输出在 tool_result 中 | 不单独产出 |

---

## 3.5 核心难点 3：多提供商模型解析

### 问题

Octopus 工作流中 `model` 是字符串（如 `"gpt-4o"`、`"claude-sonnet-4-20250514"`），Pi 需要 `Model<Api>` 对象。

### 解决方案

```typescript
// packages/providers/src/pi/model-resolver.ts

import { ModelRegistry } from '@earendil-works/pi-coding-agent'

/**
 * 解析 Octopus model 字符串为 Pi Model 对象
 * 
 * 支持格式：
 *   "provider/model-id"  → 直接查找（如 "openai/gpt-4o"）
 *   "model-id"           → 在所有提供商中搜索
 *   "sonnet"             → 别名映射
 */
export function resolveModel(
  modelStr: string | undefined,
  registry: ModelRegistry
): Model<Api> | undefined {
  if (!modelStr) return undefined
  
  // 1. 尝试 "provider/model-id" 格式
  if (modelStr.includes('/')) {
    const [provider, modelId] = modelStr.split('/', 2)
    return registry.find(provider, modelId)
  }
  
  // 2. 尝试别名映射
  const alias = MODEL_ALIASES[modelStr]
  if (alias) {
    return registry.find(alias.provider, alias.modelId)
  }
  
  // 3. 在所有提供商中搜索
  const allModels = registry.getAll()
  return allModels.find(m => m.id === modelStr || m.name === modelStr)
}

// 常用别名
const MODEL_ALIASES: Record<string, { provider: string; modelId: string }> = {
  'sonnet': { provider: 'anthropic', modelId: 'claude-sonnet-4-20250514' },
  'opus': { provider: 'anthropic', modelId: 'claude-opus-4-20250514' },
  'haiku': { provider: 'anthropic', modelId: 'claude-haiku-4-5-20251001' },
  'gpt-4o': { provider: 'openai', modelId: 'gpt-4o' },
  'gpt-4o-mini': { provider: 'openai', modelId: 'gpt-4o-mini' },
  'gemini-pro': { provider: 'google', modelId: 'gemini-2.5-pro' },
  'deepseek-v3': { provider: 'deepseek', modelId: 'deepseek-chat' },
}
```

### API Key 解析

```typescript
// Pi 的 ModelRegistry 自动从环境变量解析 API Key
// 环境变量命名约定：{PROVIDER}_API_KEY
// 例如：ANTHROPIC_API_KEY, OPENAI_API_KEY, GOOGLE_API_KEY

// Octopus 的 env 选项可以注入额外环境变量
function buildEnvForPi(options?: SendQueryOptions): Record<string, string> {
  return {
    ...process.env as Record<string, string>,
    ...options?.env,
  }
}
```

---

## 3.6 PiAgentProvider 主类

```typescript
// packages/providers/src/pi/provider.ts

import { createAgentSession, type AgentSession, type CreateAgentSessionResult }
  from '@earendil-works/pi-coding-agent'
import type { IAgentProvider, SendQueryOptions, MessageChunk } from '../types'
import { AsyncEventBridge } from './async-bridge'
import { mapPiEventToChunks, type MapperContext } from './event-mapper'
import { resolveModel } from './model-resolver'
import { TokenAggregator } from './token-aggregator'
import { createSubAgentTool } from './extensions/sub-agent-tool'
import { LLMCallTracker } from '../llm-call-tracker'

export class PiAgentProvider implements IAgentProvider {
  private sessionCache = new Map<string, CreateAgentSessionResult>()
  private llmCallTracker = new LLMCallTracker()
  
  getType(): string {
    return 'pi'
  }
  
  getLLMCalls() {
    return this.llmCallTracker.getRecords()
  }
  
  async *sendQuery(
    prompt: string,
    cwd: string,
    resumeSessionId?: string,
    options?: SendQueryOptions
  ): AsyncGenerator<MessageChunk> {
    
    // 1. 获取或创建 AgentSession
    const sessionResult = await this.getOrCreateSession(cwd, options)
    const { session } = sessionResult
    
    // 2. 解析模型
    if (options?.model) {
      const model = resolveModel(options.model, session.modelRegistry)
      if (model) {
        await session.setModel(model)
      }
    }
    
    // 3. 设置系统提示（覆盖 Pi 默认）
    // 通过 before_provider_request 扩展钩子注入
    
    // 4. 注册子代理工具（如果有）
    if (options?.agents) {
      this.registerSubAgentTools(session, options.agents, cwd, options)
    }
    
    // 5. 构建映射上下文
    const tokenAggregator = new TokenAggregator()
    const mapperCtx: MapperContext = {
      messageId: '',
      toolStartTimes: new Map(),
      tokenAggregator,
    }
    
    // 6. 创建异步桥接
    const bridge = new AsyncEventBridge(
      (event: any) => mapPiEventToChunks(event, mapperCtx)
    )
    
    // 7. 订阅事件 → 推送到 bridge
    const unsubscribe = session.subscribe((event: any) => {
      try { bridge.push(event) }
      catch (err) { bridge.fail(err instanceof Error ? err : new Error(String(err))) }
    })
    
    // 8. 处理 abort
    if (options?.abortSignal) {
      options.abortSignal.addEventListener('abort', () => {
        session.abort()
        bridge.end()
      }, { once: true })
    }
    
    // 9. 启动 agent（不等待）
    const runPromise = session.prompt(prompt)
      .then(() => bridge.end())
      .catch((err: Error) => bridge.fail(err))
    
    // 10. 消费事件流
    try {
      yield* bridge.generator()
    } finally {
      unsubscribe()
      await runPromise.catch(() => {})
    }
  }
  
  private async getOrCreateSession(
    cwd: string,
    options?: SendQueryOptions,
    resumeSessionId?: string,
  ): Promise<CreateAgentSessionResult> {
    const cacheKey = `${cwd}:${resumeSessionId ?? 'new'}`
    let result = this.sessionCache.get(cacheKey)
    if (result) return result

    // ── 关键：Headless 模式配置 ──
    // 禁用磁盘扩展加载，避免用户安装的 Pi CLI 扩展干扰 Octopus 行为
    const loader = new DefaultResourceLoader({
      cwd,
      noExtensions: true,       // 不加载 ~/.pi/agent/extensions/
      noSkills: true,           // 不加载 Pi 的 skills（Octopus 有自己的）
      noContextFiles: true,     // 不加载 AGENTS.md / CLAUDE.md
      noPromptTemplates: true,
      noThemes: true,
    })
    await loader.reload()

    // ── 关键：ModelRegistry 认证注入 ──
    // createAgentSession 内部的 streamFn 使用 ModelRegistry 获取 API Key，
    // **不是** agent.getApiKey。必须通过 registerProvider 注入认证。
    // （实测验证：直接覆盖 session.agent.getApiKey 无效）
    const authStorage = AuthStorage.inMemory()
    const modelRegistry = ModelRegistry.inMemory(authStorage)

    // 从 SendQueryOptions.env 中提取各提供商 API Key，注册到 ModelRegistry
    this.registerProvidersFromEnv(modelRegistry, options?.env)

    // Session 恢复（详见 08 章可行性验证）
    let sessionManager: SessionManager | undefined
    if (resumeSessionId) {
      const sessions = await SessionManager.list(cwd)
      const match = sessions.find(s =>
        s.id === resumeSessionId || s.id.startsWith(resumeSessionId)
      )
      sessionManager = match
        ? SessionManager.open(match.path)
        : undefined
    }

    const customTools = options?.agents
      ? createSubAgentTools(options.agents, cwd, options)
      : []

    result = await createAgentSession({
      cwd,
      resourceLoader: loader,
      modelRegistry,
      sessionManager,
      customTools,
    })

    this.sessionCache.set(cacheKey, result)
    return result
  }

  /**
   * 从环境变量注册 LLM 提供商到 ModelRegistry。
   * 支持的环境变量命名：ANTHROPIC_API_KEY, OPENAI_API_KEY, GOOGLE_API_KEY, ...
   * 也支持 Octopus env 选项中的自定义 key。
   */
  private registerProvidersFromEnv(
    registry: ModelRegistry,
    env?: Record<string, string>,
  ): void {
    const mergedEnv = { ...process.env, ...env } as Record<string, string>

    const PROVIDER_ENV_MAP: Record<string, { envKey: string; baseUrl: string; api: string }> = {
      anthropic:  { envKey: 'ANTHROPIC_API_KEY', baseUrl: 'https://api.anthropic.com', api: 'anthropic-messages' },
      openai:     { envKey: 'OPENAI_API_KEY',    baseUrl: 'https://api.openai.com/v1',  api: 'openai-responses' },
      google:     { envKey: 'GOOGLE_API_KEY',    baseUrl: 'https://generativelanguage.googleapis.com/v1beta', api: 'google-generative-ai' },
      deepseek:   { envKey: 'DEEPSEEK_API_KEY',  baseUrl: 'https://api.deepseek.com/v1', api: 'openai-completions' },
      dashscope:  { envKey: 'DASHSCOPE_API_KEY', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', api: 'openai-completions' },
    }

    for (const [providerId, config] of Object.entries(PROVIDER_ENV_MAP)) {
      const apiKey = mergedEnv[config.envKey]
      if (apiKey) {
        registry.registerProvider(providerId, {
          name: providerId,
          baseUrl: config.baseUrl,
          apiKey,
          api: config.api,
        })
      }
    }
  }
  
  private registerSubAgentTools(
    session: AgentSession,
    agents: Record<string, any>,
    cwd: string,
    options: SendQueryOptions
  ): void {
    // 通过 Extension API 动态注册子代理工具
    // 详见 04-feature-bridging.md
  }
  
  /** 清理所有缓存的 session */
  dispose(): void {
    for (const [, result] of this.sessionCache) {
      result.session.dispose()
    }
    this.sessionCache.clear()
  }
}
```

---

## 3.7 Token 聚合器

```typescript
// packages/providers/src/pi/token-aggregator.ts

import type { TokenUsage, ModelUsageEntry } from '../types'
import type { Usage } from '@earendil-works/pi-ai'

export class TokenAggregator {
  private totalInput = 0
  private totalOutput = 0
  private modelMap = new Map<string, ModelUsageEntry>()
  
  /** 累加一次 LLM 调用的 usage */
  add(model: string, usage: Usage): void {
    this.totalInput += usage.input
    this.totalOutput += usage.output
    
    const existing = this.modelMap.get(model)
    if (existing) {
      existing.inputTokens += usage.input
      existing.outputTokens += usage.output
      existing.cacheReadInputTokens = (existing.cacheReadInputTokens ?? 0) + usage.cacheRead
      existing.cacheCreationInputTokens = (existing.cacheCreationInputTokens ?? 0) + usage.cacheWrite
      existing.costUsd = (existing.costUsd ?? 0) + (usage.cost?.total ?? 0)
    } else {
      this.modelMap.set(model, {
        model,
        inputTokens: usage.input,
        outputTokens: usage.output,
        cacheReadInputTokens: usage.cacheRead,
        cacheCreationInputTokens: usage.cacheWrite,
        costUsd: usage.cost?.total,
      })
    }
  }
  
  toTokenUsage(): TokenUsage {
    return {
      input: this.totalInput,
      output: this.totalOutput,
      total: this.totalInput + this.totalOutput,
    }
  }
  
  toModelUsages(): ModelUsageEntry[] {
    return Array.from(this.modelMap.values())
  }
  
  totalCost(): number {
    let total = 0
    for (const entry of this.modelMap.values()) {
      total += entry.costUsd ?? 0
    }
    return total
  }
}
```

---

## 3.8 Session 缓存策略

### 问题

`createAgentSession()` 是重量级操作（加载扩展、初始化工具、建立 Session）。但 `sendQuery()` 可能在工作流中被多次调用（同一 cwd）。

### 策略

| 场景 | 行为 |
|------|------|
| 同 cwd 首次调用 | `createAgentSession()` → 缓存 |
| 同 cwd 后续调用 | 复用缓存的 session，`prompt()` 追加消息 |
| 不同 cwd | 各自独立的 session |
| `resumeSessionId` 存在 | 通过 SessionManager 恢复历史 session |
| Provider `dispose()` | 清理所有缓存 session |

### 注意事项

- Pi 的 Session 是有状态的（消息历史），复用 session 意味着后续 prompt 会包含之前的对话
- 这与 ClaudeSDKProvider 的 `resumeSessionId` 行为一致
- 如果需要完全新的对话，需要创建新 session 或调用 `session.agent.reset()`

---

## 3.9 工作流 YAML 使用示例

```yaml
apiVersion: octopus/v1
kind: Workflow
name: multi-provider-demo
execution_mode: auto

nodes:
  # 使用 Pi + Anthropic
  - id: analyze
    type: agent
    engine: pi
    model: anthropic/claude-sonnet-4-20250514
    prompt: "Analyze the codebase structure and list key modules."

  # 使用 Pi + OpenAI
  - id: review
    type: agent
    engine: pi
    model: openai/gpt-4o
    depends_on: [analyze]
    prompt: |
      Review this analysis: $analyze.output.summary
      Focus on potential security issues.

  # 使用 Pi + DeepSeek（低成本）
  - id: summarize
    type: agent
    engine: pi
    model: deepseek/deepseek-chat
    depends_on: [review]
    prompt: |
      Summarize the security review:
      $review.output.summary

  # Swarm 模式：混合提供商
  - id: decision
    type: swarm
    depends_on: [summarize]
    mode: debate
    rounds: 2
    topic: "Should we adopt microservices?"
    experts:
      - name: architect
        engine: pi
        model: anthropic/claude-opus-4-20250514
      - name: pragmatist
        engine: pi
        model: openai/gpt-4o
```
