// packages/server/src/services/chat/memory-tools.ts
//
// In-process MCP memory tools for the ONE main chat (2026-11-01).
//
// Why a registered MCP tool instead of the legacy "virtual tool" interception
// used by main-agent-route.ts / routes/clone/index.ts: a registered tool returns
// its result to the model in the same turn, can be called repeatedly, and never
// leaves an "unknown tool" error in the transcript.
//
// Two write channels, deliberately different consent rules:
//   · record_daily — working memory. The model may decide on its own.
//   · remember    — long-term memory. Written only when the human asked for it
//                   in THIS turn: either an explicit "记住 / remember this", or
//                   a short affirmative answer right after the model asked
//                   "要不要记到长期记忆？". A self-judged "this looks worth
//                   keeping" is NOT enough — the tool refuses and tells the
//                   model to ask first. Consent is derived per turn from the
//                   user's message (stateless, survives restarts).
//
// Scope: free main sessions only — chat-routes registers this server when the
// session is NOT a task thread. Task threads are identity-driven (task-author /
// task-doer) and their write surface is owned by the path guard; letting a doer
// turn write main-agent memory would pollute it with task-local detail.
//
// Memory target: the main agent's memory (~/.octopus/agent/memory) — exactly
// what chat-routes injects into the session's system prompt. A main session
// that picked a clone as its base still READS main-agent memory, so it writes
// there too (write what you read).

import { z } from "zod"
import { createSdkMcpServer, tool } from "@octopus/providers"
import { getMemoryService } from "../agent/memory-service"
import { getConfigManager } from "../agent/config-manager"

/** 单条 daily 记忆的硬上限（防跑飞输出把工作记忆撑爆）。 */
export const RECORD_DAILY_MAX_CHARS = 8_000

/** 单条长期记忆的硬上限 —— 长期记忆整体进每轮系统提示词，条目必须短。 */
export const REMEMBER_MAX_CHARS = 2_000

/** 长期记忆的分节（与 refineLongTerm 的 `##` 分节语义一致）。 */
export const LONG_TERM_SECTIONS = ["偏好", "决策", "经验教训", "通用"] as const
export type LongTermSection = (typeof LONG_TERM_SECTIONS)[number]

/** 本轮用户消息给出的长记忆写入许可。 */
export type LongTermConsent = "explicit" | "affirmative" | "none"

const DEFAULT_LONG_TERM_MAX_TOKENS = 1_500

// ── Consent detection ─────────────────────────────────────────

// "人明确要求记东西"。故意比"长期"两个字更宽：用户说"记一下今天的进展"
// 也应该允许写入（具体写 daily 还是 long-term 由模型按内容判断）。
const EXPLICIT_MEMORY_REQUEST_RE =
  /(记住|记吧|记一下|记下来|记进去|记录下来|记录一下|写进去|(写入|记到|记入|加到|放到|存到|存进)\s*(长期)?记忆|remember\s+(this|that|it)|note\s+(this|that)\s+down|keep\s+(this|that)\s+in\s+mind|save\s+(this|that)\s+to\s+memory)/i

// 整句短肯定 —— 用于"模型问了要不要记，用户回了一句『要』"。
const AFFIRMATIVE_RE =
  /^(要|要的|好|好的|好呀|可以|可以呀|行|行吧|嗯|嗯嗯|是的|对|对的|写吧|记吧|ok|okay|yes|yep|sure|do it|go ahead)[\s。.!！~，,、]*$/i

export function isExplicitMemoryRequest(text: string): boolean {
  return EXPLICIT_MEMORY_REQUEST_RE.test(text ?? "")
}

export function isAffirmative(text: string): boolean {
  return AFFIRMATIVE_RE.test((text ?? "").trim())
}

/**
 * Resolve this turn's long-term write consent from the user's message.
 *
 * Stateless on purpose: no pending flag to lose on restart. The flow is
 * "model calls remember → refused with NEED_USER_CONFIRMATION → model asks the
 * human → human answers → next turn is explicit/affirmative → write".
 */
export function resolveLongTermConsent(userMessage: string): LongTermConsent {
  if (isExplicitMemoryRequest(userMessage)) return "explicit"
  if (isAffirmative(userMessage)) return "affirmative"
  return "none"
}

// ── Result shapes ─────────────────────────────────────────────

export interface RecordDailyResult {
  ok: boolean
  date?: string
  error?: string
}

export interface RememberResult {
  ok: boolean
  section?: string
  duplicate?: boolean
  token_count?: number
  max_tokens?: number
  error?: string
}

// ── Gates shared by every write ───────────────────────────────

/** Safe mode blocks every write. Fail closed: unreadable config = no write. */
function safeModeError(org: string): string | null {
  try {
    if (getConfigManager().getConfig(org).safe_mode.enabled) {
      return "SAFE_MODE_READONLY: safe mode is enabled. Memory writes are blocked."
    }
  } catch (err) {
    return `CONFIG_UNAVAILABLE: cannot verify safe mode (${err instanceof Error ? err.message : String(err)})`
  }
  return null
}

function longTermMaxTokens(org: string): number {
  try {
    return getConfigManager().getConfig(org).memory.long_term_max_tokens
  } catch {
    return DEFAULT_LONG_TERM_MAX_TOKENS
  }
}

function normalizeSection(section?: string): LongTermSection {
  const wanted = (section ?? "").trim()
  return (LONG_TERM_SECTIONS as readonly string[]).includes(wanted)
    ? (wanted as LongTermSection)
    : "通用"
}

// ── Writers ───────────────────────────────────────────────────

/**
 * Write one entry to the main agent's daily memory.
 *
 * Never throws — every failure is a stable code in `error`.
 */
export function recordDailyToMainMemory(input: {
  org: string
  sessionId: string
  content: string
}): RecordDailyResult {
  const content = typeof input.content === "string" ? input.content.trim() : ""
  if (content === "") {
    return { ok: false, error: "INVALID_PARAM: content is required" }
  }
  if (content.length > RECORD_DAILY_MAX_CHARS) {
    return { ok: false, error: `INVALID_PARAM: content exceeds ${RECORD_DAILY_MAX_CHARS} chars` }
  }

  const blocked = safeModeError(input.org)
  if (blocked) return { ok: false, error: blocked }

  try {
    const res = getMemoryService().recordDaily(input.org, content, input.sessionId)
    return { ok: true, date: res.date }
  } catch (err) {
    return {
      ok: false,
      error: `MEMORY_WRITE_FAILED: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

/**
 * Append one entry to the main agent's long-term memory.
 *
 * `consent === 'none'` is a refusal, not a write: the caller (the model) is told
 * to ask the human first. Budget overflow refuses too — long-term memory is
 * injected into every future system prompt, so it must stay bounded.
 */
export function rememberToLongTerm(input: {
  org: string
  sessionId: string
  content: string
  section?: string
  consent: LongTermConsent
}): RememberResult {
  const content = typeof input.content === "string" ? input.content.trim() : ""
  if (content === "") {
    return { ok: false, error: "INVALID_PARAM: content is required" }
  }
  if (content.length > REMEMBER_MAX_CHARS) {
    return { ok: false, error: `INVALID_PARAM: content exceeds ${REMEMBER_MAX_CHARS} chars` }
  }

  if (input.consent === "none") {
    return {
      ok: false,
      error:
        "NEED_USER_CONFIRMATION: 这条信息可能值得写入长期记忆，但用户本轮没有要求。请先问用户「要不要我记到长期记忆？」，用户明确同意后再调用 remember。",
    }
  }

  const blocked = safeModeError(input.org)
  if (blocked) return { ok: false, error: blocked }

  const section = normalizeSection(input.section)
  try {
    const res = getMemoryService().appendLongTerm(
      input.org,
      content,
      section,
      longTermMaxTokens(input.org),
    )
    return {
      ok: true,
      section: res.section,
      duplicate: res.duplicate,
      token_count: res.token_count,
      max_tokens: res.max_tokens,
    }
  } catch (err) {
    const e = err as { code?: string; token_count?: number; max_tokens?: number; message?: string }
    if (e.code === "MEMORY_BUDGET_EXCEEDED") {
      return {
        ok: false,
        error: `MEMORY_BUDGET_EXCEEDED: ${e.message ?? "long-term memory budget exceeded"}`,
        token_count: e.token_count,
        max_tokens: e.max_tokens,
      }
    }
    return {
      ok: false,
      error: `MEMORY_WRITE_FAILED: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

// ── MCP server ────────────────────────────────────────────────

/** Tool result payload — `ok:false` also flips isError so the model sees it as a failure. */
function toolText(data: unknown) {
  const failed = typeof data === "object" && data !== null && (data as { ok?: unknown }).ok === false
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
    ...(failed ? { isError: true } : {}),
  }
}

const RECORD_DAILY_DESCRIPTION = `Record an important insight, decision, or preference to today's working memory (markdown; focus on why it matters). Also creates a searchable session summary.

Use it for: a user preference or working style; an architectural decision and its reason; a non-obvious discovery future sessions would benefit from; a recurring problem pattern; a productive shortcut.

Do NOT use it for: greetings, one-off lookups, routine task execution, or content already in memory.`

const REMEMBER_DESCRIPTION = `Append a concise entry to the main agent's LONG-TERM memory. Long-term memory is injected into every future session, so only durable facts belong here — a preference, a lasting decision plus its reason, or a stable fact.

Two legitimate situations:
1. The user explicitly asked to remember it in THIS turn ("记住…", "记下来", "remember this") — call directly.
2. YOU think it is worth keeping long-term but the user did NOT ask — do NOT write silently. Call this tool anyway; if the result is NEED_USER_CONFIRMATION, relay the question to the user ("要不要我记到长期记忆？") and call again only after the user clearly agrees.

Never store transient task detail, code snippets, or anything already in memory.`

/**
 * Create the in-process `octopus-memory` MCP server.
 *
 * `longTermConsent` is resolved per turn from the user's message (see
 * resolveLongTermConsent) so `remember` refuses to write without the human
 * asking. The tool LIST stays stable across turns — only the handler's verdict
 * changes — which keeps the provider prompt cache intact.
 */
export function createMemoryToolServer(
  owner: { sessionId: string; org: string },
  opts: { longTermConsent: LongTermConsent },
) {
  return createSdkMcpServer({
    name: "octopus-memory",
    version: "1.0.0",
    instructions:
      "Two memory channels. record_daily = today's working memory (self-judged, cheap). remember = long-term memory (durable facts only; the tool refuses unless the user asked for it this turn, so ask them first). Writes are NOT visible in this session's frozen system prompt — they land in future sessions.",
    tools: [
      tool(
        "record_daily",
        RECORD_DAILY_DESCRIPTION,
        {
          content: z
            .string()
            .min(1)
            .max(RECORD_DAILY_MAX_CHARS)
            .describe("Markdown body to append to today's daily memory (concise; why > what)"),
        },
        async ({ content }) =>
          toolText(recordDailyToMainMemory({ org: owner.org, sessionId: owner.sessionId, content })),
      ),
      tool(
        "remember",
        REMEMBER_DESCRIPTION,
        {
          content: z
            .string()
            .min(1)
            .max(REMEMBER_MAX_CHARS)
            .describe("One durable entry (markdown, concise). Why it matters, not just what happened."),
          section: z
            .string()
            .optional()
            .describe("Section: 偏好 | 决策 | 经验教训 | 通用 (default 通用)"),
        },
        async ({ content, section }) =>
          toolText(
            rememberToLongTerm({
              org: owner.org,
              sessionId: owner.sessionId,
              content,
              section,
              consent: opts.longTermConsent,
            }),
          ),
      ),
    ],
    alwaysLoad: true,
  })
}
