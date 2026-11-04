import { query, type Options, type AgentDefinition, type CanUseTool, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { IAgentProvider, SendQueryOptions, MessageChunk, OctopusAgentDef, GoalTerminalReason, SystemInitData, BackgroundTaskInfo, SubagentEvent, SubagentLogBlock } from '../types'
import type { ModelUsage, TokenUsage, TokenUsageDelta } from '@octopus/shared'
import { mergeModelUsages } from '@octopus/shared'
import { LLMCallTracker } from '../llm-call-tracker'
import {
  DEFAULT_FIRST_EVENT_TIMEOUT_MS,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  IdleTimeoutError,
  guardIdle,
  withSoftTimeout,
} from '../idle-watchdog'
import { getPluginSdkConfigs, loadModelAliasConfig, resolveModelAlias } from '@octopus/shared'
import fs from 'fs'
import path from 'path'
import os from 'os'

interface SDKStreamEvent {
  type: string
  message?: { id: string; model?: string; usage?: { output_tokens?: number; input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }; stop_reason?: string }
  /** message_delta 顶层 usage：本条消息累计终值（output 必有，input/cache 按端点可能缺失） */
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }
  content_block?: { type: string; id?: string; name?: string; text?: string; thinking?: string; input?: unknown }
  delta?: { type: string; text?: string; thinking?: string; partial_json?: string; signature?: string; stop_reason?: string; stop_sequence?: string }
  index?: number
}

interface ToolResultEntry {
  toolName: string
  toolCallId?: string
  content: string
  isError?: boolean
}

interface PendingToolCall {
  id: string
  name: string
  partialJson: string
}

interface PendingQuestion {
  toolCallId: string
  questions: unknown
}

interface PendingCompletion {
  toolCallId: string
  summary: string
  vars_update?: Record<string, any>
}

function loadClaudeSettingsEnv(): Record<string, string> {
  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json')
  try {
    const raw = fs.readFileSync(settingsPath, 'utf8')
    const settings = JSON.parse(raw)
    return settings.env ?? {}
  } catch {
    return {}
  }
}

function buildSubprocessEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  const settingsEnv = loadClaudeSettingsEnv()
  const hasProcessAuth = Boolean(process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN)
  const hasSettingsAuth = Boolean(settingsEnv.ANTHROPIC_API_KEY || settingsEnv.ANTHROPIC_AUTH_TOKEN)
  const shouldUseGlobalAuth = !hasProcessAuth && !hasSettingsAuth && process.env.CLAUDE_USE_GLOBAL_AUTH === undefined
  return {
    ...process.env,
    ...settingsEnv,
    ...extra,
    ...(shouldUseGlobalAuth ? { CLAUDE_USE_GLOBAL_AUTH: 'true' } : {}),
  }
}

export function buildToolCaptureHooks(
  toolResultQueue: ToolResultEntry[],
  pendingQuestions: PendingQuestion[],
  pendingCompletions: PendingCompletion[],
  onBeforeToolCall?: (toolName: string, input: unknown) => Promise<{ allow: boolean; reason?: string } | undefined>,
): Options['hooks'] {
  return {
    PreToolUse: [{
      hooks: [async (input: unknown) => {
        const inp = input as Record<string, unknown>
        const toolName = inp.tool_name as string
        const toolInput = inp.tool_input

        // Check external onBeforeToolCall hook (e.g. Tool Interceptor for dangerous commands)
        if (onBeforeToolCall) {
          const decision = await onBeforeToolCall(toolName, toolInput)
          if (decision && decision.allow === false) {
            return {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny' as const,
              permissionDecisionReason: decision.reason ?? 'Tool call blocked by safety guard.',
            }
          }
        }

        if (toolName === 'AskUserQuestion') {
          // Capture question data for SSE events
          pendingQuestions.push({
            toolCallId: inp.tool_use_id as string,
            questions: toolInput,
          })
          // Deny via PreToolUse hook — this works even with bypassPermissions.
          // The permissionDecisionReason becomes the tool result the model sees.
          return {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny' as const,
            permissionDecisionReason: 'STOP. The question has been displayed to the user. The user has NOT answered yet. Do NOT output any text or guess any answer. Your turn is over — wait for the next user message.',
          }
        }
        if (toolName === 'complete_interaction') {
          // Capture completion data for processing
          const completionInput = (toolInput ?? {}) as Record<string, any>
          pendingCompletions.push({
            toolCallId: inp.tool_use_id as string,
            summary: completionInput.summary ?? '',
            vars_update: completionInput.vars_update,
          })
          return {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny' as const,
            permissionDecisionReason: 'Interaction completion captured and forwarded to workflow engine. The interaction is now complete. Do not output anything else.',
          }
        }
        return { continue: true }
      }],
    }],
    PostToolUse: [{
      hooks: [async (input: unknown) => {
        const inp = input as Record<string, unknown>
        // 子代理内部的工具结果不进主对话队列（2026-11-04）：它们由带
        // parent_tool_use_id 的消息带给「子代理」时间线，混入主队列会污染主对话。
        if (typeof inp.agent_id === 'string' && inp.agent_id) return { continue: true }
        toolResultQueue.push({
          toolName: (inp.tool_name as string) ?? 'unknown',
          toolCallId: inp.tool_use_id as string | undefined,
          content: typeof inp.tool_response === 'string'
            ? (inp.tool_response as string)
            : JSON.stringify(inp.tool_response ?? ''),
        })
        return { continue: true }
      }],
    }],
    PostToolUseFailure: [{
      hooks: [async (input: unknown) => {
        const inp = input as Record<string, unknown>
        if (inp.tool_name === 'AskUserQuestion' || inp.tool_name === 'complete_interaction') {
          return { continue: true }
        }
        if (typeof inp.agent_id === 'string' && inp.agent_id) return { continue: true }
        toolResultQueue.push({
          toolName: (inp.tool_name as string) ?? 'unknown',
          toolCallId: inp.tool_use_id as string | undefined,
          content: (inp.error as string) ?? 'tool failed',
          isError: true,
        })
        return { continue: true }
      }],
    }],
  }
}

function resolvePlugins(
  options?: SendQueryOptions,
): Array<{ type: 'local'; path: string }> | undefined {
  const disableSet = new Set(options?.disablePlugins ?? [])
  const autoDetected = getPluginSdkConfigs()
    .filter(p => !disableSet.has(path.basename(p.path)))

  const manual = options?.plugins ?? []
  const merged = [...autoDetected, ...manual]

  return merged.length > 0 ? merged : undefined
}

function toClaudeAgentDef(def: OctopusAgentDef): AgentDefinition {
  return {
    description: def.description,
    prompt: def.prompt,
    tools: def.tools,
    model: def.model,
    effort: def.effort,
    // SDK AgentDefinition (sdk.d.ts:38-101) accepts these — they used to be
    // silently dropped here, so agent frontmatter (maxTurns/background/skills)
    // never reached the SDK.
    skills: def.skills,
    maxTurns: def.maxTurns,
    background: def.background,
  } as AgentDefinition
}

/** Terminal-reason vocabulary per spec: derive from result subtype, NOT the
 *  SDK's raw terminal_reason (which spells the budget case 'budget_exhausted'). */
function goalTerminalReason(subtype: string): GoalTerminalReason | undefined {
  if (subtype === 'error_max_turns') return 'max_turns'
  if (subtype === 'error_max_budget_usd') return 'max_budget_usd'
  return undefined
}

/** Headless live path for /goal convergence evidence (ticket-03 finding):
 *  claude CLI 2.1.250 filters the top-level `active_goal` StdoutMessage out of
 *  headless stdout — the ONLY exit is a synthetic isMeta `user` message whose
 *  text is `Stop hook feedback:\n[<condition>]: <reason>`, emitted once per
 *  not-met (blocked) iteration. Returns null for anything else, including
 *  prefix-matching but unparsable text (caller keeps prior behavior). */
function parseStopHookFeedback(event: unknown): { condition: string; reason: string } | null {
  const um = event as { message?: { content?: unknown } }
  const content = um.message?.content
  let text: string | null = null
  if (typeof content === 'string') {
    text = content
  } else if (Array.isArray(content)) {
    const parts = content
      .filter((b): b is { type: 'text'; text: string } =>
        typeof b === 'object' && b !== null && (b as { type?: unknown }).type === 'text' &&
        typeof (b as { text?: unknown }).text === 'string')
    if (parts.length > 0) text = parts.map(p => p.text).join('\n')
  }
  if (!text || !text.startsWith('Stop hook feedback:')) return null
  // Condition may contain ':' and newlines — the separator is the FIRST ']: '
  // after the leading '[' (lazy group). A reason containing ']: ' therefore
  // parses correctly. Unparsable (no bracket form) → null → skip mapping.
  const m = /^Stop hook feedback:\n\[(.+?)\]: ([\s\S]*)$/s.exec(text)
  if (!m) return null
  return { condition: m[1], reason: m[2] }
}

/** Non-terminal-fidelity rule (walkthrough E): a non-success result must NOT
 *  flatten away the evidence the engine needs — num_turns / total_cost_usd /
 *  session_id / terminal-reason all survive into the error chunk. */
interface SDKResultErrorLike {
  subtype: string
  num_turns?: number
  total_cost_usd?: number
  session_id?: string
  terminal_reason?: string
  errors?: string[]
}

/** Interruptible stop: after `Query.interrupt()` the CLI still emits the
 *  interrupted turn's result (with usage for completed model calls). If that
 *  result has not arrived by this deadline the stop degrades to a hard abort.
 *  Kept below the server's STOP_SETTLE_MS (3000ms) so the stop endpoint never
 *  times out waiting for the drain. */
const INTERRUPT_DRAIN_MS = 2_000

/** 等 `run_in_background` 任务的看门狗预算。普通流的 300s 静默预算会把
 *  Maven / docker 构建误判成死流；后台任务在跑时改用这个（默认 60 分钟，
 *  仍留一个上限，避免 CLI 真挂死时会话永远不回来）。 */
const DEFAULT_BACKGROUND_WAIT_TIMEOUT_MS = 60 * 60_000

function buildResultErrorChunk(
  rm: SDKResultErrorLike,
  extra?: { usage?: TokenUsage; modelUsages?: ModelUsage[] },
): MessageChunk {
  return {
    type: 'error',
    code: rm.subtype,
    message: rm.errors?.join('; ') ?? 'unknown error',
    numTurns: rm.num_turns,
    costUsd: rm.total_cost_usd,
    sessionId: rm.session_id,
    terminalReason: goalTerminalReason(rm.subtype),
    sdkTerminalReason: rm.terminal_reason,
    // Interrupted / limited turns still carry real totals for every model call
    // that DID complete — dropping them is how chat stops used to lose usage.
    usage: extra?.usage,
    modelUsages: extra?.modelUsages,
  }
}

/** Streaming-input 模式下 CLI 会为**内部排队消息**（后台任务通知、队列确认等）
 *  先吐一个空 result：`num_turns=0`、无正文、无 usage。它不是宿主本轮用户消息
 *  的终点 —— 真正处理用户消息的模型轮次在这之后才开始。
 *
 *  2026-11-03 事故：用户在验收里说「通过」，上一轮留下的后台任务通知先产生空
 *  result，provider 当成收轮立即断开；真正的模型轮次（含 record_acceptance_check
 *  调用与回复）继续在 CLI 里跑完，但宿主已不再消费 —— 回复丢失、工具被自动拒绝、
 *  token 也没进账本。只有真正跑过模型轮的 result 才收轮。 */
interface EmptyResultAckLike {
  subtype: string
  result?: string
  num_turns?: number
  usage?: {
    input_tokens?: number
    output_tokens?: number
    cache_read_input_tokens?: number
    cache_creation_input_tokens?: number
  }
  modelUsage?: Record<string, unknown>
}

/**
 * 手动 /compact 的可见回执。
 *
 * 真机验证（SDK 0.3.235 · 2026-11-04）：压缩成功时 CLI 只发
 * `system:compact_boundary`，没有 assistant 消息，result 正文为空 —— 宿主若只
 * 透传正文，这一轮在对话里看起来什么都没发生。这里把 SDK 自己的 token 数字
 * 拼成一行回执；数字拿不到时退化为一句「已压缩」。
 */
function formatCompactReceipt(meta?: {
  pre_tokens?: number
  post_tokens?: number
  cumulative_dropped_tokens?: number
}): string {
  const fmt = (n?: number) =>
    typeof n === 'number' && Number.isFinite(n) ? n.toLocaleString('en-US') : undefined
  const pre = fmt(meta?.pre_tokens)
  const post = fmt(meta?.post_tokens)
  if (pre && post) return `上下文已压缩：${pre} → ${post} tokens`
  const dropped = fmt(meta?.cumulative_dropped_tokens)
  if (dropped) return `上下文已压缩（释放 ${dropped} tokens）`
  return '上下文已压缩'
}

function isEmptyResultAck(rm: EmptyResultAckLike): boolean {
  if (rm.subtype !== 'success') return false
  // num_turns 缺失时不认 —— 旧 CLI/本地命令可能不填，按原来的收轮语义走。
  if (rm.num_turns !== 0) return false
  if (typeof rm.result === 'string' && rm.result.trim().length > 0) return false
  if (rm.modelUsage && Object.keys(rm.modelUsage).length > 0) return false
  const u = rm.usage ?? {}
  const tokens =
    (u.input_tokens ?? 0) +
    (u.output_tokens ?? 0) +
    (u.cache_read_input_tokens ?? 0) +
    (u.cache_creation_input_tokens ?? 0)
  return tokens === 0
}

interface RawContentBlock {
  type?: string
  text?: string
  thinking?: string
  name?: string
  id?: string
  input?: unknown
  tool_use_id?: string
  content?: unknown
  is_error?: boolean
}

function stringifyToolContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part
        const block = part as RawContentBlock
        if (block?.type === 'text' && typeof block.text === 'string') return block.text
        return JSON.stringify(part)
      })
      .join('\n')
  }
  if (content === undefined || content === null) return ''
  return JSON.stringify(content)
}

/**
 * 把子代理的 assistant/user 消息内容转成与 chat 工具时间线同形的日志块。
 * 真机验证（SDK 0.3.235）：子代理消息没有 `stream_event` 增量流，整条到达。
 */
function toSubagentBlocks(content: unknown): SubagentLogBlock[] {
  const blocks: SubagentLogBlock[] = []
  if (typeof content === 'string') {
    if (content.length > 0) blocks.push({ kind: 'text', text: content })
    return blocks
  }
  if (!Array.isArray(content)) return blocks
  for (const raw of content) {
    const block = raw as RawContentBlock
    switch (block?.type) {
      case 'text':
        if (typeof block.text === 'string' && block.text.length > 0) blocks.push({ kind: 'text', text: block.text })
        break
      case 'thinking':
        if (typeof block.thinking === 'string' && block.thinking.length > 0) blocks.push({ kind: 'thinking', text: block.thinking })
        break
      case 'tool_use':
        blocks.push({ kind: 'tool_use', toolName: block.name, toolUseId: block.id, input: block.input })
        break
      case 'tool_result':
        blocks.push({
          kind: 'tool_result',
          toolUseId: block.tool_use_id,
          content: stringifyToolContent(block.content),
          isError: block.is_error === true,
        })
        break
    }
  }
  return blocks
}

export class ClaudeSDKProvider implements IAgentProvider {
  private _llmTracker = new LLMCallTracker()

  /** Resolve model tier alias to SDK-recognized name (e.g. "pro-max" → "opus", "pro" → "sonnet", "se" → "haiku") */
  private resolveModelName(model: string | undefined): string {
    if (!model) return 'sonnet'
    const config = loadModelAliasConfig()
    const resolved = resolveModelAlias(model, 'claude', config)
    return resolved ?? model
  }

  getLLMCalls() {
    return this._llmTracker.getAllCalls()
  }

  getType(): string {
    return 'claude'
  }

  async *sendQuery(
    prompt: string,
    cwd: string,
    resumeSessionId?: string,
    options?: SendQueryOptions
  ): AsyncGenerator<MessageChunk> {
    // ── [exec-timing] instrumentation (OCTOPUS_EXEC_TIMING=1) ──────────────
    // Attributes the per-node overhead: query() spawns a fresh CLI subprocess,
    // which must boot (settings/plugins/skills load) and read the resumed
    // session transcript before the first LLM round-trip. first_event_ms is the
    // subprocess boot + init cost we want to eliminate/overlap.
    const tEntry = Date.now()
    const timingOn = process.env.OCTOPUS_EXEC_TIMING === "1"
    let tFirstEvent = 0
    let tFirstMsgStart = 0
    let tInit = 0
    let firstEventDesc = ""
    const toolResultQueue: ToolResultEntry[] = []
    const pendingQuestions: PendingQuestion[] = []
    const pendingCompletions: PendingCompletion[] = []
    let currentMessageId = ""
    const blockTypes = new Map<number, 'thinking' | 'text' | 'tool_use'>()
    const pendingToolCalls = new Map<number, PendingToolCall>()
    // 后台任务电平（2026-11-04）：`run_in_background` 的 Bash / 子代理在首轮
    // result 之后仍在跑。SDK 会在它们结束时自动唤醒模型再跑一轮 —— 前提是宿主
    // 继续消费 query（`awaitBackgroundTasks`）。description 同时给 header/chat
    // 显示「在跑什么」。
    const backgroundTasks = new Map<string, BackgroundTaskInfo>()
    // 子代理（SDK Task/Agent 工具）—— 作业坞「子代理」入口的数据源（2026-11-04）。
    // 真机验证：子代理消息以 `parent_tool_use_id` 指回主 Agent 的 Agent 调用，
    // `task_started.tool_use_id` 是同一个 id；`task_id` 则是 transcript 的 agentId。
    interface LiveSubagent {
      parentToolUseId?: string
      agentType?: string
      description?: string
      prompt?: string
      model?: string
      ended: boolean
      /** 已经收到过 assistant 日志（用于识别并吞掉首条 user 指令回显）。 */
      logSeen: boolean
    }
    const liveSubagents = new Map<string, LiveSubagent>()
    const subagentIdByToolUseId = new Map<string, string>()
    const agentPromptByToolUseId = new Map<string, string>()
    // task_started 之前到达的子代理消息（罕见竞态）先按 Agent 调用 id 暂存。
    const pendingSubagentBlocks = new Map<string, SubagentLogBlock[]>()
    let sdkSessionId: string | undefined
    const modelName = this.resolveModelName(options?.model)
    this._llmTracker.reset()

    // Build canUseTool callback — ALWAYS active to enforce tool interception
    // even with permissionMode: 'bypassPermissions'.
    //
    // PreToolUse hooks are advisory when bypassPermissions is set — the SDK
    // ignores their deny decisions. canUseTool is the authoritative gate:
    // its deny is enforced regardless of permission mode.
    //
    // This callback integrates three concerns:
    // 1. onBeforeToolCall hook (harness tool interceptor for dangerous commands)
    // 2. Interaction session controls (AskUserQuestion, complete_interaction)
    // 3. Default allow for all other tools
    const canUseTool: CanUseTool | undefined = async (toolName, input, cbOptions) => {
      // 1. Harness tool interceptor — block dangerous shell commands
      if (options?.onBeforeToolCall) {
        const decision = await options.onBeforeToolCall(toolName, input)
        if (decision && decision.allow === false) {
          return {
            behavior: 'deny' as const,
            message: decision.reason ?? 'Tool call blocked by safety guard.',
            toolUseID: cbOptions.toolUseID,
          }
        }
      }

      // 2. Interaction session controls
      if (options?.interactionSession) {
        if (toolName === 'AskUserQuestion') {
          return {
            behavior: 'deny' as const,
            message: 'STOP. Question sent to user. User has NOT answered yet. Do NOT output any text. Do NOT guess any answer. Wait for the next user message.',
            toolUseID: cbOptions.toolUseID,
          }
        }
        if (toolName === 'complete_interaction') {
          return {
            behavior: 'deny' as const,
            message: 'Interaction completion has been captured and forwarded to the workflow engine. The interaction is now complete. Do not output anything else.',
            toolUseID: cbOptions.toolUseID,
          }
        }
      }

      return { behavior: 'allow' as const, updatedInput: input, toolUseID: cbOptions.toolUseID }
    }

    // Streaming input mode is what makes Query.interrupt() legal (the SDK only
    // supports real-time interruption there). Off for every non-chat caller.
    const interruptible = options?.interruptible === true
    const sdkAbort = new AbortController()

    const sdkOptions: Options = {
      cwd,
      model: modelName,
      systemPrompt: options?.systemPrompt ?? { type: 'preset', preset: 'claude_code' },
      // Do NOT set permissionMode: 'bypassPermissions' — it prevents canUseTool
      // from being called in SDK 0.2.141, silently disabling the harness tool
      // interceptor. Instead, default permission mode + canUseTool with
      // updatedInput handles both permission gating and tool interception.
      allowDangerouslySkipPermissions: true,
      settingSources: ['project', 'user'],
      includePartialMessages: true,
      // 子代理的完整对话（thinking / text / tool_use / tool_result）—— 作业坞要
      // 显示「像 chat 一样」的操作日志（2026-11-04）。默认只转发工具块。
      forwardSubagentText: true,
      hooks: buildToolCaptureHooks(toolResultQueue, pendingQuestions, pendingCompletions, options?.onBeforeToolCall),
      env: buildSubprocessEnv(options?.env as Record<string, string> | undefined),
      agent: options?.agent,
      skills: options?.skills,
      agents: options?.agents
        ? Object.fromEntries(
            Object.entries(options.agents).map(([k, v]) => [k, toClaudeAgentDef(v)])
          )
        : undefined,
      ...(options?.mcpServers
        ? { mcpServers: options.mcpServers as unknown as Options['mcpServers'] }
        : {}),
      plugins: resolvePlugins(options),
      tools: options?.tools,
      disallowedTools: options?.disallowedTools,
      maxTurns: options?.maxTurns,
      maxBudgetUsd: options?.maxBudgetUsd,
      ...(typeof options?.effort === 'string' ? { effort: options.effort as Options['effort'] } : {}),
      canUseTool,
      ...(interruptible || options?.abortSignal ? { abortController: sdkAbort } : {}),
      ...(resumeSessionId ? { resume: resumeSessionId } : {}),
    }

    // Streaming input mode keeps the query alive after its turn; the input
    // generator must stay open until we are done with it. Ending it early makes
    // the SDK close the query ("Query closed before response received").
    let releaseInput: (() => void) | undefined
    let promptInput: string | AsyncIterable<SDKUserMessage> = prompt
    if (interruptible) {
      const inputDone = new Promise<void>((resolve) => { releaseInput = resolve })
      promptInput = (async function* () {
        yield {
          type: 'user',
          message: { role: 'user', content: prompt },
          parent_tool_use_id: null,
        } as SDKUserMessage
        await inputDone
      })()
    }

    // Store query reference so we can call getContextUsage() (control request)
    // after message_start. The Query object is an AsyncGenerator with extra
    // methods (getContextUsage, interrupt, setModel, etc.) — only available
    // during the active stream.
    const q = query({ prompt: promptInput, options: sdkOptions })

    // Stop button. Interruptible queries ask the CLI to end the current turn
    // gracefully: the interrupted turn still emits its result, whose usage /
    // modelUsage carry every model call that DID complete (verified against the
    // real SDK 2026-10-31). A hard abort — the pre-existing behavior — kills the
    // subprocess before any result, which is why interrupted turns used to lose
    // all of their tokens. The deadline degrades to a hard abort if the CLI
    // never answers.
    let drainTimer: ReturnType<typeof setTimeout> | undefined
    const onAbort = () => {
      if (!interruptible) {
        sdkAbort.abort()
        return
      }
      // 「停止」= 整轮结束：先把后台任务收掉。只 interrupt 当前模型轮的话，
      // 后台 shell 还能继续跑，跑完还会唤醒会话（2026-11-04）。
      for (const task of backgroundTasks.values()) {
        try {
          if (typeof q.stopTask === 'function') {
            void Promise.resolve(q.stopTask(task.id)).catch(() => {})
          }
        } catch {
          // Best-effort — the interrupt below still settles the turn.
        }
      }
      // q.interrupt() 可能在 query 已关闭时同步抛错 —— 退化为硬 abort。
      try {
        void Promise.resolve(q.interrupt()).catch(() => { sdkAbort.abort() })
      } catch {
        sdkAbort.abort()
      }
      drainTimer = setTimeout(() => {
        try { sdkAbort.abort() } catch { /* already closed */ }
      }, INTERRUPT_DRAIN_MS)
      ;(drainTimer as unknown as { unref?: () => void }).unref?.()
    }
    if (options?.abortSignal) {
      if (options.abortSignal.aborted) onAbort()
      else options.abortSignal.addEventListener('abort', onAbort, { once: true })
    }
    let contextUsageEmitted = false
    // Slash commands (/context, /compact, /usage …) are executed by the CLI
    // itself: they arrive as a complete `assistant` message + `result` and
    // carry NO stream_event deltas (verified against SDK 0.3.235). Track which
    // message ids actually streamed so the assistant-event fallback below only
    // fires for that non-streaming case and never duplicates normal text.
    const streamedTextMessageIds = new Set<string>()
    const emittedAssistantFallbackIds = new Set<string>()
    // Per-session (per sendQuery) running count of stop-hook-feedback blocks,
    // 1-based — feeds ActiveGoalChunk.iterations; set_at = first-seen time.
    let goalIterations = 0
    let goalSetAt: number | undefined
    // 本地斜杠命令（/compact /clear …）的收尾信号。这些命令的 result 是
    // `num_turns: 0` + 空正文；/clear 连 modelUsage 都是空对象。isEmptyResultAck
    // 本是给「后台任务通知」这类排队确认用的，把这些命令的 result 也吞掉会让
    // 本轮永远等不到收轮（真机 2026-11-04：input 流不关，query 一直挂着）。
    let sawLocalCommandSignal = false
    // /compact 成功时 CLI 只发 compact_boundary、不产正文；SDK 的 token 数字先
    // 存着，等 result 确认正文为空再补成一条可见回执（result 有正文则让位）。
    let pendingCompactReceipt: string | undefined

    // P0-2 (2026-11-01): race every SDK demand against an idle deadline.
    // A wedged subprocess or a stalled transport can stop producing without
    // ever throwing; without this the chat SSE stays open forever and the
    // composer spins with no way back. The watchdog aborts the query first,
    // then we surface a structured IDLE_TIMEOUT chunk below.
    const guarded = guardIdle(q, {
      firstEventMs: options?.firstEventTimeoutMs ?? DEFAULT_FIRST_EVENT_TIMEOUT_MS,
      // 后台任务在跑时的静默是合法的（Maven/docker 构建）：用后台等待预算，
      // 普通流仍用 300s。函数形式每次等待前重读，任务结束立刻收回普通预算。
      idleMs: () => backgroundTasks.size > 0
        ? (options?.backgroundWaitTimeoutMs ?? DEFAULT_BACKGROUND_WAIT_TIMEOUT_MS)
        : (options?.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS),
      onTimeout: () => {
        try { sdkAbort.abort() } catch { /* already closed */ }
      },
    })

    let sawResult = false
    try {
      for await (const event of guarded) {

        // 子代理 token / 日志补全要用 SDK 会话 id 去读 transcript。
        // 始终跟随最新值 —— /clear 会换 session id，之后的子代理要落到新目录。
        const evSessionId = (event as { session_id?: string }).session_id
        if (evSessionId) sdkSessionId = evSessionId

        if (timingOn) {
          if (!tFirstEvent) {
            tFirstEvent = Date.now()
            const ev = event as { type?: string; subtype?: string }
            firstEventDesc = `${ev.type ?? "?"}${ev.subtype ? ":" + ev.subtype : ""}`
          }
          const ev2 = event as { type?: string; subtype?: string }
          if (ev2.type === 'system' && ev2.subtype === 'init') tInit = Date.now()
        }

        while (toolResultQueue.length > 0) {
          const tr = toolResultQueue.shift()!
          yield {
            type: 'tool_result',
            toolCallId: tr.toolCallId ?? tr.toolName,
            toolName: tr.toolName,
            content: tr.content,
            isError: tr.isError,
          }
        }

        while (pendingQuestions.length > 0) {
          const pq = pendingQuestions.shift()!
          yield {
            type: 'ask_user_question',
            toolCallId: pq.toolCallId,
            questions: pq.questions,
          }
        }

        while (pendingCompletions.length > 0) {
          const pc = pendingCompletions.shift()!
          yield {
            type: 'complete_interaction',
            toolCallId: pc.toolCallId,
            summary: pc.summary,
            vars_update: pc.vars_update,
          }
        }

        if (event.type === 'stream_event') {
          const e = (event as unknown as { event: SDKStreamEvent }).event

          if (e.type === 'message_start') {
            if (timingOn && !tFirstMsgStart) tFirstMsgStart = Date.now()
            currentMessageId = e.message?.id ?? `msg-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
            blockTypes.clear()
            // ★ 关键：用 SDK 返回的真实 model ID（e.message.model，例如 'claude-sonnet-4-5-20250827'），
            // 而非请求时的短别名（'sonnet'），保证和 result.modelUsage 的 key 能对上。
            // 不在 stream 阶段读 input_tokens：message_start.usage.input_tokens 包含 cache-reused tokens，
            // 会放大 5-10 倍。权威数据来自 result.modelUsage，由 calibrateFromModelUsage 填充。
            const actualModel = e.message?.model ?? modelName
            this._llmTracker.onMessageStart(currentMessageId, actualModel)
            yield { type: 'message_start', messageId: currentMessageId }

            // Fetch context window usage breakdown from the SDK (control request).
            // Only do this once per stream to avoid repeated calls on multi-turn
            // tool-use loops (message_start fires for each assistant message).
            if (!contextUsageEmitted) {
              contextUsageEmitted = true
              try {
                // Control request, outside the event stream — a hung transport
                // must not block the turn past the watchdog (P0-2).
                const ctxUsage = await withSoftTimeout(q.getContextUsage(), 5_000, 'CONTEXT_USAGE_TIMEOUT')
                yield { type: 'context_usage', data: ctxUsage }
              } catch {
                // getContextUsage may fail if the SDK subprocess doesn't support
                // it or the transport isn't streaming mode — non-fatal, skip.
              }
            }
          }

          else if (e.type === 'content_block_start') {
            const block = e.content_block!
            blockTypes.set(e.index!, block.type as 'thinking' | 'text' | 'tool_use')

            if (block.type === 'text') {
              // text block start — content is empty, wait for text_delta
            } else if (block.type === 'thinking') {
              this._llmTracker.onThinkingDelta()
              yield { type: 'thinking_start', messageId: currentMessageId }
              if (block.thinking) {
                yield { type: 'thinking', content: block.thinking, messageId: currentMessageId }
              }
            } else if (block.type === 'tool_use') {
              yield {
                type: 'tool_call_start',
                toolCallId: block.id!,
                toolName: block.name!,
                messageId: currentMessageId,
              }
              pendingToolCalls.set(e.index!, {
                id: block.id!,
                name: block.name!,
                partialJson: '',
              })
            }
          }

          else if (e.type === 'content_block_delta') {
            const delta = e.delta!
            if (delta.type === 'text_delta') {
              streamedTextMessageIds.add(currentMessageId)
              this._llmTracker.onTextDelta()
              yield { type: 'text_delta', content: delta.text!, messageId: currentMessageId }
            } else if (delta.type === 'thinking_delta') {
              this._llmTracker.onThinkingDelta()
              yield { type: 'thinking', content: delta.thinking!, messageId: currentMessageId }
            } else if (delta.type === 'signature_delta') {
              // ignore — thinking block signature, not readable
            } else if (delta.type === 'input_json_delta') {
              const pending = pendingToolCalls.get(e.index!)
              if (pending) {
                pending.partialJson += delta.partial_json ?? ''
              }
            }
          }

          else if (e.type === 'content_block_stop') {
            const blockType = blockTypes.get(e.index!)

            if (blockType === 'thinking') {
              yield { type: 'thinking_done', messageId: currentMessageId }
            } else if (blockType === 'text') {
              yield { type: 'text_done', messageId: currentMessageId }
            } else if (blockType === 'tool_use') {
              const pending = pendingToolCalls.get(e.index!)
              if (pending) {
                let toolInput: unknown = {}
                try {
                  toolInput = JSON.parse(pending.partialJson)
                } catch {
                  toolInput = pending.partialJson || {}
                }
                yield {
                  type: 'tool_call',
                  toolCallId: pending.id,
                  toolName: pending.name,
                  toolInput,
                  messageId: currentMessageId,
                }
                // 主 Agent 给子 Agent 的指令（task_started.prompt 的兜底源）。
                if (pending.name === 'Agent' && toolInput && typeof toolInput === 'object') {
                  const prompt = (toolInput as { prompt?: unknown }).prompt
                  if (typeof prompt === 'string' && prompt.trim()) {
                    agentPromptByToolUseId.set(pending.id, prompt)
                  }
                }
                pendingToolCalls.delete(e.index!)
              }
            }
          }

          else if (e.type === 'message_delta') {
            // message_delta.usage 携带本条消息的累计终值。实测（SDK 0.3.235）：
            // Σ per-turn == result.usage 逐字段相等，是运行中唯一可靠的 token 来源。
            // 直连 Anthropic 时可能只有 output_tokens，input/cache 按端点缺失 → defensive 读取。
            const rawU = e.usage
            const numOrUndef = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
            const usage: TokenUsageDelta | undefined = rawU
              ? {
                  inputTokens: numOrUndef(rawU.input_tokens),
                  outputTokens: numOrUndef(rawU.output_tokens),
                  cacheReadTokens: numOrUndef(rawU.cache_read_input_tokens),
                  cacheCreationTokens: numOrUndef(rawU.cache_creation_input_tokens),
                }
              : undefined
            this._llmTracker.onMessageDelta(e.delta?.stop_reason ?? '', usage)
            yield {
              type: 'message_delta',
              stopReason: e.delta?.stop_reason ?? '',
              outputTokens: usage?.outputTokens,
              usage,
              messageId: currentMessageId,
            }
          }

          else if (e.type === 'message_stop') {
            this._llmTracker.onMessageStop(currentMessageId)
            yield { type: 'message_stop', messageId: currentMessageId }
          }
        }

        else if (event.type === 'assistant') {
          // 子代理消息（parent_tool_use_id 非空）：不进主对话正文，转成子代理日志。
          const subagentMessage = event as {
            parent_tool_use_id?: string | null
            message?: { id?: string; model?: string; content?: unknown }
          }
          const subagentParentId = subagentMessage.parent_tool_use_id ?? undefined
          if (subagentParentId) {
            const blocks = toSubagentBlocks(subagentMessage.message?.content)
            if (blocks.length > 0) {
              const agentId = subagentIdByToolUseId.get(subagentParentId)
              if (!agentId) {
                const buffered = pendingSubagentBlocks.get(subagentParentId) ?? []
                buffered.push(...blocks)
                pendingSubagentBlocks.set(subagentParentId, buffered)
              } else {
                const live = liveSubagents.get(agentId)
                if (live) {
                  live.logSeen = true
                  if (subagentMessage.message?.model) live.model = subagentMessage.message.model
                }
                yield {
                  type: 'subagent',
                  event: {
                    id: agentId,
                    parentToolUseId: subagentParentId,
                    agentType: live?.agentType,
                    description: live?.description,
                    phase: 'log',
                    model: subagentMessage.message?.model ?? live?.model,
                    blocks,
                    sdkSessionId,
                  },
                }
              }
            }
            continue
          }
          // Do NOT use assistant event usage for token tracking —
          // input_tokens includes cache-reused tokens that inflate totals.
          // result.modelUsage has definitive totals.
          //
          // Text fallback for locally-executed slash commands: the CLI answers
          // /context, /compact, /usage … with a complete assistant message and
          // no stream deltas at all, so the streaming path above stays silent.
          // Emit that text once, only when this message never streamed.
          const am = event as {
            message?: { id?: string; content?: Array<{ type?: string; text?: string }> }
          }
          const msgId = am.message?.id ?? `slash-${Date.now()}`
          const text = Array.isArray(am.message?.content)
            ? am.message.content
                .filter((b) => b.type === 'text' && typeof b.text === 'string')
                .map((b) => b.text!)
                .join('')
            : ''
          if (text && !streamedTextMessageIds.has(msgId) && !emittedAssistantFallbackIds.has(msgId)) {
            emittedAssistantFallbackIds.add(msgId)
            yield { type: 'text_delta', content: text, messageId: msgId }
          }
        }

        else if (event.type === 'user') {
          // 子代理消息（parent_tool_use_id 非空）：工具结果 / 指令回显 → 子代理日志。
          const subagentUser = event as {
            parent_tool_use_id?: string | null
            message?: { content?: unknown }
          }
          const subagentParentId = subagentUser.parent_tool_use_id ?? undefined
          if (subagentParentId) {
            let blocks = toSubagentBlocks(subagentUser.message?.content)
            const agentId = subagentIdByToolUseId.get(subagentParentId)
            if (!agentId) {
              if (blocks.length > 0) {
                const buffered = pendingSubagentBlocks.get(subagentParentId) ?? []
                buffered.push(...blocks)
                pendingSubagentBlocks.set(subagentParentId, buffered)
              }
              continue
            }
            const live = liveSubagents.get(agentId)
            // 第一条 user 文本就是主 Agent 的指令回显 —— 指令另有 prompt 卡，不重复。
            if (!live?.logSeen && live?.prompt && blocks.every((b) => b.kind === 'text')) {
              const echoed = blocks.map((b) => b.text ?? '').join('').trim()
              if (echoed === live.prompt.trim()) blocks = []
            }
            if (blocks.length > 0) {
              yield {
                type: 'subagent',
                event: {
                  id: agentId,
                  parentToolUseId: subagentParentId,
                  agentType: live?.agentType,
                  description: live?.description,
                  phase: 'log',
                  blocks,
                  sdkSessionId,
                },
              }
            }
            continue
          }
          // Headless LIVE path for /goal evidence: the evaluator's not-met
          // (block) verdict surfaces only as a synthetic isMeta user message
          // "Stop hook feedback:\n[<condition>]: <reason>". Map it to the same
          // ActiveGoalChunk shape as the forward-compat StdoutMessage branch
          // below; anything else (plain text, tool_result, unparsable) keeps the
          // old drop-and-continue behavior.
          const feedback = parseStopHookFeedback(event)
          if (feedback) {
            goalIterations += 1
            if (goalSetAt === undefined) goalSetAt = Date.now()
            yield {
              type: 'active_goal',
              condition: feedback.condition,
              iterations: goalIterations,
              last_reason: feedback.reason,
              set_at: goalSetAt,
            }
          }
          continue
        }

        else if (event.type === 'tool_progress') {
          const tp = event as { tool_use_id: string; elapsed_time_seconds: number }
          yield {
            type: 'tool_progress',
            toolCallId: tp.tool_use_id,
            elapsedSeconds: tp.elapsed_time_seconds,
          }
        }

        else if (event.type === 'tool_use_summary') {
          const ts = event as { summary: string; preceding_tool_use_ids: string[] }
          yield {
            type: 'tool_summary',
            summary: ts.summary,
            toolCallIds: ts.preceding_tool_use_ids,
          }
        }

        else if (event.type === 'system') {
          const sm = event as {
            subtype: string
            status?: 'compacting' | 'requesting' | 'completed' | 'failed' | 'stopped' | null
            content?: string
            claude_code_version?: string
            model?: string
            cwd?: string
            permissionMode?: string
            output_style?: string
            apiKeySource?: string
            effort?: string | null
            tools?: string[]
            mcp_servers?: { name: string; status: string }[]
            agents?: string[]
            skills?: string[]
            plugins?: { name: string; path: string; version?: string }[]
            slash_commands?: string[]
            terminal_slash_commands?: string[]
            capabilities?: string[]
            betas?: string[]
            /** background_tasks_changed：电平信号，REPLACE 语义。 */
            tasks?: Array<{ task_id?: string; task_type?: string; description?: string }>
            /** task_started / task_updated / task_notification 的边沿字段。 */
            task_id?: string
            tool_use_id?: string
            description?: string
            task_type?: string
            /** 子代理类型（Task/Agent 工具）；background bash 任务没有。 */
            subagent_type?: string
            /** 主 Agent 给子代理的完整指令（task_started）。 */
            prompt?: string
            /** task_notification：子代理的最终汇报。 */
            summary?: string
            last_tool_name?: string
            usage?: { total_tokens?: number; tool_uses?: number; duration_ms?: number }
            patch?: { status?: 'pending' | 'running' | 'completed' | 'failed' | 'killed' | 'paused' }
            /** compact_boundary：压缩完成后的 token 账（SDK 自己的口径）。 */
            compact_metadata?: {
              trigger?: 'manual' | 'auto'
              pre_tokens?: number
              post_tokens?: number
              cumulative_dropped_tokens?: number
              duration_ms?: number
            }
          }
          if (sm.subtype === 'status') {
            yield {
              type: 'status',
              status: (sm.status ?? null) as 'compacting' | 'requesting' | null,
            }
          } else if (sm.subtype === 'background_tasks_changed') {
            // 电平信号：用 payload 整体替换。空数组 = 后台任务全部结束，
            // 紧接着 CLI 会唤醒模型跑第二轮。
            backgroundTasks.clear()
            for (const t of sm.tasks ?? []) {
              if (!t.task_id) continue
              backgroundTasks.set(t.task_id, {
                id: t.task_id,
                description: t.description?.trim() || t.task_id,
                taskType: t.task_type,
              })
            }
            yield { type: 'background_tasks', tasks: [...backgroundTasks.values()] }
          } else if (sm.subtype === 'task_started') {
            // 子代理出生（真机 0.3.235：task_type='local_agent' + subagent_type）。
            // `task_id` 是 transcript 的 agentId，`tool_use_id` 是主 Agent 的 Agent 调用。
            const isSubagent = !!sm.subagent_type || sm.task_type === 'local_agent'
            if (isSubagent && sm.task_id) {
              const agentId = sm.task_id
              const prompt = sm.prompt?.trim()
                || (sm.tool_use_id ? agentPromptByToolUseId.get(sm.tool_use_id) : undefined)
              const live: LiveSubagent = {
                parentToolUseId: sm.tool_use_id,
                agentType: sm.subagent_type,
                description: sm.description?.trim() || agentId,
                prompt,
                ended: false,
                logSeen: false,
              }
              liveSubagents.set(agentId, live)
              if (sm.tool_use_id) subagentIdByToolUseId.set(sm.tool_use_id, agentId)
              yield {
                type: 'subagent',
                event: {
                  id: agentId,
                  parentToolUseId: sm.tool_use_id,
                  agentType: sm.subagent_type,
                  description: live.description,
                  prompt,
                  phase: 'started',
                  status: 'running',
                  sdkSessionId,
                },
              }
              // 先于 task_started 到达的子代理消息在这里补发。
              const buffered = sm.tool_use_id ? pendingSubagentBlocks.get(sm.tool_use_id) : undefined
              if (buffered && buffered.length > 0 && sm.tool_use_id) {
                pendingSubagentBlocks.delete(sm.tool_use_id)
                live.logSeen = true
                yield {
                  type: 'subagent',
                  event: {
                    id: agentId,
                    parentToolUseId: sm.tool_use_id,
                    agentType: sm.subagent_type,
                    description: live.description,
                    phase: 'log',
                    blocks: buffered,
                    sdkSessionId,
                  },
                }
              }
            }
            // 后台任务电平：只刷新已经登记的后台任务。前台子代理也发
            // task_started —— 把它塞进 backgroundTasks 会让收轮后误判「还有
            // 后台任务在跑」而继续挂着（真机 2026-11-04）。
            if (sm.task_id && (sm.task_type !== 'local_agent' || backgroundTasks.has(sm.task_id))) {
              const description = sm.description?.trim() || sm.task_id
              const prev = backgroundTasks.get(sm.task_id)
              if (!prev || prev.description !== description) {
                backgroundTasks.set(sm.task_id, { id: sm.task_id, description, taskType: sm.task_type })
                yield { type: 'background_tasks', tasks: [...backgroundTasks.values()] }
              }
            }
          } else if (sm.subtype === 'task_progress') {
            // 子代理进度（当前工具 / 步数 / 时长）。
            // 注意不要用 task_progress.description 覆盖标题：它是进度短语
            // （「Running echo ...」），会把人话描述盖掉（真机 2026-11-04）。
            if (sm.task_id && liveSubagents.has(sm.task_id)) {
              const live = liveSubagents.get(sm.task_id)!
              yield {
                type: 'subagent',
                event: {
                  id: sm.task_id,
                  parentToolUseId: live.parentToolUseId,
                  agentType: live.agentType,
                  description: live.description,
                  phase: 'progress',
                  status: 'running',
                  lastToolName: sm.last_tool_name,
                  toolUses: sm.usage?.tool_uses,
                  durationMs: sm.usage?.duration_ms,
                  sdkSessionId,
                },
              }
            }
          } else if (sm.subtype === 'task_updated') {
            const status = sm.patch?.status
            const terminal = status === 'completed' || status === 'failed' || status === 'killed'
            if (terminal && sm.task_id && liveSubagents.has(sm.task_id)) {
              const live = liveSubagents.get(sm.task_id)!
              live.ended = true
              yield {
                type: 'subagent',
                event: {
                  id: sm.task_id,
                  parentToolUseId: live.parentToolUseId,
                  agentType: live.agentType,
                  description: live.description,
                  phase: 'completed',
                  status: status === 'completed' ? 'completed' : status === 'killed' ? 'killed' : 'failed',
                  model: live.model,
                  sdkSessionId,
                },
              }
            }
            if (terminal && sm.task_id && backgroundTasks.delete(sm.task_id)) {
              yield { type: 'background_tasks', tasks: [...backgroundTasks.values()] }
            }
          } else if (sm.subtype === 'task_notification') {
            // 子代理完成：这里才带最终汇报（summary）和步数/时长。
            if (sm.task_id && liveSubagents.has(sm.task_id)) {
              const live = liveSubagents.get(sm.task_id)!
              live.ended = true
              yield {
                type: 'subagent',
                event: {
                  id: sm.task_id,
                  parentToolUseId: live.parentToolUseId,
                  agentType: live.agentType,
                  description: live.description,
                  phase: 'completed',
                  status: sm.status === 'completed' ? 'completed' : sm.status === 'stopped' ? 'killed' : 'failed',
                  summary: sm.summary || undefined,
                  model: live.model,
                  toolUses: sm.usage?.tool_uses,
                  durationMs: sm.usage?.duration_ms,
                  sdkSessionId,
                },
              }
            }
            if (sm.task_id && backgroundTasks.delete(sm.task_id)) {
              yield { type: 'background_tasks', tasks: [...backgroundTasks.values()] }
            }
          } else if (sm.subtype === 'compact_boundary') {
            // 立即刷新占用；auto 压缩也走这里，让角标同样回落。
            try {
              const ctxUsage = await withSoftTimeout(q.getContextUsage(), 5_000, 'CONTEXT_USAGE_TIMEOUT')
              contextUsageEmitted = true
              yield { type: 'context_usage', data: ctxUsage }
            } catch {
              // 非致命：下一轮 message_start 仍会补报真实占用。
            }
            // 只有手动 /compact 是「一条命令一整轮」：它的空 result 不能再被
            // 当成排队确认（否则收不了轮）。auto 压缩发生在正常轮次里，排队
            // 确认的语义不能被抢走。
            if (sm.compact_metadata?.trigger === 'manual') {
              sawLocalCommandSignal = true
              pendingCompactReceipt = formatCompactReceipt(sm.compact_metadata)
            }
          } else if (sm.subtype === 'local_command_output') {
            sawLocalCommandSignal = true
            yield { type: 'local_command_output', content: sm.content ?? '' }
          } else if (sm.subtype === 'init') {
            // Full init snapshot first: the debug inspector needs what the CLI
            // actually loaded (tools / MCP status / skills / plugins /
            // permission mode), not just the command menu.
            const init: SystemInitData = {
              claudeCodeVersion: sm.claude_code_version,
              model: sm.model,
              cwd: sm.cwd,
              permissionMode: sm.permissionMode,
              outputStyle: sm.output_style,
              apiKeySource: sm.apiKeySource,
              effort: sm.effort ?? null,
              tools: Array.isArray(sm.tools) ? sm.tools : [],
              mcpServers: Array.isArray(sm.mcp_servers) ? sm.mcp_servers : [],
              agents: Array.isArray(sm.agents) ? sm.agents : [],
              skills: Array.isArray(sm.skills) ? sm.skills : [],
              plugins: Array.isArray(sm.plugins) ? sm.plugins : [],
              slashCommands: Array.isArray(sm.slash_commands) ? sm.slash_commands : [],
              capabilities: Array.isArray(sm.capabilities) ? sm.capabilities : [],
              betas: Array.isArray(sm.betas) ? sm.betas : [],
            }
            yield { type: 'system_init', data: init }
            if (Array.isArray(sm.slash_commands)) {
              // The advertised set is CLI/skills-dependent — hosts replace their
              // cached list with this. Terminal-bound commands (exit, statusline…)
              // are useless in a headless host and are dropped here.
              const terminal = new Set(sm.terminal_slash_commands ?? [])
              yield {
                type: 'slash_commands',
                commands: sm.slash_commands.filter((name) => !terminal.has(name)),
              }
            }
          }
        }

        else if ((event as { type: string }).type === 'conversation_reset') {
          // `/clear`: the CLI dropped its transcript and restarted the session.
          // Host-side history is ours to keep (semantics A) — the chunk only
          // tells the host to forget the provider session pointer.
          // 它的 result 是 num_turns=0 + 空 modelUsage，属于本地命令收尾，
          // 不能被 isEmptyResultAck 当成排队确认（真机 2026-11-04 验证）。
          sawLocalCommandSignal = true
          yield { type: 'conversation_reset' }
        }

        else if ((event as { type: string }).type === 'active_goal') {
          // FORWARD-COMPAT only: SDKActiveGoalMessage is a member of the
          // internal StdoutMessage union (sdk.d.ts:7764) and sdk.mjs readMessages
          // has an enqueue branch, but claude CLI 2.1.250's stdout write predicate
          // unconditionally EXCLUDES type 'active_goal' — headless never emits it
          // (ticket-03 root cause, binary-verified; --include-hook-events /
          // --include-partial-messages do not help). The LIVE path under the
          // current CLI is the stop-hook-feedback mapping in the `user` branch.
          // Keep this branch for future CLIs that restore the message.
          // `value` is null when the goal is cleared (evaluator reported met):
          // pass condition: null.
          const ag = event as unknown as { value: { condition: string; iterations: number; set_at: number; tokens_at_start: number; last_reason?: string } | null }
          if (ag.value === null) {
            yield { type: 'active_goal', condition: null, iterations: 0 }
          } else {
            yield {
              type: 'active_goal',
              condition: ag.value.condition,
              iterations: ag.value.iterations,
              last_reason: ag.value.last_reason,
              set_at: ag.value.set_at,
            }
          }
        }

        else if (event.type === 'result') {
          if (timingOn) {
            console.log(`[exec-timing] provider-query ${JSON.stringify({
              tag: options?.timingTag ?? "",
              model: modelName,
              resumed: !!resumeSessionId,
              t_entry: tEntry,
              first_event: firstEventDesc,
              boot_ms: tFirstEvent ? tFirstEvent - tEntry : undefined,
              init_ms: tInit ? tInit - tEntry : undefined,
              first_msg_ms: tFirstMsgStart ? tFirstMsgStart - tEntry : undefined,
              result_ms: Date.now() - tEntry,
            })}`)
          }
          const rm = event as { subtype: string; session_id?: string; result?: string; num_turns?: number; usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }; total_cost_usd?: number; errors?: string[]; modelUsage?: Record<string, { inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number; costUSD?: number }> }
          // 空 result = CLI 在确认内部排队消息，不是本轮终点：继续消费，等真正
          // 跑过模型轮的 result（见 isEmptyResultAck 上的事故说明）。空闲看门狗
          // 仍兜底真正挂死的流。本地命令（/clear、/compact）的空 result 是真正
          // 的收轮信号，不能吞（见 sawLocalCommandSignal）。
          if (isEmptyResultAck(rm) && !sawLocalCommandSignal) {
            console.warn(
              `[claude-provider] empty result ack (num_turns=0) — keep consuming` +
                (resumeSessionId ? ` · resume ${resumeSessionId.slice(0, 8)}` : ''),
            )
            continue
          }
          // /compact 成功的 result 正文为空（真机 2026-11-04）。把 boundary 里
          // SDK 给出的 token 数字补成一条回执，否则这一轮在对话里完全不可见。
          // 给未来版本留位：result 自带正文时不重复补。
          if (pendingCompactReceipt) {
            if (!rm.result?.trim()) {
              yield { type: 'local_command_output', content: pendingCompactReceipt }
            }
            pendingCompactReceipt = undefined
          }
          // result.modelUsage is the ONLY authoritative source of per-model token totals.
          // SDK snake/原始 key → 规范 ModelUsage 的转换只发生在这里（seam adapter）。
          if (rm.modelUsage && Object.keys(rm.modelUsage).length > 0) {
            const modelUsages: ModelUsage[] = Object.entries(rm.modelUsage).map(([model, mu]) => ({
              model,
              inputTokens: mu.inputTokens ?? 0,
              outputTokens: mu.outputTokens ?? 0,
              cacheReadTokens: mu.cacheReadInputTokens ?? 0,
              cacheCreationTokens: mu.cacheCreationInputTokens ?? 0,
              // C2：SDK 对不认识的模型（代理 qwen 等）给 costUSD=0 —— 0 是假实测，
              // seam 处归一为 undefined（未定价），把估算机会让给 shared 价表
              costUsd: mu.costUSD || undefined,
            }))
            // Calibrate tracker's completed calls with authoritative token data
            this._llmTracker.calibrateFromModelUsage(modelUsages)
            if (rm.subtype === 'success') {
              yield {
                type: 'result',
                content: rm.result,
                sessionId: rm.session_id,
                // 规范口径：纯值四字段合计（不再把 cache 折进 input）
                usage: mergeModelUsages(modelUsages),
                // 0 = SDK 不认识该模型（代理/未定价）→ 归一为未定价，非 $0 实测
                costUsd: rm.total_cost_usd || undefined,
                numTurns: rm.num_turns,
                modelUsages,
              }
            } else {
              yield buildResultErrorChunk(rm, {
                usage: mergeModelUsages(modelUsages),
                modelUsages,
              })
            }
          } else {
            // Fallback: no modelUsage — use legacy single-model usage from result
            const fallbackModelUsage: ModelUsage = {
              model: modelName,
              inputTokens: rm.usage?.input_tokens ?? 0,
              outputTokens: rm.usage?.output_tokens ?? 0,
              cacheReadTokens: rm.usage?.cache_read_input_tokens ?? 0,
              cacheCreationTokens: rm.usage?.cache_creation_input_tokens ?? 0,
            }
            const hasAny = fallbackModelUsage.outputTokens > 0 || fallbackModelUsage.cacheReadTokens > 0 || fallbackModelUsage.cacheCreationTokens > 0
            if (hasAny) {
              this._llmTracker.calibrateFromModelUsage([fallbackModelUsage])
            }
            if (rm.subtype === 'success') {
              yield {
                type: 'result',
                content: rm.result,
                sessionId: rm.session_id,
                usage: fallbackModelUsage,
                costUsd: rm.total_cost_usd,
                numTurns: rm.num_turns,
                modelUsages: (fallbackModelUsage.inputTokens > 0 || fallbackModelUsage.outputTokens > 0)
                  ? [fallbackModelUsage]
                  : [],
              }
            } else {
              yield buildResultErrorChunk(rm, {
                usage: fallbackModelUsage,
                modelUsages: (fallbackModelUsage.inputTokens > 0 || fallbackModelUsage.outputTokens > 0)
                  ? [fallbackModelUsage]
                  : [],
              })
            }
          }
          sawResult = true
          // A streaming-input query stays alive after its turn (the session is
          // persistent) — end our consumption here so the caller's loop closes.
          //
          // 2026-11-04 事故：chat 用 Bash `run_in_background` 起服务就绪轮询，
          // 模型收轮说「就绪后我直接跑」，宿主却在首轮 result 处 break →
          // releaseInput() 关掉输入流 → CLI 退出 → 后台任务和它的唤醒一起消失，
          // 用户必须再发一条消息。开着 awaitBackgroundTasks 且有后台任务时
          // 继续消费：SDK 在任务结束时会自己唤醒模型，后续轮次走同一迭代器。
          if (options?.awaitBackgroundTasks && interruptible && backgroundTasks.size > 0) {
            continue
          }
          break
        }
      }
    } catch (err) {
      // P0-2: the watchdog already aborted the query. Surface a structured
      // chunk (not a throw) so the chat route can settle the turn with an
      // error frame and a persisted error row instead of dropping the socket.
      if (err instanceof IdleTimeoutError) {
        yield {
          type: 'error',
          code: err.code,
          message: err.message,
          sdkTerminalReason: 'idle_timeout',
        }
        return
      }
      // The SDK throws after yielding an error result (single-message mode)
      // and after a clean interrupt once the input stream closes. The result
      // chunk was already forwarded — only rethrow when none was seen.
      if (!sawResult) throw err
    } finally {
      options?.abortSignal?.removeEventListener('abort', onAbort)
      if (drainTimer) clearTimeout(drainTimer)
      releaseInput?.()
    }

    while (toolResultQueue.length > 0) {
      const tr = toolResultQueue.shift()!
      yield {
        type: 'tool_result',
        toolCallId: tr.toolCallId ?? tr.toolName,
        toolName: tr.toolName,
        content: tr.content,
        isError: tr.isError,
      }
    }
  }
}