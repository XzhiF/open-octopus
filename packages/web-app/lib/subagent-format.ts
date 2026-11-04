import type { SubagentRunSummary } from './agent/api'

/** 子代理状态 → 人话（与运行窗、任务状态分档同律）。 */
const SUBAGENT_STATUS_LABEL: Record<string, string> = {
  running: '运行中',
  completed: '已完成',
  failed: '失败',
  killed: '已中止',
}

export function subagentStatusLabel(status: string): string {
  return SUBAGENT_STATUS_LABEL[status] ?? status
}

export const SUBAGENT_LIVE_STATUS = 'running'

export function isSubagentLive(run: Pick<SubagentRunSummary, 'status'>): boolean {
  return run.status === SUBAGENT_LIVE_STATUS
}

export function subagentTokenTotal(
  run: Pick<SubagentRunSummary, 'input_tokens' | 'output_tokens' | 'cache_read_tokens' | 'cache_creation_tokens'>,
): number {
  return run.input_tokens + run.output_tokens + run.cache_read_tokens + run.cache_creation_tokens
}

/** 运行中按墙钟走；终态优先用 SDK 报的 duration，否则用起止时间差。 */
export function subagentElapsedMs(
  run: Pick<SubagentRunSummary, 'status' | 'started_at' | 'ended_at' | 'duration_ms'>,
  now: number,
): number | null {
  const started = Date.parse(run.started_at)
  if (isSubagentLive(run)) {
    return Number.isFinite(started) ? Math.max(0, now - started) : null
  }
  if (run.duration_ms != null && run.duration_ms > 0) return run.duration_ms
  const ended = run.ended_at ? Date.parse(run.ended_at) : NaN
  return Number.isFinite(started) && Number.isFinite(ended)
    ? Math.max(0, ended - started)
    : null
}

/** 列表标题：描述 → 子代理类型 → id。 */
export function subagentTitle(run: Pick<SubagentRunSummary, 'description' | 'agent_type' | 'id'>): string {
  return run.description?.trim() || run.agent_type || run.id
}
