import type { LLMCallRecord } from './llm-call-tracker'
import type { EffortLevel } from '@octopus/shared'
// TokenUsage / ModelUsage / TokenUsageDelta 全站规范形状定义在 @octopus/shared（C1 口径统一）。
// provider 的职责：在 SDK seam 把 snake_case 原始事件转成规范形状，其余各层不再换形。
import type { TokenUsage, ModelUsage, TokenUsageDelta } from '@octopus/shared'

export interface SystemPromptPreset {
  type: 'preset'
  preset: 'claude_code'
  append?: string
}

export type SystemPromptInput = string | SystemPromptPreset

export interface OctopusAgentDef {
  description: string
  prompt: string
  tools?: string[]
  model?: string
  skills?: string[]
  maxTurns?: number
  background?: boolean
  effort?: EffortLevel
}

export interface ProviderPolicy {
  allowedEngines?: string[]
  maxConcurrentSessions?: number
  budgetLimitUsd?: number
}

export interface SendQueryOptions {
  model?: string
  systemPrompt?: SystemPromptInput
  abortSignal?: AbortSignal
  /**
   * Deadline for the SDK to produce its first stream event. When it elapses the
   * query is aborted and an `IDLE_TIMEOUT` error chunk is yielded instead of
   * hanging the turn forever. Default 90s (see idle-watchdog.ts).
   */
  firstEventTimeoutMs?: number
  /**
   * Max silence between two SDK events once the stream is live. Default 300s.
   * Same recovery path as `firstEventTimeoutMs`.
   */
  streamIdleTimeoutMs?: number
  /**
   * Run the query in SDK **streaming input mode** so a stop can use
   * `Query.interrupt()` instead of a hard `abortController.abort()`.
   *
   * Why it matters (2026-10-31, verified against the real SDK): a hard abort
   * kills the CLI subprocess and the iterator throws — NO `result` message is
   * emitted, so the turn's token usage is unrecoverable. A clean interrupt
   * still yields the interrupted turn's `SDKResultMessage` (subtype
   * `error_during_execution`) whose `usage`/`modelUsage` carry the real totals
   * for every model call completed so far (the in-flight call itself is not
   * billable-measurable and reports zero).
   *
   * Off by default: non-chat callers (engine nodes, compression, scheduler)
   * keep the existing single-message behavior.
   */
  interruptible?: boolean
  /**
   * 首轮结束时若仍有后台任务（Bash `run_in_background` 等），不关闭 query，
   * 继续消费 —— SDK 会在后台任务结束时自动唤醒模型跑第二轮。只有长期在线的
   * chat 会话该打开；workflow / engine / clone 仍按首轮 result 收轮。
   */
  awaitBackgroundTasks?: boolean
  /** 等后台任务时的看门狗预算（默认 60min）；普通流的 300s 会误杀长构建。 */
  backgroundWaitTimeoutMs?: number
  /** Free-form tag (usually the workflow node id) echoed into [exec-timing]
   *  logs when OCTOPUS_EXEC_TIMING=1. No behavioral effect. */
  timingTag?: string
  /** USD budget cap — SDK enforces it via `error_max_budget_usd` terminal result. */
  maxBudgetUsd?: number
  /** Hard cap on assistant API round-trips — SDK enforces it via `error_max_turns`. */
  maxTurns?: number
  env?: Record<string, string>
  agent?: string
  skills?: string[]
  tools?: string[]
  agents?: Record<string, OctopusAgentDef>
  /** In-process MCP servers (e.g. octopus workflow control tools). */
  mcpServers?: Record<string, unknown>
  plugins?: Array<{ type: 'local'; path: string }>
  disablePlugins?: string[]
  disallowedTools?: string[]
  effort?: EffortLevel
  /**
   * When true, AskUserQuestion tool calls are intercepted via canUseTool callback.
   * The deny message tells the model the question was forwarded to the web UI,
   * preventing the SDK's hardcoded "Error: Answer questions?" tool result.
   */
  interactionSession?: boolean

  /**
   * Optional callback invoked before each tool call executes.
   * Used by the Tool Interceptor (harness) to block dangerous bash commands.
   *
   * Return `{ allow: false, reason: string }` to block the tool call.
   * Return `{ allow: true }` or `undefined` to allow it.
   */
  onBeforeToolCall?: (toolName: string, input: unknown) => Promise<{ allow: boolean; reason?: string } | undefined>
  varsUpdate?: boolean
  customProviders?: Record<string, {
    base_url: string
    api?: string
    env_key?: string
    models: Array<{
      id: string
      name?: string
      context_window?: number
      max_tokens?: number
      reasoning?: boolean
      cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }
    }>
  }>
}

/**
 * SDK hard-fuse terminal reasons, derived from the result subtype:
 * `error_max_turns` → 'max_turns', `error_max_budget_usd` → 'max_budget_usd'.
 * (The SDK's raw `terminal_reason` uses 'budget_exhausted' for the budget case —
 * we normalize to the feature vocabulary consumed by the engine runner.)
 */
export type GoalTerminalReason = 'max_turns' | 'max_budget_usd'

/**
 * Convergence evidence from the SDK's `/goal` Stop hook (SDKActiveGoalMessage,
 * a TOP-LEVEL StdoutMessage type). `condition` is null when the goal was
 * cleared (evaluator reported met); otherwise carries the condition text,
 * per-iteration count and the evaluator's last reason.
 */
export interface ActiveGoalChunk {
  type: 'active_goal'
  condition: string | null
  iterations: number
  last_reason?: string
  set_at?: number
}

/**
 * 会话里正在跑的后台任务（SDK `system:background_tasks_changed` / `task_started`）。
 * `description` 就是用户在「后台运行中」里该看到的「在跑什么」。
 */
export interface BackgroundTaskInfo {
  id: string
  description: string
  taskType?: string
}

/**
 * 子代理（SDK Task/Agent 工具）的一条操作日志块 —— 与 chat 的
 * tool_call / tool_result 同形，宿主据此渲染「像 chat 一样」的嵌套时间线。
 */
export interface SubagentLogBlock {
  kind: 'text' | 'thinking' | 'tool_use' | 'tool_result'
  text?: string
  toolName?: string
  toolUseId?: string
  input?: unknown
  content?: string
  isError?: boolean
}

/**
 * 子代理生命周期事件（2026-11-04 作业坞）。
 *
 * 数据源（真机 SDK 0.3.235 验证）：
 * - `started`   ← `system:task_started`（`task_type: local_agent`），带主 Agent 的完整指令 prompt；
 * - `progress`  ← `system:task_progress`（当前工具 / 步数 / 时长）；
 * - `log`       ← `assistant`/`user` 消息（`parent_tool_use_id` 指向主 Agent 的 Agent 调用）；
 * - `completed` ← `system:task_updated` / `system:task_notification`，带最终汇报 summary。
 *
 * 注意：子代理消息没有 `stream_event` 增量流（真机验证），是整条消息到达。
 */
export interface SubagentEvent {
  /** SDK task_id，同时也是 `agent-<agentId>.jsonl` 的 agentId。 */
  id: string
  /** 主 Agent 那次 Agent 调用的 tool_use id。 */
  parentToolUseId?: string
  agentType?: string
  description?: string
  /** 主 Agent 给子 Agent 的指令（task_started.prompt）。 */
  prompt?: string
  phase: 'started' | 'progress' | 'log' | 'completed'
  status?: 'running' | 'completed' | 'failed' | 'killed'
  lastToolName?: string
  /** 最终汇报（task_notification.summary）。 */
  summary?: string
  model?: string
  /** SDK 自己报的步数 / 时长。部分代理端点 total_tokens 恒 0，token 另从 transcript 汇总。 */
  toolUses?: number
  durationMs?: number
  blocks?: SubagentLogBlock[]
  /** SDK 会话 id —— 宿主据此读取 `subagents/agent-<id>.jsonl` 补全 token。 */
  sdkSessionId?: string
}

// message_delta 的 per-turn 实测用量与 SSE delta 均使用 shared 的 TokenUsageDelta，
// providers 不再本地定义任何 token 形状（C1 · D3 不留 alias）。

export type MessageChunk =
  | { type: 'message_start'; messageId: string }
  | { type: 'message_delta'; stopReason: string; outputTokens?: number; usage?: TokenUsageDelta; messageId: string }
  | { type: 'message_stop'; messageId: string }
  | { type: 'text_delta'; content: string; messageId: string }
  | { type: 'text_done'; messageId: string }
  | { type: 'thinking_start'; messageId: string }
  | { type: 'thinking'; content: string; messageId: string }
  | { type: 'thinking_done'; messageId: string; thinkingDuration?: string }
  | { type: 'tool_call_start'; toolCallId: string; toolName: string; messageId: string }
  | { type: 'tool_call'; toolCallId: string; toolName: string; toolInput: unknown; messageId: string }
  | { type: 'tool_progress'; toolCallId: string; elapsedSeconds: number }
  | { type: 'tool_result'; toolCallId: string; toolName: string; content: string; isError?: boolean; toolDuration?: string }
  | { type: 'tool_summary'; summary: string; toolCallIds: string[] }
  | { type: 'ask_user_question'; toolCallId: string; questions: unknown }
  | { type: 'complete_interaction'; toolCallId: string; summary: string; vars_update?: Record<string, any> }
  | { type: 'local_command_output'; content: string }
  /** Slash commands the CLI advertises for this session (`system:init`). The
   *  headless command set depends on discovered skills/plugins, so it is only
   *  knowable at runtime — hosts should replace their cached list with this. */
  | { type: 'slash_commands'; commands: string[] }
  /** Full SDK `system:init` snapshot (what the CLI actually loaded). The host
   *  keeps it for the debug inspector: tools / MCP status / skills / plugins /
   *  permission mode are otherwise invisible after the turn. */
  | { type: 'system_init'; data: SystemInitData }
  /** `/clear`: the CLI reset its conversation. Only the provider transcript
   *  is gone — host-side history (DB/messages) is the host's own. */
  | { type: 'conversation_reset' }
  /** Context compaction (manual `/compact` or SDK auto-compaction): the
   *  provider transcript was REWRITTEN into a summary. One-shot context the
   *  host sent earlier (role card, task playbook) may be summarized away, so
   *  hosts re-deliver it on the next turn. */
  | { type: 'compaction'; trigger: 'manual' | 'auto'; preTokens?: number; postTokens?: number; droppedTokens?: number; durationMs?: number }
  | { type: 'status'; status: 'compacting' | 'requesting' | null; varsUpdate?: Record<string, unknown> }
  /** 后台任务集合变化（电平信号，REPLACE 语义）：空数组 = 已无后台任务。 */
  | { type: 'background_tasks'; tasks: BackgroundTaskInfo[] }
  /** 子代理生命周期 / 操作日志（作业坞「子代理」入口的数据源）。 */
  | { type: 'subagent'; event: SubagentEvent }
  | { type: 'context_usage'; data: ContextUsageData }
  | { type: 'result'; content?: string; sessionId?: string; usage?: TokenUsage; costUsd?: number; numTurns?: number; modelUsages?: ModelUsage[] }
  | {
      type: 'error'
      code: string
      message: string
      numTurns?: number
      costUsd?: number
      sessionId?: string
      /** Goal-fuse vocabulary consumed by the engine (max_turns / max_budget_usd). */
      terminalReason?: GoalTerminalReason
      /** Raw SDK `terminal_reason` (e.g. 'aborted_tools', 'completed') — used by
       *  the ledger to label interrupted calls. */
      sdkTerminalReason?: string
      /** Result-level totals. Non-success results still carry real usage when the
       *  turn is interrupted after completed model calls — never drop them. */
      usage?: TokenUsage
      modelUsages?: ModelUsage[]
    }
  | ActiveGoalChunk

/** Context window usage breakdown — sourced from Claude Agent SDK's
 *  `Query.getContextUsage()`. Mirrors `SDKControlGetContextUsageResponse`.
 *  Emitted as a `context_usage` MessageChunk after `message_start`. */
export interface ContextUsageData {
  categories: { name: string; tokens: number; color: string; isDeferred?: boolean }[]
  totalTokens: number
  maxTokens: number
  rawMaxTokens: number
  percentage: number
  model: string
  memoryFiles?: { path: string; type: string; tokens: number }[]
  mcpTools?: { name: string; serverName: string; tokens: number; isLoaded?: boolean }[]
  systemPromptSections?: { name: string; tokens: number }[]
  systemTools?: { name: string; tokens: number }[]
  agents?: { agentType: string; source: string; tokens: number }[]
  slashCommands?: { totalCommands: number; includedCommands: number; tokens: number }
}

/** Normalized SDK `system:init` payload. Field names mirror the SDK's snake_case
 *  event; unknown fields are intentionally not carried. */
export interface SystemInitData {
  claudeCodeVersion?: string
  model?: string
  cwd?: string
  permissionMode?: string
  outputStyle?: string
  apiKeySource?: string
  effort?: string | null
  tools: string[]
  mcpServers: { name: string; status: string }[]
  agents: string[]
  skills: string[]
  plugins: { name: string; path: string; version?: string }[]
  slashCommands: string[]
  capabilities?: string[]
  betas?: string[]
}

export interface IAgentProvider {
  sendQuery(
    prompt: string,
    cwd: string,
    resumeSessionId?: string,
    options?: SendQueryOptions
  ): AsyncGenerator<MessageChunk>
  getType(): string
  getLLMCalls?(): LLMCallRecord[]
  testConnectivity?(model?: string): Promise<{ success: boolean; latency?: number; error?: string }>
}