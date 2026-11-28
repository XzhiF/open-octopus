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
import type { TurnPhase } from '@/lib/agent/api'
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
      /** agent_running 时这轮流式的阶段（/sessions/running 的 phase）。
       *  background-wait = 作者在等后台，编队秒表转琥珀色；未知 = undefined。 */
      live_phase?: TurnPhase
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
/** archiving = 归档编排在跑（git 同步 / 清理 / 知识编译），算「在跑」不算待命。 */
const RUN_STATUSES = new Set(['running', 'archiving'])

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
    // 归档优先（2026-11-25 用户）：归档是终态，哪怕是 failed 也不再回流 need。
    if (row.delegation.archived_at) return 'done'
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
  if (row.kind === 'delegation') {
    if (row.delegation.archived_at) return timeOf(row.delegation.archived_at)
    const state = row.delegation.state
    return state === 'done' || state === 'failed' || state === 'cancelled'
      ? timeOf(row.delegation.ended_at ?? row.delegation.updated_at)
      : null
  }
  return null
}

/**
 * 返回新数组（入参不动），组序 need → run → queue → done：
 *   · need：job/task 行在前、纯 attention 行在后，组内保持编队顺序；
 *   · run：先开始的在前；
 *   · queue：FIFO（created_at 升序，缺时间放最后）；
 *   · done：ended_at 降序（不截断 —— 编队的 6 行 / 更多负责显示上限；
 *           归档行还要按「创建时间新→旧」重排，先截断会把归档挤没）。
 */
export function sortRows(rows: readonly CockpitRow[]): CockpitRow[] {
  const buckets: Record<CockpitRowGroup, CockpitRow[]> = { need: [], run: [], queue: [], done: [] }
  const order = new Map(rows.map((row, index) => [row, index] as const))
  for (const row of rows) buckets[groupOf(row)].push(row)
  const stable = (a: CockpitRow, b: CockpitRow) => (order.get(a) ?? 0) - (order.get(b) ?? 0)

  buckets.need.sort((a, b) =>
    Number(a.kind === 'attention') - Number(b.kind === 'attention') ||
    stable(a, b))

  buckets.run.sort((a, b) =>
    (createdAtOf(a) ?? Number.POSITIVE_INFINITY) - (createdAtOf(b) ?? Number.POSITIVE_INFINITY) ||
    stable(a, b))

  // 待命组：人自开的会话（delegation origin=user）置顶、新→旧 —— 会话是人的
  // 常驻工作面，不能被 6 行折叠挤到「更多」后面；其余仍按 FIFO（旧→新）。
  const pinnedQueue = (row: CockpitRow) => (
    row.kind === 'delegation' && row.delegation.origin === 'user' ? 0 : 1
  )
  buckets.queue.sort((a, b) => {
    const rank = pinnedQueue(a) - pinnedQueue(b)
    if (rank !== 0) return rank
    if (pinnedQueue(a) === 0) {
      return (createdAtOf(b) ?? Number.NEGATIVE_INFINITY) - (createdAtOf(a) ?? Number.NEGATIVE_INFINITY)
        || stable(a, b)
    }
    return (createdAtOf(a) ?? Number.POSITIVE_INFINITY) - (createdAtOf(b) ?? Number.POSITIVE_INFINITY)
      || stable(a, b)
  })

  buckets.done = buckets.done
    .sort((a, b) =>
      (endedAtOf(b) ?? Number.NEGATIVE_INFINITY) - (endedAtOf(a) ?? Number.NEGATIVE_INFINITY) ||
      stable(a, b))

  return [...buckets.need, ...buckets.run, ...buckets.queue, ...buckets.done]
}

export interface CockpitCabinRef {
  cabinId: string
  cabinName: string
}

/**
 * attention ↔ job 合并：
 *   · job_id 命中的 attention 挂到对应 job 行（同一 job 多条时行上放第一条，
 *     其余**保留**为独立 `attn:` 行 —— 并发待办不能丢，人要能选择）；
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
      else {
        // 2026-11-16：编队并发时同一作业可能有两条以上待办（如同时有提问与
        // 审批）；压在后面的那条**不能丢**，转成独立 attention 行，人才能选择
        // 先处理哪一条。
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
 * 传入未截断的行集时 done 是真实条数（编队 rail 只靠 FLEET_LIMIT / 更多折叠，不丢行）。
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
  start: '待放行',
  notice: '已完成',
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
  if (row.kind === 'delegation') return delegationStatusLabel(row.delegation)
  return ATTENTION_STAGE_LABEL[row.item.stage]
}

/**
 * 委派 / 会话状态词（会话详情面复用，单源）。
 *
 * 2026-11-25 用户：交完结论 ≠ 收工。`done` 写「待命」——会话还能继续聊，与任务
 * 的待命同一档；「已归档」是汐音管理的独立终态（archived_at 有值），不再由 state 表达。
 */
export const DELEGATION_STATE_LABEL: Record<CabinDelegationView['state'], string> = {
  queued: '排队',
  running: '作战中',
  waiting_input: '等你答',
  done: '待命',
  failed: '失败',
  cancelled: '已取消',
}

/** 会话状态词（含归档）：archived_at 优先，其次 state。 */
export function delegationStatusLabel(delegation: Pick<CabinDelegationView, 'state' | 'archived_at'>): string {
  if (delegation.archived_at) return '已归档'
  return DELEGATION_STATE_LABEL[delegation.state]
}

// ── v21（design 31 §3.1.1）：左栏单列编队的排序 ─────────────────────────
//
// 状态优先（受阻 → 等你 → 在跑 → 待命 → 已完成 → 已归档），同状态按创建时间
// 升序（旧 → 新；归档档相反：创建时间新 → 旧）。纯 attention 行不进编队 —— 它们是
// 「要我处理」，归右栏 inbox（design 31 §0 #2）。会话交完结论也是「待命」（与任务
// 同一档，可继续聊）；归档才沉最后一档。

export const FLEET_STATUS_RANK = {
  blocked: 0,
  wait: 1,
  run: 2,
  queue: 3,
  /** 非会话作业（workflow / subagent）跑完：已完成。 */
  done: 4,
  /** 归档是最后一档（任务已归档 / 会话已归档）。 */
  archived: 5,
} as const

export type FleetStatus = keyof typeof FLEET_STATUS_RANK

/**
 * 行上此刻是否真有 agent 在干活（编队「在跑」的语义）：
 *   · 行本身在运行组（running / 委派跑着 / 子代理 working）；
 *   · 或 job 的主线程 agent 正在流式 —— 即使生命周期还停在待验收 / 待命 / 受阻。
 * 已结束行永远不算（残留流不该把结束行点亮）。
 */
export function isLiveRow(row: CockpitRow): boolean {
  const group = groupOf(row)
  if (group === 'done') return false
  if (row.kind === 'job' && row.job.agent_running === true) return true
  return group === 'run'
}

/** 生命周期口径的状态（chip 文案 / 行色 / 窄栏状态点）—— 不被「agent 在跑」改写。
 *  语义与 threads-model 的 threadStateOf 一致（那边是 tab 表情）。 */
export function fleetStageOf(row: CockpitRow): FleetStatus {
  // 2026-11-25 用户：会话交完结论 = 待命（与任务的待命同一档，可继续聊）；
  // 归档才是独立终态。放在 groupOf 之前判，done 组也能落待命。
  if (row.kind === 'delegation') {
    if (row.delegation.archived_at) return 'archived'
    if (row.delegation.state === 'done') return 'queue'
  }
  const group = groupOf(row)
  if (group === 'need') {
    if (row.kind === 'attention') return row.item.stage === 'blocked' ? 'blocked' : 'wait'
    if (row.kind === 'delegation') return row.delegation.state === 'failed' ? 'blocked' : 'wait'
    if (row.kind === 'job' && (row.job.status === 'blocked' || row.job.status === 'failed')) {
      return 'blocked'
    }
    return 'wait'
  }
  if (group === 'run') return 'run'
  if (group === 'done') {
    // 任务只有真的走完归档闸（raw done）才写「已归档」；其它结束态仍是已完成。
    if (row.kind === 'task') return taskDisplayStatus(row.task) === 'done' ? 'archived' : 'done'
    if (row.kind === 'job' && row.job.kind === 'task') {
      return row.job.status === 'done' ? 'archived' : 'done'
    }
    return 'done'
  }
  return 'queue'
}

/**
 * 排序 / 计数口径：真在干活的行挪进「在跑」组（待验收的作者还在推进，编队要把
 * 它排到干活那档）；受阻仍排最上（阻塞不能藏），已结束不动。
 */
export function fleetStatusOf(row: CockpitRow): FleetStatus {
  const stage = fleetStageOf(row)
  if ((stage === 'wait' || stage === 'queue') && isLiveRow(row)) return 'run'
  return stage
}

/**
 * 左栏编队顺序：状态 rank → 创建时间。attention-only 行剔除（归 inbox）。
 * 归档档（2026-11-25 用户）同档按创建时间新→旧；其余同状态仍是旧→新。
 * 入参不动，返回新数组。
 */
export function sortFleet(rows: readonly CockpitRow[]): CockpitRow[] {
  const order = new Map(rows.map((row, index) => [row, index] as const))
  // 待命档里人自开的会话置顶、新→旧（常驻工作面，不能被折叠挤掉）。
  const pinnedQueue = (row: CockpitRow) => (
    row.kind === 'delegation' && row.delegation.origin === 'user' ? 0 : 1
  )
  return rows
    .filter((row) => row.kind !== 'attention')
    .map((row) => ({ row, status: fleetStatusOf(row) }))
    .sort((a, b) => {
      const rank = FLEET_STATUS_RANK[a.status] - FLEET_STATUS_RANK[b.status]
      if (rank !== 0) return rank
      if (a.status === 'queue') {
        const pin = pinnedQueue(a.row) - pinnedQueue(b.row)
        if (pin !== 0) return pin
      }
      const ac = createdAtOf(a.row) ?? Number.POSITIVE_INFINITY
      const bc = createdAtOf(b.row) ?? Number.POSITIVE_INFINITY
      const newestFirst = a.status === 'archived'
        || (a.status === 'queue' && pinnedQueue(a.row) === 0)
      const time = newestFirst ? bc - ac : ac - bc
      return time || (order.get(a.row) ?? 0) - (order.get(b.row) ?? 0)
    })
    .map((entry) => entry.row)
}
