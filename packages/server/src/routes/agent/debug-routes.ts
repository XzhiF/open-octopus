// packages/server/src/routes/agent/debug-routes.ts
//
// Dock 「调试」 inspector API. Two read-only endpoints:
//   GET /debug/sessions/:id/turns        → newest-first summaries (no large text)
//   GET /debug/sessions/:id/turns/:turn  → one turn's full SDK snapshot
//
// The write side is TurnDebugRecorder inside the chat route; this module never
// writes. Large fields (provider message / system prompt / role card) live only
// on the detail endpoint so a long session keeps the list cheap.

import { Hono } from 'hono'
import type { Context } from 'hono'
import type { ContextUsageData, SystemInitData } from '@octopus/providers'
import type { AgentSessionDAO, TokenUsageDAO } from '../../db/dao'
import {
  SessionCacheContextDAO,
  SessionTurnDebugDAO,
  type SessionTurnDebugRow,
  type SessionTurnDebugSummaryRow,
} from '../../db/dao'
import type { LlmCallCostedRow } from '../../db/dao/token-usage-dao'
import { createAgentError, mapErrorToStatus } from './middleware'
import type { TurnDebugEvent, TurnDebugIdentity, TurnDebugStatus, TurnDebugUsage } from '../../services/agent/turn-debug-recorder'

export interface DebugRouteDeps {
  sessionDAO: AgentSessionDAO
  tokenUsageDAO?: TokenUsageDAO
}

interface TurnSummaryWire {
  id: string
  turn_index: number
  status: TurnDebugStatus
  model: string | null
  effort: string | null
  started_at: string
  ended_at: string | null
  duration_ms: number | null
  ttft_ms: number | null
  identity: TurnDebugIdentity
  role_revision: number
  has_switch: boolean
  usage: TurnDebugUsage | null
  error: string | null
  user_message_id: string | null
  assistant_message_id: string | null
}

interface TurnLlmCallWire {
  model: string | null
  stop_reason: string | null
  duration_ms: number
  ttft_ms: number | null
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_creation_tokens: number
  cost_usd: number | null
  timestamp: number
}

function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

function asStatus(raw: string): TurnDebugStatus {
  return raw === 'ok' || raw === 'interrupted' || raw === 'error' ? raw : 'running'
}

function usageFromCalls(calls: readonly LlmCallCostedRow[]): TurnDebugUsage | null {
  if (calls.length === 0) return null
  const usage = calls.reduce(
    (acc, call) => ({
      inputTokens: acc.inputTokens + call.input_tokens,
      outputTokens: acc.outputTokens + call.output_tokens,
      cacheReadTokens: acc.cacheReadTokens + call.cache_read_tokens,
      cacheCreationTokens: acc.cacheCreationTokens + call.cache_creation_tokens,
    }),
    { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
  )
  const totalTokens =
    usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheCreationTokens
  if (totalTokens === 0) return null
  return { ...usage, totalTokens }
}

function costOf(calls: readonly LlmCallCostedRow[]): number | null {
  let total: number | null = null
  for (const call of calls) {
    if (call.cost_usd == null) continue
    total = (total ?? 0) + call.cost_usd
  }
  return total
}

function toSummary(row: SessionTurnDebugSummaryRow): TurnSummaryWire {
  return {
    id: row.id,
    turn_index: row.turn_index,
    status: asStatus(row.status),
    model: row.model,
    effort: row.effort,
    started_at: row.started_at,
    ended_at: row.ended_at,
    duration_ms: row.duration_ms,
    ttft_ms: row.ttft_ms,
    identity: parseJson<TurnDebugIdentity>(row.identity) ?? {
      id: null, kind: 'base', name: '主 Agent', revision: row.role_revision,
    },
    role_revision: row.role_revision,
    has_switch: row.has_switch === 1,
    usage: parseJson<TurnDebugUsage>(row.usage),
    error: row.error,
    user_message_id: row.user_message_id,
    assistant_message_id: row.assistant_message_id,
  }
}

function toLlmCallWire(call: LlmCallCostedRow): TurnLlmCallWire {
  return {
    model: call.model,
    stop_reason: call.stop_reason,
    duration_ms: call.duration_ms,
    ttft_ms: call.ttft_ms,
    input_tokens: call.input_tokens,
    output_tokens: call.output_tokens,
    cache_read_tokens: call.cache_read_tokens,
    cache_creation_tokens: call.cache_creation_tokens,
    cost_usd: call.cost_usd,
    timestamp: call.timestamp,
  }
}

/** Ledger rows whose result timestamp falls inside the turn's lifetime. */
function callsForTurn(turn: TurnSummaryWire, calls: readonly LlmCallCostedRow[]): LlmCallCostedRow[] {
  const from = Date.parse(turn.started_at)
  const to = turn.ended_at ? Date.parse(turn.ended_at) + 1_000 : Date.now()
  if (!Number.isFinite(from) || !Number.isFinite(to)) return []
  return calls.filter((call) => call.timestamp >= from && call.timestamp <= to)
}

/** Fill cost (and, when the provider result was empty, token totals) from the
 *  ledger. The list endpoint needs this too: cost is never stored on the row. */
function applyLedger(turn: TurnSummaryWire, calls: readonly LlmCallCostedRow[]): void {
  const matched = callsForTurn(turn, calls)
  const usage = turn.usage ?? usageFromCalls(matched)
  if (!usage) return
  usage.costUsd = costOf(matched)
  usage.costComplete = matched.length > 0 && matched.every((call) => call.cost_usd != null)
  turn.usage = usage
}

export function createDebugRoutes(deps: DebugRouteDeps): Hono {
  const { sessionDAO, tokenUsageDAO } = deps
  const app = new Hono()
  const turnDao = new SessionTurnDebugDAO(sessionDAO.getDb())

  const requireSession = (c: Context): string | null => {
    const id = c.req.param('id')
    const session = sessionDAO.findById(id)
    if (!session || session.is_deleted) return null
    return id
  }

  app.get('/debug/sessions/:id/turns', (c) => {
    try {
      const id = requireSession(c)
      if (!id) return c.json(createAgentError('NOT_FOUND', 'Session not found'), 404)
      const turns = turnDao.listSummaries(id).map(toSummary)
      if (tokenUsageDAO && turns.length > 0) {
        const calls = tokenUsageDAO.findLlmCallsBySession(id)
        for (const turn of turns) applyLedger(turn, calls)
      }
      return c.json({ session_id: id, total: turns.length, turns })
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err))
      return c.json(createAgentError('INTERNAL_ERROR', error.message), mapErrorToStatus('INTERNAL_ERROR'))
    }
  })

  app.get('/debug/sessions/:id/turns/:turn', (c) => {
    try {
      const id = requireSession(c)
      if (!id) return c.json(createAgentError('NOT_FOUND', 'Session not found'), 404)
      const turnIndex = Number.parseInt(c.req.param('turn'), 10)
      if (!Number.isFinite(turnIndex) || turnIndex < 1) {
        return c.json(createAgentError('INVALID_PARAM', 'turn must be a positive integer'), 400)
      }
      const row = turnDao.findByTurn(id, turnIndex)
      if (!row) {
        return c.json(createAgentError('NOT_FOUND', `Turn ${turnIndex} not recorded`), 404)
      }
      return c.json(buildDetail(id, row))
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err))
      return c.json(createAgentError('INTERNAL_ERROR', error.message), mapErrorToStatus('INTERNAL_ERROR'))
    }
  })

  function buildDetail(sessionId: string, row: SessionTurnDebugRow) {
    const summary = toSummary({
      id: row.id,
      session_id: row.session_id,
      turn_index: row.turn_index,
      user_message_id: row.user_message_id,
      assistant_message_id: row.assistant_message_id,
      started_at: row.started_at,
      ended_at: row.ended_at,
      status: row.status,
      model: row.model,
      effort: row.effort,
      identity: row.identity,
      role_revision: row.role_revision,
      usage: row.usage,
      ttft_ms: row.ttft_ms,
      duration_ms: row.duration_ms,
      error: row.error,
      has_switch: row.role_card ? 1 : 0,
    })

    const fromMs = Date.parse(row.started_at)
    const toMs = row.ended_at ? Date.parse(row.ended_at) + 1_000 : Date.now()
    const calls = tokenUsageDAO && Number.isFinite(fromMs) && Number.isFinite(toMs)
      ? tokenUsageDAO.findLlmCallsBySessionWindow(sessionId, fromMs, toMs)
      : []
    const usage = summary.usage ?? usageFromCalls(calls)
    if (usage) {
      usage.costUsd = costOf(calls)
      usage.costComplete = calls.length > 0 && calls.every((call) => call.cost_usd != null)
    }

    const userMessage = row.user_message_id
      ? sessionDAO.findMessageById(row.user_message_id)?.content ?? null
      : null

    // Frozen-snapshot check: the system prompt is session-frozen; a mismatch
    // means the prompt was rebuilt after this turn (cache prefix invalidated).
    const snapshot = new SessionCacheContextDAO(sessionDAO.getDb()).getPromptSnapshot(sessionId)
    const systemPromptHash = row.system_prompt_hash
    const systemPromptFrozen = !!snapshot && !!systemPromptHash && snapshot.promptHash === systemPromptHash

    const previousRow = turnDao.findPrevious(sessionId, row.turn_index)

    return {
      ...summary,
      usage,
      user_message: userMessage,
      provider_message: row.provider_message,
      system_prompt: row.system_prompt,
      system_prompt_hash: systemPromptHash,
      system_prompt_frozen: systemPromptFrozen,
      role_card: row.role_card || null,
      cwd: row.cwd,
      sdk_options: parseJson<Record<string, unknown>>(row.sdk_options) ?? {},
      context_usage: parseJson<ContextUsageData>(row.context_usage),
      system_init: parseJson<SystemInitData>(row.system_init),
      events: parseJson<TurnDebugEvent[]>(row.events) ?? [],
      ledger_calls: calls.map(toLlmCallWire),
      previous: previousRow
        ? {
            turn_index: previousRow.turn_index,
            identity: parseJson<TurnDebugIdentity>(previousRow.identity),
            cwd: previousRow.cwd,
            model: previousRow.model,
            effort: previousRow.effort,
            system_prompt_hash: previousRow.system_prompt_hash,
            sdk_options: parseJson<Record<string, unknown>>(previousRow.sdk_options) ?? {},
          }
        : null,
    }
  }

  return app
}