'use client'

// S2 owns this file —— 全应用**唯一**一次编队轮询。
//
// 2026-11-15 用户口径：全域座舱属于**入口舱**。`/cabin/:id/cockpit` 只轮询
// 这一个舱的作业，不再把别的舱的作业堆进同一条编队。`?cabin=` 跨舱深链已退役。
//
// 一次 tick：
//   1. getCabin(cabinId) + listCabinJobs(cabinId) 并行 —— 固定 2 个请求；
//      没有 job 账本时补一次 listTasks({ cabin_id }) 合成 task 行（第三请求）；
//   2. 富化：只对 kind==='task' 的 job 行 getTask(ref_id)，每次 tick 最多 12 条，
//      按 task id 缓存 30s；
//   3. listRunningSessions 只取「分身」读数，不进首屏关键路径。
//
// 容错：作业列表失败 → 保留上一份快照并标 stale，不清空编队；舱详情失败 →
// 只是这一轮没有 attention（作业行照常出图）。卸载 abort（能传 signal 的
// getCabin/getTask），其余请求用 aborted 标记丢弃结果。
//
// rows 是 sortRows（done 截前 3）的显示行；counts 用未截断的行集统计。

import { useCallback, useEffect, useRef, useState } from 'react'
import { getCabin, listCabinDelegations, listCabinJobs, type CabinDelegationView, type CabinJobView } from '@/lib/cabin-api'
import type { CabinAttentionItem } from '@octopus/shared'
import { getTask, listTasks } from '@/lib/tasks-api'
import { withDeadline } from '@/lib/with-deadline'
import { listRunningSessions } from '@/lib/agent/api'
import { taskPct } from '@/components/cabin/job-progress'
import type { CabinTaskRow } from '@/components/cabin/modules/ui'
import {
  buildCounts,
  mergeAttention,
  sortRows,
  type CockpitCabinRef,
  type CockpitFleetCounts,
  type CockpitRow,
} from './fleet-model'

const POLL_MS = 10_000
const TASK_CACHE_MS = 30_000
/** 每次 tick 最多富化多少条 task 行（getTask 上限也是它）。 */
const ENRICH_LIMIT = 12
/** 一次 tick 的最长等待（兜底）。 */
export const FLEET_TICK_TIMEOUT_MS = 15_000
/**
 * 单个请求的预算。任何一个接口吊死（浏览器连接被长连接占满 / 半开连接 /
 * 服务端卡在某个查询上）都只算「这一个请求失败」，不能吃掉整次 tick ——
 * 否则编队会永远停在「载入编队…」（2026-11-14 用户 bug：classic 能看到
 * 的作业，全域编队一直加载 + 15s 超时）。
 */
export const CABIN_REQUEST_TIMEOUT_MS = 5_000
const TASKS_FALLBACK_TIMEOUT_MS = 4_000
const SESSIONS_TIMEOUT_MS = 4_000
const ENRICH_TIMEOUT_MS = 3_000
/** 历史舱回退：只合成这些活态任务（与 CabinFleet 的回退集合一致）。 */
const LIVE_TASK_STATUSES = new Set(['running', 'paused', 'awaiting_review', 'awaiting_archive'])

export interface FleetQueryState {
  rows: CockpitRow[]
  /** null = 还没成功接过真值。**不是 0**。 */
  counts: CockpitFleetCounts | null
  /** 与上一份快照比新增的 attention id；首次加载恒为空。 */
  arrivals: string[]
  loading: boolean
  error: string | null
}

export interface FleetQuery extends FleetQueryState {
  refetch: () => void
}

interface CabinSnapshot {
  cabinId: string
  cabinName: string
  rows: CockpitRow[]
  attentionIds: string[]
  /** 详情接口这次没回来时沿用上一份 attention（不能把「需要你」瞬间清零）。 */
  attention: CabinAttentionItem[]
}

interface TaskProgressEntry {
  pct: number | null
  at: number
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function jobRow(base: CockpitCabinRef, job: CabinJobView): CockpitRow {
  // pct 先一律 null：只有 task-kind job 会被富化；workflow/subagent 永远 null。
  return {
    key: `job:${job.id}`,
    kind: 'job',
    cabinId: base.cabinId,
    cabinName: base.cabinName,
    job,
    pct: null,
  }
}

function taskRow(base: CockpitCabinRef, task: CabinTaskRow): CockpitRow {
  return {
    key: `task:${task.id}`,
    kind: 'task',
    cabinId: base.cabinId,
    cabinName: base.cabinName,
    task,
    pct: taskPct(task),
  }
}

function delegationRow(base: CockpitCabinRef, delegation: CabinDelegationView): CockpitRow {
  return {
    key: `delegation:${delegation.id}`,
    kind: 'delegation',
    cabinId: base.cabinId,
    cabinName: base.cabinName,
    delegation,
    pct: null,
  }
}

async function loadCabin(
  cabinId: string,
  previous: CabinSnapshot | undefined,
  signal: AbortSignal,
): Promise<CabinSnapshot> {
  // 详情与作业列表**分开**判成败：详情（派生视图）挂了不该连作业行一起消失 ——
  // 这正是 2026-11-14「classic 看得到、全域看不到」的形态。
  // design 25 §4.2：委派是第二种工作实体，同样进编队（失败不影响任务行）。
  const [detailResult, jobsResult, delegationsResult] = await Promise.allSettled([
    withDeadline(signal, CABIN_REQUEST_TIMEOUT_MS, '舱详情', (s) => getCabin(cabinId, s)),
    withDeadline(signal, CABIN_REQUEST_TIMEOUT_MS, '作业列表', (s) => listCabinJobs(cabinId, s)),
    withDeadline(signal, CABIN_REQUEST_TIMEOUT_MS, '委派列表', (s) => listCabinDelegations(cabinId, s)),
  ])
  if (jobsResult.status === 'rejected') throw jobsResult.reason
  const jobs = jobsResult.value
  const delegationViews = delegationsResult.status === 'fulfilled' ? delegationsResult.value : []
  const detail = detailResult.status === 'fulfilled' ? detailResult.value : null
  const attention = detail
    ? detail.view.attention
    : previous?.attention ?? []

  const base: CockpitCabinRef = {
    cabinId,
    cabinName: detail?.cabin.name ?? previous?.cabinName ?? cabinId,
  }
  const attentionIds = attention.map((item) => item.id)
  const delegationRows = delegationViews
    .filter((d) => d.state !== 'cancelled')
    .map((d) => delegationRow(base, d))

  if (jobs.length > 0) {
    return {
      ...base,
      rows: mergeAttention([...jobs.map((job) => jobRow(base, job)), ...delegationRows], attention, base),
      attentionIds,
      attention,
    }
  }

  // 历史舱没有 job 账本：用活态任务合成 task 行（只补一次 listTasks）。
  const { items } = await withDeadline(
    signal,
    TASKS_FALLBACK_TIMEOUT_MS,
    '任务列表',
    (s) => listTasks({ cabin_id: cabinId }, s),
  )
  const rows = [
    ...items
      .filter((task) => LIVE_TASK_STATUSES.has(task.status))
      .map((task) => taskRow(base, task as CabinTaskRow)),
    ...delegationRows,
  ]
  return {
    ...base,
    rows: mergeAttention(rows, attention, base),
    attentionIds,
    attention,
  }
}

/**
 * 富化 task-kind job 行的 pct。返回新数组；入参行对象不被修改。
 * 只处理前 ENRICH_LIMIT 条（按 attention/priority 降序、created_at 升序选），
 * 其余保持 pct=null。命中 30s 缓存的不发请求。
 *
 * 并发 + 单请求预算：富化只是「锦上添花的进度条」，一条慢接口不能把整次
 * tick 拖过预算（旧实现 12 条串行，接口一慢就 15s 超时）。
 */
async function enrichTaskRows(
  rows: readonly CockpitRow[],
  cache: Map<string, TaskProgressEntry>,
  now: number,
  signal: AbortSignal,
): Promise<CockpitRow[]> {
  const targets: Array<{ index: number; row: Extract<CockpitRow, { kind: 'job' }>; taskId: string }> = []
  rows.forEach((row, index) => {
    if (row.kind === 'job' && row.job.kind === 'task' && row.job.ref_id) {
      targets.push({ index, row, taskId: row.job.ref_id })
    }
  })
  if (targets.length === 0) return [...rows]

  targets.sort((a, b) =>
    (b.row.attention?.priority ?? b.row.job.priority) -
      (a.row.attention?.priority ?? a.row.job.priority) ||
    (Date.parse(a.row.job.created_at) || 0) - (Date.parse(b.row.job.created_at) || 0))

  const next = [...rows]
  await Promise.all(targets.slice(0, ENRICH_LIMIT).map(async (target) => {
    const cached = cache.get(target.taskId)
    if (cached && now - cached.at < TASK_CACHE_MS) {
      next[target.index] = { ...target.row, pct: cached.pct }
      return
    }
    try {
      const detail = await withDeadline(
        signal,
        ENRICH_TIMEOUT_MS,
        '任务进度',
        (s) => getTask(target.taskId, s),
      )
      const row = detail as CabinTaskRow
      // 没有 v4 phaseViews 的任务拿不到真实进度：`taskPct` 会回退成 50%，
      // 那是猜的。全域编队宁可 null（不画条），旧舱 CabinFleet 行为保持不变。
      const pct = (row.derived?.phaseViews?.length ?? 0) > 0 ? taskPct(row) : null
      cache.set(target.taskId, { pct, at: now })
      next[target.index] = { ...target.row, pct }
    } catch {
      // 取不到 / 超时：保持 null —— 不画条、不猜，也不挡别的行。
    }
  }))
  return next
}

/**
 * 入口舱的编队轮询。
 * @param cabinId 入口舱（`/cabin/:id/cockpit` 的 id）—— 全域只读这一个舱。
 */
export function useFleetQuery(cabinId: string): FleetQuery {
  const [state, setState] = useState<FleetQueryState>({
    rows: [],
    counts: null,
    arrivals: [],
    loading: true,
    error: null,
  })

  const mountedRef = useRef(true)
  const inFlightRef = useRef(false)
  const abortRef = useRef<AbortController | null>(null)
  const snapshotRef = useRef<CabinSnapshot | null>(null)
  const cacheRef = useRef<Map<string, TaskProgressEntry>>(new Map())
  const prevAttentionRef = useRef<Set<string> | null>(null)
  /** 本 tick 的起点：卡死的 tick 超过预算就让路（tick 自愈）。 */
  const tickStartedAtRef = useRef(0)
  /** 上一次拿到的分身数（拿不到时沿用，不把 null 当 0）。 */
  const sessionsRef = useRef<number | null>(null)

  const tick = useCallback(async () => {
    const startedAt = Date.now()
    if (inFlightRef.current) {
      // 上一 tick 还挂着：正常情况下 10s 内必收尾（每个请求都有预算）。
      // 超过预算说明它被某个不结算的等待卡住了（半开连接 / 热更留下的僵尸
      // ref）—— 强制让路，不能让它永久锁死编队。
      if (startedAt - tickStartedAtRef.current < FLEET_TICK_TIMEOUT_MS) return
      abortRef.current?.abort()
      inFlightRef.current = false
    }
    inFlightRef.current = true
    tickStartedAtRef.current = startedAt

    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    const { signal } = controller
    // 最后一道兜底：每个请求都有自己的预算，这里只防「预算之外的东西」也吊死。
    let timedOut = false
    const watchdog = window.setTimeout(() => {
      timedOut = true
      controller.abort()
    }, FLEET_TICK_TIMEOUT_MS)

    try {
      // 分身数只影响 HUD 读数，不进首屏关键路径。
      const sessionsTask = withDeadline(signal, SESSIONS_TIMEOUT_MS, '分身数', (s) => listRunningSessions(50, s))
        .then((payload) => {
          sessionsRef.current = payload.items.length
          return payload.items.length
        })
        .catch(() => null) // 分身数拿不到不影响编队（HUD 隐藏该统计）。

      const fresh = await loadCabin(cabinId, snapshotRef.current ?? undefined, signal)

      // 先出图时不闪掉已算好的进度条：同一行的上一份 pct 先沿用，富化回来再覆盖。
      const previous = snapshotRef.current
      if (previous) {
        const prevByKey = new Map(previous.rows.map((row) => [row.key, row]))
        fresh.rows = fresh.rows.map((row) => {
          const prev = prevByKey.get(row.key)
          return row.kind === 'job' && row.pct === null &&
            prev?.kind === 'job' && prev.pct !== null
            ? { ...row, pct: prev.pct }
            : row
        })
      }

      // ── arrivals：比较本 tick 的 attention 集合与上一份 ──────────────
      const currentAttention = new Set(fresh.attentionIds)
      const prevAttention = prevAttentionRef.current
      const arrivals = prevAttention === null
        ? []
        : [...currentAttention].filter((id) => !prevAttention.has(id))
      prevAttentionRef.current = currentAttention
      snapshotRef.current = fresh

      // ── 先出图：编队行一旦到手立刻发布，不等富化 ─────────────────────
      // 旧实现把 12 条 getTask 串行挡在发布之前，任何一个慢接口都会让编队
      // 「一直加载中」。任务进度只是锦上添花，绝不能挡住作业行本身。
      if (mountedRef.current && !signal.aborted) {
        setState({
          rows: sortRows(fresh.rows),
          counts: buildCounts(fresh.rows, sessionsRef.current),
          arrivals,
          loading: false,
          error: null,
        })
      }

      // ── 再富化：并发 + 单请求预算，结果只补 pct ─────────────────────
      if (fresh.rows.length > 0) {
        fresh.rows = await enrichTaskRows(fresh.rows, cacheRef.current, Date.now(), signal)
        if (!mountedRef.current || signal.aborted || abortRef.current !== controller) return
        snapshotRef.current = fresh
      }

      // 切舱清理：舱消失后它的 task 进度缓存不再需要。
      const liveTaskIds = new Set<string>()
      for (const row of fresh.rows) {
        if (row.kind === 'job' && row.job.kind === 'task' && row.job.ref_id) {
          liveTaskIds.add(row.job.ref_id)
        }
      }
      for (const id of [...cacheRef.current.keys()]) {
        if (!liveTaskIds.has(id)) cacheRef.current.delete(id)
      }

      // 分身数若还没回来，等它（自带预算）再收正 counts；行已经在首帧发过了。
      await sessionsTask
      if (!mountedRef.current || signal.aborted || abortRef.current !== controller) return
      setState({
        rows: sortRows(fresh.rows),
        counts: buildCounts(fresh.rows, sessionsRef.current),
        arrivals,
        loading: false,
        error: null,
      })
    } catch (err) {
      if (!mountedRef.current) return
      // 卸载触发的 abort：不写状态（组件已经不在了）。watchdog / 单请求预算
      // 则必须把 loading 收尾 —— 界面不能永远停在「载入编队…」。
      if (signal.aborted && !timedOut) return
      setState((prev) => ({
        ...prev,
        loading: false,
        error: timedOut
          ? `编队请求超时（${Math.round(FLEET_TICK_TIMEOUT_MS / 1000)}s）`
          : errorMessage(err),
      }))
    } finally {
      window.clearTimeout(watchdog)
      // 只清自己的记账：StrictMode 的 cleanup 会 abort 首个 tick，但那个 tick
      // 的 finally 可能在第二个 tick 已经启动之后才跑 —— 不加身份判断就会把
      // 新 tick 的 inFlight 清掉，下一轮 10s 定时器再把新 tick abort 掉，
      // 编队永远停在「载入编队…」（2026-11-14 用户 bug）。
      if (abortRef.current === controller) {
        abortRef.current = null
        inFlightRef.current = false
      }
    }
  }, [cabinId])

  useEffect(() => {
    mountedRef.current = true
    // 入口舱换了（深链换舱）：旧舱的行与缓存不能带过去。
    snapshotRef.current = null
    prevAttentionRef.current = null
    cacheRef.current.clear()
    sessionsRef.current = null
    setState({ rows: [], counts: null, arrivals: [], loading: true, error: null })
    void tick()
    const timer = window.setInterval(() => { void tick() }, POLL_MS)
    return () => {
      mountedRef.current = false
      window.clearInterval(timer)
      abortRef.current?.abort()
      abortRef.current = null
      inFlightRef.current = false
    }
  }, [tick])

  const refetch = useCallback(() => { void tick() }, [tick])

  return { ...state, refetch }
}
