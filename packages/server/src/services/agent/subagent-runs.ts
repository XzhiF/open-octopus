import type Database from "better-sqlite3"
import { getSubagentMessages } from '@octopus/providers'
import type { SubagentEvent, SubagentLogBlock } from '@octopus/providers'
import { SubagentRunDAO, type SubagentRunRow, type SubagentRunSummaryRow } from '../../db/dao'

/** 单个日志块 / 一次运行的存储上限 —— transcript 可能极长，作业坞只要「看得到」。 */
const MAX_BLOCK_CHARS = 20_000
const MAX_STEPS = 400

export type SubagentRunView = SubagentRunSummaryRow & {
  steps?: SubagentLogBlock[]
}

interface SubagentRunContext {
  /** 会话 cwd（task-thread 用 effectiveCwd）—— transcript 目录的定位依据。 */
  cwd?: string
}

function clampBlock(block: SubagentLogBlock): SubagentLogBlock {
  if (block.content && block.content.length > MAX_BLOCK_CHARS) {
    return { ...block, content: `${block.content.slice(0, MAX_BLOCK_CHARS)}\n…（已截断）` }
  }
  return block
}

function parseSteps(raw: string | null | undefined): SubagentLogBlock[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as SubagentLogBlock[]) : []
  } catch {
    return []
  }
}

function sumTranscriptUsage(messages: unknown[]): {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  model?: string
} {
  let inputTokens = 0
  let outputTokens = 0
  let cacheReadTokens = 0
  let cacheCreationTokens = 0
  let model: string | undefined
  for (const raw of messages) {
    const msg = (raw as { message?: { usage?: Record<string, unknown>; model?: string } }).message
    const usage = msg?.usage
    if (!usage) continue
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
    inputTokens += num(usage.input_tokens)
    outputTokens += num(usage.output_tokens)
    cacheReadTokens += num(usage.cache_read_input_tokens)
    cacheCreationTokens += num(usage.cache_creation_input_tokens)
    if (typeof msg?.model === 'string' && msg.model) model = msg.model
  }
  return { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, model }
}

/**
 * 子代理运行记录服务（2026-11-04 作业坞「子代理」）。
 *
 * - 实时数据：chat 路由消费 provider 的 `subagent` chunk，逐事件 upsert；
 * - 历史数据：DB 行（刷新 / 重开 / 服务重启后仍在）；
 * - 单代理 token：真机验证 SDK 的 `task_progress.usage.total_tokens` 在代理
 *   端点恒为 0，权威来源是子代理 transcript（`subagents/agent-<id>.jsonl`）
 *   的逐条 usage —— 这里在读取时按需汇总回填。
 */
export class SubagentRunService {
  private dao: SubagentRunDAO
  /** 同一子代理的 transcript 汇总节流（读取轮询 2s 一次，不必每次读盘）。 */
  private lastRefreshAt = new Map<string, number>()
  /** transcript 连续读空/读零的次数 —— 已结束的行读不到就放弃，别一直读盘。 */
  private usageMisses = new Map<string, number>()
  /** 完成后的延迟对账定时器。 */
  private reconcileTimers = new Map<string, ReturnType<typeof setTimeout>[]>()

  constructor(db: Database.Database) {
    this.dao = new SubagentRunDAO(db)
  }

  applyEvent(sessionId: string, event: SubagentEvent, ctx: SubagentRunContext = {}): void {
    const now = new Date().toISOString()
    switch (event.phase) {
      case 'started': {
        this.dao.upsert({
          id: event.id,
          session_id: sessionId,
          parent_tool_use_id: event.parentToolUseId ?? null,
          agent_type: event.agentType ?? null,
          description: event.description ?? null,
          prompt: event.prompt ?? null,
          status: 'running',
          started_at: now,
          model: event.model ?? null,
          cwd: ctx.cwd ?? null,
          sdk_session_id: event.sdkSessionId ?? null,
        })
        break
      }
      case 'progress': {
        this.dao.upsert({
          id: event.id,
          session_id: sessionId,
          started_at: now,
          description: event.description ?? null,
          status: 'running',
          tool_uses: event.toolUses,
          duration_ms: event.durationMs ?? null,
          model: event.model ?? null,
          cwd: ctx.cwd ?? null,
          sdk_session_id: event.sdkSessionId ?? null,
        })
        break
      }
      case 'log': {
        const existing = this.dao.findById(event.id)
        const steps = parseSteps(existing?.steps)
        const incoming = (event.blocks ?? []).map(clampBlock)
        if (incoming.length === 0) return
        const merged = [...steps, ...incoming]
        const capped = merged.length > MAX_STEPS ? merged.slice(merged.length - MAX_STEPS) : merged
        this.dao.upsert({
          id: event.id,
          session_id: sessionId,
          started_at: existing?.started_at ?? now,
          status: existing?.status === 'running' || !existing ? 'running' : existing.status,
          steps: JSON.stringify(capped),
          step_count: capped.length,
          model: event.model ?? null,
          cwd: ctx.cwd ?? null,
          sdk_session_id: event.sdkSessionId ?? null,
        })
        break
      }
      case 'completed': {
        this.dao.upsert({
          id: event.id,
          session_id: sessionId,
          started_at: now,
          status: event.status ?? 'completed',
          ended_at: now,
          summary: event.summary ?? null,
          model: event.model ?? null,
          tool_uses: event.toolUses,
          duration_ms: event.durationMs ?? null,
          cwd: ctx.cwd ?? null,
          sdk_session_id: event.sdkSessionId ?? null,
        })
        // 完成时立刻补一次 transcript token（不阻塞调用方之外的等待）。
        void this.refreshUsage(event.id, true)
        // 完成瞬间 transcript 往往还没写完 —— 再延迟对账两次，保证数字最终值。
        this.scheduleReconcile(event.id)
        break
      }
    }
  }

  list(sessionId: string): SubagentRunSummaryRow[] {
    const rows = this.dao.listBySession(sessionId)
    for (const row of rows) {
      if (this.needsUsage(row)) void this.refreshUsage(row.id)
    }
    return rows
  }

  find(sessionId: string, id: string): SubagentRunView | null {
    const row = this.dao.findById(id)
    if (!row || row.session_id !== sessionId) return null
    if (this.needsUsage(row)) void this.refreshUsage(id, row.status !== 'running')
    return { ...row, steps: parseSteps(row.steps) }
  }

  /** 完成后的延迟对账：3s / 10s 各读一次 transcript，覆盖「写入滞后」。 */
  private scheduleReconcile(id: string): void {
    const prev = this.reconcileTimers.get(id)
    if (prev) for (const timer of prev) clearTimeout(timer)
    const timers = [3_000, 10_000].map((delay) => setTimeout(() => {
      void this.refreshUsage(id, true)
    }, delay))
    for (const timer of timers) (timer as unknown as { unref?: () => void }).unref?.()
    this.reconcileTimers.set(id, timers)
  }

  private needsUsage(row: SubagentRunSummaryRow): boolean {
    if (!row.sdk_session_id || !row.cwd) return false
    if (row.status === 'running') return true
    if ((this.usageMisses.get(row.id) ?? 0) >= 3) return false
    // 完成瞬间 transcript 可能还没落盘完 —— 结束后 30s 内持续对账，
    // 把「部分写入」的数字纠正成最终值（真机 2026-11-04：差了几百 token）。
    const ended = row.ended_at ? Date.parse(row.ended_at) : NaN
    if (Number.isFinite(ended) && Date.now() - ended < 30_000) return true
    // 兜底：已结束但 token 全 0 —— transcript 可能晚一拍写完。
    return row.input_tokens === 0 && row.output_tokens === 0 && row.cache_read_tokens === 0
  }

  private async refreshUsage(id: string, force = false): Promise<void> {
    const row = this.dao.findById(id)
    if (!row || !row.sdk_session_id || !row.cwd) return
    const now = Date.now()
    const last = this.lastRefreshAt.get(id) ?? 0
    if (!force && now - last < 1_500) return
    this.lastRefreshAt.set(id, now)
    try {
      const messages = await getSubagentMessages(row.sdk_session_id, id, { dir: row.cwd })
      if (!messages || messages.length === 0) {
        if (row.status !== 'running') this.usageMisses.set(id, (this.usageMisses.get(id) ?? 0) + 1)
        return
      }
      const usage = sumTranscriptUsage(messages)
      const total = usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheCreationTokens
      if (total === 0) {
        if (row.status !== 'running') this.usageMisses.set(id, (this.usageMisses.get(id) ?? 0) + 1)
        return
      }
      this.usageMisses.delete(id)
      this.dao.upsert({
        id,
        session_id: row.session_id,
        started_at: row.started_at,
        input_tokens: usage.inputTokens,
        output_tokens: usage.outputTokens,
        cache_read_tokens: usage.cacheReadTokens,
        cache_creation_tokens: usage.cacheCreationTokens,
        model: usage.model ?? row.model ?? null,
      })
    } catch {
      // transcript 尚未落盘 / 已被清理 —— 保留已知数字，非致命。
    }
  }
}
