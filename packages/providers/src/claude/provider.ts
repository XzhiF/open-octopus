import { query, type Options, type AgentDefinition, type CanUseTool } from '@anthropic-ai/claude-agent-sdk'
import type { IAgentProvider, SendQueryOptions, MessageChunk, TokenUsage, ModelUsageEntry, OctopusAgentDef, GoalTerminalReason } from '../types'
import { LLMCallTracker } from '../llm-call-tracker'
import { getPluginSdkConfigs, loadModelAliasConfig, resolveModelAlias } from '@octopus/shared'
import fs from 'fs'
import path from 'path'
import os from 'os'

interface SDKStreamEvent {
  type: string
  message?: { id: string; model?: string; usage?: { output_tokens?: number; input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }; stop_reason?: string }
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

function normalizeUsage(usage?: {
  input_tokens?: number
  output_tokens?: number
}): TokenUsage | undefined {
  if (!usage || typeof usage.input_tokens !== 'number' || typeof usage.output_tokens !== 'number') {
    return undefined
  }
  return { input: usage.input_tokens, output: usage.output_tokens, total: usage.input_tokens + usage.output_tokens }
}

function buildToolCaptureHooks(
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

/** Non-terminal-fidelity rule (walkthrough E): a non-success result must NOT
 *  flatten away the evidence the engine needs — num_turns / total_cost_usd /
 *  session_id / terminal-reason all survive into the error chunk. */
interface SDKResultErrorLike {
  subtype: string
  num_turns?: number
  total_cost_usd?: number
  session_id?: string
  errors?: string[]
}

function buildResultErrorChunk(rm: SDKResultErrorLike): MessageChunk {
  return {
    type: 'error',
    code: rm.subtype,
    message: rm.errors?.join('; ') ?? 'unknown error',
    numTurns: rm.num_turns,
    costUsd: rm.total_cost_usd,
    sessionId: rm.session_id,
    terminalReason: goalTerminalReason(rm.subtype),
  }
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
    const toolResultQueue: ToolResultEntry[] = []
    const pendingQuestions: PendingQuestion[] = []
    const pendingCompletions: PendingCompletion[] = []
    let currentMessageId = ""
    const blockTypes = new Map<number, 'thinking' | 'text' | 'tool_use'>()
    const pendingToolCalls = new Map<number, PendingToolCall>()
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
      hooks: buildToolCaptureHooks(toolResultQueue, pendingQuestions, pendingCompletions, options?.onBeforeToolCall),
      env: buildSubprocessEnv(options?.env as Record<string, string> | undefined),
      agent: options?.agent,
      skills: options?.skills,
      agents: options?.agents
        ? Object.fromEntries(
            Object.entries(options.agents).map(([k, v]) => [k, toClaudeAgentDef(v)])
          )
        : undefined,
      plugins: resolvePlugins(options),
      tools: options?.tools,
      disallowedTools: options?.disallowedTools,
      maxTurns: options?.maxTurns,
      maxBudgetUsd: options?.maxBudgetUsd,
      ...(typeof options?.effort === 'string' ? { effort: options.effort as Options['effort'] } : {}),
      canUseTool,
      ...(options?.abortSignal ? { abortController: new AbortController() } : {}),
      ...(resumeSessionId ? { resume: resumeSessionId } : {}),
    }

    if (options?.abortSignal) {
      options.abortSignal.addEventListener('abort', () => {
        sdkOptions.abortController?.abort()
      }, { once: true })
    }

    // Store query reference so we can call getContextUsage() (control request)
    // after message_start. The Query object is an AsyncGenerator with extra
    // methods (getContextUsage, setModel, etc.) — only available during the
    // active stream.
    const q = query({ prompt, options: sdkOptions })
    let contextUsageEmitted = false

    for await (const event of q) {

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
              const ctxUsage = await q.getContextUsage()
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
              pendingToolCalls.delete(e.index!)
            }
          }
        }

        else if (e.type === 'message_delta') {
          // 不在 stream 阶段读 output_tokens：SDK 的字段路径在历史版本中有过变更
          // （曾经 e.usage.output_tokens，曾经 e.message.usage.output_tokens），
          // 且即使读对也不是权威数据。权威数据来自 result.modelUsage。
          this._llmTracker.onMessageDelta(e.delta?.stop_reason ?? '')
          yield {
            type: 'message_delta',
            stopReason: e.delta?.stop_reason ?? '',
            outputTokens: undefined,
            messageId: currentMessageId,
          }
        }

        else if (e.type === 'message_stop') {
          this._llmTracker.onMessageStop(currentMessageId)
          yield { type: 'message_stop', messageId: currentMessageId }
        }
      }

      else if (event.type === 'assistant') {
        // Do NOT use assistant event usage for token tracking —
        // input_tokens includes cache-reused tokens that inflate totals.
        // result.modelUsage has definitive totals.
      }

      else if (event.type === 'user') {
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
        const sm = event as { subtype: string; status?: 'compacting' | 'requesting' | null; content?: string }
        if (sm.subtype === 'status') {
          yield { type: 'status', status: sm.status ?? null }
        } else if (sm.subtype === 'compact_boundary') {
          yield { type: 'status', status: 'compacting' }
        } else if (sm.subtype === 'local_command_output') {
          yield { type: 'local_command_output', content: sm.content ?? '' }
        }
      }

      else if ((event as { type: string }).type === 'active_goal') {
        // SDKActiveGoalMessage is emitted by query() at runtime (sdk.mjs
        // readMessages: `e.type==="active_goal"` → enqueued) and is a member
        // of the internal StdoutMessage union (sdk.d.ts:7764), but NOT of the
        // public SDKMessage TS union — hence the cast. `value` is null when
        // the goal is cleared (evaluator reported met): pass condition: null.
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
        const rm = event as { subtype: string; session_id?: string; result?: string; num_turns?: number; usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }; total_cost_usd?: number; errors?: string[]; modelUsage?: Record<string, { inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number; costUSD?: number }> }
        // result.modelUsage is the ONLY authoritative source of per-model token totals
        if (rm.modelUsage && Object.keys(rm.modelUsage).length > 0) {
          // Calibrate tracker's completed calls with authoritative token data
          this._llmTracker.calibrateFromModelUsage(rm.modelUsage)

          const modelUsages: ModelUsageEntry[] = []
          for (const [model, mu] of Object.entries(rm.modelUsage)) {
            const inputTokens = mu.inputTokens ?? 0
            const outputTokens = mu.outputTokens ?? 0
            const cacheReadInputTokens = mu.cacheReadInputTokens ?? 0
            const cacheCreationInputTokens = mu.cacheCreationInputTokens ?? 0
            modelUsages.push({ model, inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens, costUsd: mu.costUSD })
          }
          if (rm.subtype === 'success') {
            const totalInput = Object.values(rm.modelUsage).reduce((s, mu) => s + (mu.inputTokens ?? 0) + (mu.cacheReadInputTokens ?? 0) + (mu.cacheCreationInputTokens ?? 0), 0)
            const totalOutput = Object.values(rm.modelUsage).reduce((s, mu) => s + (mu.outputTokens ?? 0), 0)
            yield {
              type: 'result',
              content: rm.result,
              sessionId: rm.session_id,
              tokens: { input: totalInput, output: totalOutput, total: totalInput + totalOutput },
              costUsd: rm.total_cost_usd,
              modelUsages,
            }
          } else {
            yield buildResultErrorChunk(rm)
          }
        } else {
          // Fallback: no modelUsage — use legacy single-model usage from result
          const rawInput = rm.usage?.input_tokens ?? 0
          const cacheRead = rm.usage?.cache_read_input_tokens ?? 0
          const cacheCreation = rm.usage?.cache_creation_input_tokens ?? 0
          const finalInput = rawInput + cacheRead + cacheCreation
          const finalOutput = rm.usage?.output_tokens ?? 0

          // Calibrate tracker with fallback usage data
          if (finalOutput > 0 || cacheRead > 0 || cacheCreation > 0) {
            this._llmTracker.calibrateFromModelUsage({
              [modelName]: {
                inputTokens: rawInput,
                outputTokens: finalOutput,
                cacheReadInputTokens: cacheRead,
                cacheCreationInputTokens: cacheCreation,
              },
            })
          }

          const fallbackModelUsages: ModelUsageEntry[] = (rawInput > 0 || finalOutput > 0)
            ? [{ model: modelName, inputTokens: rawInput, outputTokens: finalOutput, cacheReadInputTokens: cacheRead, cacheCreationInputTokens: cacheCreation }]
            : []
          if (rm.subtype === 'success') {
            yield {
              type: 'result',
              content: rm.result,
              sessionId: rm.session_id,
              tokens: { input: finalInput, output: finalOutput, total: finalInput + finalOutput },
              costUsd: rm.total_cost_usd,
              modelUsages: fallbackModelUsages,
            }
          } else {
            yield buildResultErrorChunk(rm)
          }
        }
      }
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