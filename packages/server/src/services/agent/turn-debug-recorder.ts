// Per-turn SDK debug recorder (dock 「调试」).
//
// The chat route is the only place that knows what was ACTUALLY sent to the
// provider: the raw user message, the provider message after the role card /
// transient reminders were appended, the frozen system-prompt append, and the
// sendQuery options. It is also the only place that sees the SDK's
// `system:init` and `getContextUsage()` chunks. None of that survives in any
// other table, so it is written once per turn here.
//
// This is observability, never a chat dependency: every write is best-effort
// and a failure must not break the turn.

import crypto from "crypto"
import type { ContextUsageData, MessageChunk, SystemInitData } from "@octopus/providers"
import type { SessionTurnDebugDAO } from "../db/dao/session-turn-debug-dao"

export type TurnDebugStatus = "running" | "ok" | "interrupted" | "error"

export interface TurnDebugIdentity {
  id: string | null
  kind: "base" | "clone" | "expert"
  name: string
  revision: number
  skills?: string[]
  memoryScope?: string
}

export interface TurnDebugEvent {
  /** Milliseconds from turn start. */
  off: number
  type: "init" | "llm" | "tool" | "res" | "err" | "sys"
  label: string
  det?: string
  sub?: string
}

export interface TurnDebugUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  totalTokens: number
  /** Derived from the ledger's costed view at read time — never stored. */
  costUsd?: number | null
  /** false when at least one matched ledger row has no price (show ≈). */
  costComplete?: boolean
  models?: Array<{
    model: string | null
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheCreationTokens: number
  }>
}

export interface StartTurnDebugInput {
  dao: SessionTurnDebugDAO
  sessionId: string
  /** Transcript turn number. Falls back to the recorder-local sequence when
   *  the caller cannot resolve it (e.g. ephemeral wake turns). */
  turnIndex?: number
  userMessageId: string | null
  identity: TurnDebugIdentity
  roleCard: string | null
  roleRevision: number
  model: string | null
  effort: string | null
  cwd: string
  providerMessage: string
  systemPrompt: string
  systemPromptHash: string | null
  sdkOptions: Record<string, unknown>
}

const MAX_TEXT = 200_000
const MAX_EVENTS = 300

/** Conservative local redaction — debug snapshots are plaintext on disk. */
export function redactSecrets(text: string): string {
  return text
    .replace(/\b(sk-ant-[A-Za-z0-9_-]{8,})\b/g, "sk-ant-•••")
    .replace(/\b(sk-[A-Za-z0-9_-]{16,})\b/g, "sk-•••")
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi, "$1•••")
    .replace(
      /\b((?:api[_-]?key|access[_-]?token|auth[_-]?token|secret|password)\s*[:=]\s*["']?)[^\s"'`,;]{8,}/gi,
      "$1•••",
    )
}

function cap(text: string | null | undefined, max = MAX_TEXT): string | null {
  if (text == null) return null
  return text.length > max ? `${text.slice(0, max)}\n…（已截断 ${text.length - max} 字符）` : text
}

function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`
}

export class TurnDebugRecorder {
  readonly id: string
  private readonly dao: SessionTurnDebugDAO
  private readonly sessionId: string
  private readonly startedAtMs = Date.now()
  private readonly events: TurnDebugEvent[] = []
  private contextUsage: ContextUsageData | null = null
  private systemInit: SystemInitData | null = null
  private usage: TurnDebugUsage | null = null
  private ttftMs: number | null = null
  private errorText: string | null = null
  private finished = false
  private readonly toolStartedAt = new Map<string, { name: string; at: number }>()

  constructor(input: StartTurnDebugInput) {
    this.dao = input.dao
    this.sessionId = input.sessionId
    this.id = crypto.randomUUID()
    try {
      this.dao.insert({
        id: this.id,
        session_id: input.sessionId,
        turn_index: input.turnIndex ?? this.dao.nextTurnIndex(input.sessionId),
        user_message_id: input.userMessageId,
        started_at: new Date(this.startedAtMs).toISOString(),
        status: "running",
        model: input.model,
        effort: input.effort,
        cwd: input.cwd,
        identity: JSON.stringify(input.identity),
        role_revision: input.roleRevision,
        role_card: cap(redactSecrets(input.roleCard ?? "")),
        provider_message: cap(redactSecrets(input.providerMessage)),
        system_prompt: cap(redactSecrets(input.systemPrompt)),
        system_prompt_hash: input.systemPromptHash,
        sdk_options: JSON.stringify(input.sdkOptions),
        events: JSON.stringify(this.events),
      })
      if (input.roleCard) {
        this.push("sys", "角色卡随本轮送达", `revision ${input.roleRevision}`)
      }
    } catch (err) {
      console.warn("[turn-debug] insert failed (non-fatal):", err instanceof Error ? err.message : err)
    }
  }

  private push(type: TurnDebugEvent["type"], label: string, det?: string, sub?: string): void {
    if (this.events.length >= MAX_EVENTS) return
    this.events.push({ off: Date.now() - this.startedAtMs, type, label, det, sub })
  }

  private noteFirstOutput(label: string): void {
    if (this.ttftMs != null) return
    this.ttftMs = Date.now() - this.startedAtMs
    this.push("llm", label, fmtMs(this.ttftMs))
  }

  observe(chunk: MessageChunk): void {
    if (this.finished) return
    try {
      switch (chunk.type) {
        case "system_init": {
          this.systemInit = chunk.data
          this.dao.update(this.id, { system_init: JSON.stringify(chunk.data) })
          const tools = chunk.data.tools?.length ?? 0
          const mcp = chunk.data.mcpServers?.length ?? 0
          const skills = chunk.data.skills?.length ?? 0
          this.push(
            "init",
            "SDK init",
            `${chunk.data.claudeCodeVersion ?? "?"} · ${tools} tools · ${mcp} MCP · ${skills} skills`,
            chunk.data.model ? `model ${chunk.data.model} · ${chunk.data.permissionMode ?? "?"}` : undefined,
          )
          break
        }
        case "message_start": {
          this.push("llm", "message_start", chunk.messageId.slice(0, 12))
          break
        }
        case "thinking":
        case "text_delta": {
          this.noteFirstOutput("first token")
          break
        }
        case "context_usage": {
          this.contextUsage = chunk.data
          this.dao.update(this.id, { context_usage: JSON.stringify(chunk.data) })
          this.push(
            "llm",
            "context_usage",
            `${chunk.data.percentage.toFixed(1)}% · ${chunk.data.totalTokens.toLocaleString()}/${chunk.data.maxTokens.toLocaleString()}`,
          )
          break
        }
        case "tool_call_start": {
          this.toolStartedAt.set(chunk.toolCallId, { name: chunk.toolName, at: Date.now() })
          this.noteFirstOutput("first tool")
          this.push("tool", `工具开始 · ${chunk.toolName}`, chunk.toolCallId.slice(0, 10))
          break
        }
        case "tool_result": {
          const started = this.toolStartedAt.get(chunk.toolCallId)
          const elapsed = started ? Date.now() - started.at : null
          this.push(
            "tool",
            `工具${chunk.isError ? "失败" : "返回"} · ${chunk.toolName}`,
            elapsed != null ? fmtMs(elapsed) : undefined,
            chunk.isError ? cap(chunk.content, 600) ?? undefined : undefined,
          )
          break
        }
        case "result": {
          this.usage = normalizeUsage(chunk.usage, chunk.modelUsages)
          this.push(
            "res",
            "result",
            this.usage
              ? `${this.usage.totalTokens.toLocaleString()} tok · ${this.usage.models?.length ?? 1} model`
              : "no usage",
          )
          break
        }
        case "error": {
          this.errorText = `${chunk.code}: ${chunk.message}`
          this.usage = normalizeUsage(chunk.usage, chunk.modelUsages) ?? this.usage
          this.push("err", "error result", chunk.code, cap(chunk.message, 600) ?? undefined)
          break
        }
        case "slash_commands": {
          this.push("init", "slash_commands", `${chunk.commands.length} 条`)
          break
        }
        case "status": {
          if (chunk.status) this.push("sys", "status", chunk.status)
          break
        }
        case "conversation_reset": {
          this.push("sys", "conversation_reset", "provider transcript 已清空")
          break
        }
        default:
          break
      }
    } catch (err) {
      console.warn("[turn-debug] observe failed (non-fatal):", err instanceof Error ? err.message : err)
    }
  }

  finish(patch: {
    status: TurnDebugStatus
    assistantMessageId?: string | null
    error?: string | null
  }): void {
    if (this.finished) return
    this.finished = true
    const endedAtMs = Date.now()
    try {
      if (patch.error && !this.errorText) this.errorText = patch.error
      this.push(
        patch.status === "error" ? "err" : patch.status === "interrupted" ? "sys" : "res",
        patch.status === "ok" ? "turn done" : patch.status === "interrupted" ? "turn interrupted" : "turn error",
        fmtMs(endedAtMs - this.startedAtMs),
      )
      this.dao.update(this.id, {
        ended_at: new Date(endedAtMs).toISOString(),
        status: patch.status,
        assistant_message_id: patch.assistantMessageId ?? null,
        usage: this.usage ? JSON.stringify(this.usage) : null,
        ttft_ms: this.ttftMs,
        duration_ms: endedAtMs - this.startedAtMs,
        error: this.errorText,
        events: JSON.stringify(this.events),
      })
      this.dao.prune(this.sessionId)
    } catch (err) {
      console.warn("[turn-debug] finish failed (non-fatal):", err instanceof Error ? err.message : err)
    }
  }
}

function normalizeUsage(
  usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheCreationTokens?: number } | null,
  modelUsages?: readonly {
    model?: string | null
    inputTokens?: number
    outputTokens?: number
    cacheReadTokens?: number
    cacheCreationTokens?: number
  }[] | null,
): TurnDebugUsage | null {
  const models = (modelUsages ?? [])
    .map((m) => ({
      model: m.model ?? null,
      inputTokens: m.inputTokens ?? 0,
      outputTokens: m.outputTokens ?? 0,
      cacheReadTokens: m.cacheReadTokens ?? 0,
      cacheCreationTokens: m.cacheCreationTokens ?? 0,
    }))
    .filter((m) => m.inputTokens + m.outputTokens + m.cacheReadTokens + m.cacheCreationTokens > 0)
  if (models.length > 0) {
    const sum = models.reduce(
      (acc, m) => ({
        inputTokens: acc.inputTokens + m.inputTokens,
        outputTokens: acc.outputTokens + m.outputTokens,
        cacheReadTokens: acc.cacheReadTokens + m.cacheReadTokens,
        cacheCreationTokens: acc.cacheCreationTokens + m.cacheCreationTokens,
      }),
      { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
    )
    return {
      ...sum,
      totalTokens: sum.inputTokens + sum.outputTokens + sum.cacheReadTokens + sum.cacheCreationTokens,
      models,
    }
  }
  if (!usage) return null
  const sum = {
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    cacheReadTokens: usage.cacheReadTokens ?? 0,
    cacheCreationTokens: usage.cacheCreationTokens ?? 0,
  }
  const total = sum.inputTokens + sum.outputTokens + sum.cacheReadTokens + sum.cacheCreationTokens
  return total > 0 ? { ...sum, totalTokens: total } : null
}