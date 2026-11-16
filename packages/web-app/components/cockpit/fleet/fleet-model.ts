// S2 owns this file —— S1 只把编队的行模型/计数契约落死，便于 S3/S6/S8
// 在 S2 完成前就能对着类型写。S2 在此基础上实现 groupOf / 排序 / duration 等纯函数。
//
// 2026-11-15：编队只含入口舱（跨舱视图已退役）；行上的 cabinId/cabinName 保留
// 是为了让行模型与 URL/ref 契约不依赖「一定只有一舱」这个实现细节。
//
// 数据来源（plans §1.5）：
//   · listCabinJobs(cabinId) → CabinJobView
//   · getCabin(id) → { cabin, view.attention: CabinAttentionItem[] }（job_id 可空）
//   · 历史舱无 job → listTasks({ cabin_id }) 合成 task 行
// 任何 pct 只会是真值或 null（不画条，不猜）。

import type { CabinAttentionItem } from '@octopus/shared'
import type { CabinDelegationView, CabinJobView } from '@/lib/cabin-api'
import { formatDuration } from '@/lib/format'
import { taskDisplayStatus, type CabinTaskRow } from '@/components/cabin/modules/ui'
import { isEndedJob, jobStatusLabel } from '@/components/cabin/job-status'
import { TASK_STATUS_LABEL } from '@/components/tasks/run-console/phase-status'

export type CockpitRow =
  | {
      key: `job:${string}`
      kind: 'job'
      cabinId: string
      cabinName: string
      job: CabinJobView
      attention?: CabinAttentionItem
      pct: number | null
    }
  | {
      key: `task:${string}`
      kind: 'task'
      cabinId: string
      cabinName: string
      task: CabinTaskRow
      pct: number
    }
  | {
      key: `attn:${string}`
      kind: 'attention'
      cabinId: string
      cabinName: string
      item: CabinAttentionItem
    }
  /** 独立委派（design 25 §4.2）：没有 phase / worktree / 验收 / 归档。
   *  句柄用 D1，不进 task: 命名空间；点开是 doer 会话（证据面）。 */
  | {
      key: `delegation:${string}`
      kind: 'delegation'
      cabinId: string
      cabinName: string
      delegation: CabinDelegationView
      pct: null
    }

export type CockpitRowGroup = 'need' | 'run' | 'queue' | 'done'

export interface CockpitFleetCounts {
  need: number
  run: number
  queue: number
  done: number
  perCabin: Record<string, number>
  jobs: number
  /** GET /api/agent/sessions/running；拿不到就是 null（HUD 隐藏该统计）。 */
  sessions: number | null
}

// ── 行归属 / 排序 / 合并 / 计数（纯函数，不改入参）────────────────────

/** 「需要你」的作业状态：待验收 / 待归档 / 失败升级。job 带 attention 时
 *  也在 need（见 groupOf），这条兜住服务端还没来得及派生 attention 的窗口。 */
const NEED_STATUSES = new Set(['awaiting_review', 'awaiting_archive', 'failed', 'blocked', 'waiting_input'])
const RUN_STATUSES = new Set(['running'])
/** 已结束组只留最近 3 条（plans Step 2 task 1）。 */
const DONE_LIMIT = 3

/**
 * need / run / queue / done。
 *   · attention 行：awaiting=person 或 stage=blocked → need；
 *   · job 行挂上 attention（job_id 命中）→ need；
 *   · running → run；pending/ready/queued/paused/其它活态 → queue；
 *   · ended/cancelled/done/... → done。
 * 未知/缺 status 的活态落 queue —— 不冒充运行中。
 */
export function groupOf(row: CockpitRow): CockpitRowGroup {
  if (row.kind === 'attention') {
    if (row.item.awaiting === 'person' || row.item.stage === 'blocked') return 'need'
    if (row.item.awaiting === 'working') return 'run'
    return 'done'
  }
  if (row.kind === 'delegation') {
    if (row.delegation.state === 'waiting_input' || row.delegation.state === 'failed') return 'need'
    if (row.delegation.state === 'running') return 'run'
    if (row.delegation.state === 'queued') return 'queue'
    return 'done'
  }
  if (row.kind === 'job' && row.attention) return 'need'
  if (row.kind === 'job' && !row.job.status) return row.job.ended_at ? 'done' : 'queue'

  const status = row.kind === 'job' ? (row.job.status as string) : taskDisplayStatus(row.task)
  if (NEED_STATUSES.has(status)) return 'need'
  if (isEndedJob(status)) return 'done'
  // 主线程 agent 在跑（人刚答完、答案已转达给作者）：任务生命周期还是 ready，
  // 但编队应该进「运行中」——否则看起来没人在干活。
  if (RUN_STATUSES.has(status) || (row.kind === 'job' && row.job.agent_running)) return 'run'
  return 'queue'
}

function priorityOf(row: CockpitRow): number {
  if (row.kind === 'attention') return row.item.priority
  if (row.kind === 'job') return row.attention?.priority ?? row.job.priority
  return 0
}
function timeOf(iso: string | null | undefined): number | null {
  if (!iso) return null
  const at = Date.parse(iso)
  return Number.isNaN(at) ? null : at
}

function createdAtOf(row: CockpitRow): number | null {
  if (row.kind === 'attention') return null
  if (row.kind === 'job') return timeOf(row.job.created_at)
  if (row.kind === 'task') return timeOf(row.task.created_at)
  return timeOf(row.delegation.created_at)
}

/** 已结束行的结束时间；活态行返回 null（durationLabel 用 now 兜）。 */
function endedAtOf(row: CockpitRow): number | null {
  if (row.kind === 'attention') return null
  if (row.kind === 'job') return timeOf(row.job.ended_at)
  if (row.kind === 'task') {
    return isEndedJob(taskDisplayStatus(row.task)) ? timeOf(row.task.updated_at) : null
  }
  const state = row.delegation.state
  return state === 'done' || state === 'failed' || state === 'cancelled'
    ? timeOf(row.delegation.ended_at ?? row.delegation.updated_at)
    : null
}

/**
 * 返回新数组（入参不动），组序 need → run → queue → done：
 *   · need：job/task 行在前、纯 attention 行在后，组内 attention 优先级降序；
 *   · run：priority 降序，同优先级先开始的在前；
 *   · queue：FIFO（created_at 升序，缺时间放最后）；
 *   · done：ended_at 降序，只留前 3。
 */
export function sortRows(rows: readonly CockpitRow[]): CockpitRow[] {
  const buckets: Record<CockpitRowGroup, CockpitRow[]> = { need: [], run: [], queue: [], done: [] }
  const order = new Map(rows.map((row, index) => [row, index] as const))
  for (const row of rows) buckets[groupOf(row)].push(row)
  const stable = (a: CockpitRow, b: CockpitRow) => (order.get(a) ?? 0) - (order.get(b) ?? 0)

  buckets.need.sort((a, b) =>
    Number(a.kind === 'attention') - Number(b.kind === 'attention') ||
    priorityOf(b) - priorityOf(a) ||
    stable(a, b))

  buckets.run.sort((a, b) =>
    priorityOf(b) - priorityOf(a) ||
    (createdAtOf(a) ?? Number.POSITIVE_INFINITY) - (createdAtOf(b) ?? Number.POSITIVE_INFINITY) ||
    stable(a, b))

  buckets.queue.sort((a, b) =>
    (createdAtOf(a) ?? Number.POSITIVE_INFINITY) - (createdAtOf(b) ?? Number.POSITIVE_INFINITY) ||
    stable(a, b))

  buckets.done = buckets.done
    .sort((a, b) =>
      (endedAtOf(b) ?? Number.NEGATIVE_INFINITY) - (endedAtOf(a) ?? Number.NEGATIVE_INFINITY) ||
      stable(a, b))
    .slice(0, DONE_LIMIT)

  return [...buckets.need, ...buckets.run, ...buckets.queue, ...buckets.done]
}

export interface CockpitCabinRef {
  cabinId: string
  cabinName: string
}

/**
 * attention ↔ job 合并：
 *   · job_id 命中的 attention 挂到对应 job 行（同一 job 多条时行上放 priority
 *     最高的一条，其余**保留**为独立 `attn:` 行 —— 并发待办不能丢，人要能选择）；
 *   · 未命中（含 job_id=null 的 finding / 裁决类）单独成 `attn:` 行，保留全部。
 * `cabin` 用于给未命中行标归属舱；省略时从首行推断（全空舱请显式传入）。
 * 返回值是新数组，入参对象不被修改。
 */
export function mergeAttention(
  rows: readonly CockpitRow[],
  attention: readonly CabinAttentionItem[],
  cabin?: CockpitCabinRef,
): CockpitRow[] {
  const jobIds = new Set<string>()
  for (const row of rows) if (row.kind === 'job') jobIds.add(row.job.id)

  const bestByJob = new Map<string, CabinAttentionItem>()
  const extras: CabinAttentionItem[] = []
  for (const item of attention) {
    if (item.job_id && jobIds.has(item.job_id)) {
      const prev = bestByJob.get(item.job_id)
      if (!prev) bestByJob.set(item.job_id, item)
      else if (item.priority > prev.priority) {
        // 2026-11-16：编队并发时同一作业可能有两条以上待办（如同时有提问与
        // 审批）；被压下去的那条**不能丢**，转成独立 attention 行，人才能选择
        // 先处理哪一条。
        extras.push(prev)
        bestByJob.set(item.job_id, item)
      } else {
        extras.push(item)
      }
    } else {
      extras.push(item)
    }
  }

  const merged = rows.map((row) => {
    if (row.kind !== 'job') return row
    const hit = bestByJob.get(row.job.id)
    return hit ? { ...row, attention: hit } : row
  })

  const ref = cabin ??
    (rows.length > 0 ? { cabinId: rows[0].cabinId, cabinName: rows[0].cabinName } : undefined)
  if (!ref) return merged

  const extra: CockpitRow[] = extras.map((item) => ({
    key: `attn:${item.id}`,
    kind: 'attention',
    cabinId: ref.cabinId,
    cabinName: ref.cabinName,
    item,
  }))
  return [...merged, ...extra]
}

/**
 * 统计。`sessions` 原样透传（null = 拿不到 /api/agent/sessions/running，HUD 隐藏）。
 * `jobs` 只数 job/task 行 —— 纯 attention 行是待办，不是作业；命中 job 的
 * attention 已经随该 job 计入，不重复。
 *
 * 传入未截断的行集时 done 是真实条数（sortRows 的「前 3」只影响显示）。
 */
export function buildCounts(
  rows: readonly CockpitRow[],
  sessions: number | null,
): CockpitFleetCounts {
  const counts: CockpitFleetCounts = {
    need: 0, run: 0, queue: 0, done: 0, perCabin: {}, jobs: 0, sessions,
  }
  for (const row of rows) {
    counts[groupOf(row)] += 1
    counts.perCabin[row.cabinId] = (counts.perCabin[row.cabinId] ?? 0) + 1
    if (row.kind !== 'attention') counts.jobs += 1
  }
  return counts
}

/**
 * created_at → ended_at ?? now 的紧凑时长。attention 行没有时长（null）；
 * created_at 缺失/非法也返回 null（UI 省略该段，不写「--」）。
 * 格式化走 `lib/format.formatDuration` 的 compact 档（全站单源，C4 门禁）。
 */
export function durationLabel(row: CockpitRow, now: number): string | null {
  if (row.kind === 'attention') return null
  const start = timeOf(
    row.kind === 'job' ? row.job.created_at
      : row.kind === 'task' ? row.task.created_at
        : row.delegation.created_at,
  )
  if (start === null) return null
  const end = endedAtOf(row) ?? now
  if (!Number.isFinite(end)) return null
  const ms = end - start
  return ms <= 0 ? '0s' : formatDuration(ms, { compact: true })
}
/** 舱名 · transport（task 行用 repo_group）。只拼真实字段。 */
export function metaLine(row: CockpitRow): string {
  if (row.kind === 'job') {
    return [row.cabinName, row.job.transport].filter(Boolean).join(' · ')
  }
  if (row.kind === 'task') {
    return [row.cabinName, row.task.repo_group].filter(Boolean).join(' · ')
  }
  if (row.kind === 'delegation') {
    return [row.cabinName, `委派 ${row.delegation.handle ?? ''}`.trim()].filter(Boolean).join(' · ')
  }
  return [row.cabinName, row.item.repo].filter(Boolean).join(' · ')
}

const ATTENTION_STAGE_LABEL: Record<CabinAttentionItem['stage'], string> = {
  review: '待验收',
  answer: '待回答',
  adjudicate: '待裁决',
  approval: '待审批',
  blocked: '受阻',
}

/** 行状态文案（S3/S4 可直接用；词表复用既有 job / task 映射，不另造一套）。 */
export function statusLabel(row: CockpitRow): string {
  if (row.kind === 'job') {
    // 生命周期「待执行」但主线程在流式 —— 说清楚是作者在干活，而不是等人派发。
    return row.job.agent_running && row.job.status !== 'running'
      ? '作者在推进'
      : jobStatusLabel(row.job.status)
  }
  if (row.kind === 'task') {
    const status = taskDisplayStatus(row.task)
    return TASK_STATUS_LABEL[status] ?? jobStatusLabel(status)
  }
  if (row.kind === 'delegation') return DELEGATION_STATE_LABEL[row.delegation.state]
  return ATTENTION_STAGE_LABEL[row.item.stage]
}

const DELEGATION_STATE_LABEL: Record<CabinDelegationView['state'], string> = {
  queued: '排队',
  running: '跑着',
  waiting_input: '在问你',
  done: '已完成',
  failed: '失败',
  cancelled: '已取消',
}
