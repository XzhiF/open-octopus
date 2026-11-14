'use client'

// S2 owns this file —— 全应用**唯一**一次编队轮询。
//
// 一次 tick：
//   1. listCabins()（客户端过滤 archived）+ listRunningSessions()（分身数）并行；
//   2. 每个舱并行 getCabin + listCabinJobs —— 每舱基础 2 个请求；
//      历史舱没有 job 时补一次 listTasks({ cabin_id }) 合成 task 行（第三请求，
//      只发生在无 job 账本的舱）；
//   3. 富化：只对 kind==='task' 的 job 行 getTask(ref_id)，每次 tick 最多选 12 条，
//      按 task id 缓存 30s；超限/失败/非 task 的 pct 一律 null（不画条、不猜）。
//
// 容错：某舱任一请求失败 → 该舱保留上一份快照，其它舱照常更新；listCabins 失败
// → 整体保留上一份。卸载 abort（能传 signal 的 getCabin/getTask），其余请求用
// aborted 标记丢弃结果。切舱（舱从列表消失）→ 快照与缓存一起清理。
//
// rows 是 sortRows（done 截前 3）的显示行；counts 用未截断的行集统计，done 是真实条数。

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  getCabin,
  listCabins,
  listCabinJobs,
  type CabinDetail,
  type CabinJobView,
} from '@/lib/cabin-api'
import { getTask, listTasks } from '@/lib/tasks-api'
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
}

interface TaskProgressEntry {
  pct: number | null
  at: number
}

type LoadedCabin = CabinSnapshot

function ensureLive(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
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

async function loadCabin(cabinId: string, signal: AbortSignal): Promise<LoadedCabin> {
  const [{ cabin, view }, jobs] = await Promise.all([
    getCabin(cabinId, signal),
    listCabinJobs(cabinId),
  ])
  ensureLive(signal)

  const base: CockpitCabinRef = { cabinId: cabin.id, cabinName: cabin.name }
  const attentionIds = view.attention.map((item) => item.id)

  if (jobs.length > 0) {
    return {
      ...base,
      rows: mergeAttention(jobs.map((job) => jobRow(base, job)), view.attention, base),
      attentionIds,
    }
  }

  // 历史舱没有 job 账本：用活态任务合成 task 行（只补一次 listTasks）。
  const { items } = await listTasks({ cabin_id: cabinId })
  ensureLive(signal)
  const rows = items
    .filter((task) => LIVE_TASK_STATUSES.has(task.status))
    .map((task) => taskRow(base, task as CabinTaskRow))
  return {
    ...base,
    rows: mergeAttention(rows, view.attention, base),
    attentionIds,
  }
}

/**
 * 富化 task-kind job 行的 pct。返回新数组；入参行对象不被修改。
 * 只处理前 ENRICH_LIMIT 条（按 attention/priority 降序、created_at 升序选），
 * 其余保持 pct=null。命中 30s 缓存的不发请求。
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
  for (const target of targets.slice(0, ENRICH_LIMIT)) {
    const cached = cache.get(target.taskId)
    if (cached && now - cached.at < TASK_CACHE_MS) {
      next[target.index] = { ...target.row, pct: cached.pct }
      continue
    }
    try {
      const detail = await getTask(target.taskId, signal)
      ensureLive(signal)
      const row = detail as CabinTaskRow
      // 没有 v4 phaseViews 的任务拿不到真实进度：`taskPct` 会回退成 50%，
      // 那是猜的。全域编队宁可 null（不画条），旧舱 CabinFleet 行为保持不变。
      const pct = (row.derived?.phaseViews?.length ?? 0) > 0 ? taskPct(row) : null
      cache.set(target.taskId, { pct, at: now })
      next[target.index] = { ...target.row, pct }
    } catch {
      ensureLive(signal)
      // 取不到就保持 null：不画条、不猜。
    }
  }
  return next
}

export function useFleetQuery(): FleetQuery {
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
  const snapshotsRef = useRef<Map<string, CabinSnapshot>>(new Map())
  const cacheRef = useRef<Map<string, TaskProgressEntry>>(new Map())
  const prevAttentionRef = useRef<Set<string> | null>(null)
  /** 上一 tick 见过的舱：新加入编队的舱不把它存量的 attention 当成「到达」。 */
  const seenCabinsRef = useRef<Set<string>>(new Set())

  const tick = useCallback(async () => {
    if (inFlightRef.current) return
    inFlightRef.current = true

    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    const { signal } = controller

    try {
      let cabins: CabinDetail[]
      try {
        const all = await listCabins()
        ensureLive(signal)
        cabins = all.filter((cabin) => cabin.status !== 'archived')
      } catch (err) {
        if (!signal.aborted && mountedRef.current) {
          setState((prev) => ({ ...prev, loading: false, error: errorMessage(err) }))
        }
        return
      }

      const sessionsTask = listRunningSessions()
        .then((payload): number | null => payload.items.length)
        .catch(() => null)

      const failures: unknown[] = []
      const [loaded, sessions] = await Promise.all([
        Promise.all(
          cabins.map(async (cabin) => {
            try {
              return await loadCabin(cabin.id, signal)
            } catch (err) {
              failures.push(err)
              return null // 单舱失败：保留该舱上一份快照，不拖垮别的舱。
            }
          }),
        ),
        sessionsTask,
      ])
      ensureLive(signal)

      const previous = snapshotsRef.current
      const next = new Map<string, CabinSnapshot>()
      const replaced: LoadedCabin[] = []
      for (let i = 0; i < cabins.length; i += 1) {
        const cabin = cabins[i]
        const fresh = loaded[i]
        if (fresh) {
          next.set(cabin.id, fresh)
          replaced.push(fresh)
        } else {
          const old = previous.get(cabin.id)
          if (old) next.set(cabin.id, old)
        }
      }

      // 首次加载就全挂：没有可保留的快照，counts 必须保持 null —— 不能写 0 冒充空编队。
      if (cabins.length > 0 && next.size === 0 && previous.size === 0) {
        if (mountedRef.current && !signal.aborted) {
          setState((prev) => ({
            ...prev,
            loading: false,
            error: failures.length > 0 ? errorMessage(failures[0]) : '编队数据加载失败',
          }))
        }
        return
      }

      // 只富化本 tick 成功刷新的舱；失败舱的旧快照原样保留（也不占富化预算）。
      const freshRows = replaced.flatMap((snapshot) => snapshot.rows)
      const enrichedFresh = await enrichTaskRows(freshRows, cacheRef.current, Date.now(), signal)
      ensureLive(signal)

      const enrichedByCabin = new Map<string, Map<string, CockpitRow>>()
      for (const row of enrichedFresh) {
        let byKey = enrichedByCabin.get(row.cabinId)
        if (!byKey) {
          byKey = new Map()
          enrichedByCabin.set(row.cabinId, byKey)
        }
        byKey.set(row.key, row)
      }
      for (const snapshot of replaced) {
        const byKey = enrichedByCabin.get(snapshot.cabinId)
        if (byKey) snapshot.rows = snapshot.rows.map((row) => byKey.get(row.key) ?? row)
        next.set(snapshot.cabinId, snapshot)
      }

      const finalRows: CockpitRow[] = []
      const currentAttention = new Set<string>()
      for (const snapshot of next.values()) {
        finalRows.push(...snapshot.rows)
        for (const id of snapshot.attentionIds) currentAttention.add(id)
      }

      // 切舱清理：舱消失后它的 task 进度缓存不再需要。
      const liveTaskIds = new Set<string>()
      for (const row of finalRows) {
        if (row.kind === 'job' && row.job.kind === 'task' && row.job.ref_id) {
          liveTaskIds.add(row.job.ref_id)
        }
      }
      for (const id of [...cacheRef.current.keys()]) {
        if (!liveTaskIds.has(id)) cacheRef.current.delete(id)
      }

      const prevAttention = prevAttentionRef.current
      const seenCabins = seenCabinsRef.current
      const arrivals: string[] = []
      if (prevAttention !== null) {
        for (const snapshot of next.values()) {
          // 新加入的舱：存量 attention 不是「刚到达」，否则会在换代舱/新建舱时
          // 凭空弹一张「N 件需要你」的简报。
          if (!seenCabins.has(snapshot.cabinId)) continue
          for (const id of snapshot.attentionIds) {
            if (!prevAttention.has(id)) arrivals.push(id)
          }
        }
      }
      prevAttentionRef.current = currentAttention
      seenCabinsRef.current = new Set(next.keys())

      snapshotsRef.current = next
      const counts = buildCounts(finalRows, sessions)
      const rows = sortRows(finalRows)

      if (!mountedRef.current || signal.aborted) return
      setState({ rows, counts, arrivals, loading: false, error: null })
    } catch {
      // abort 或 tick 级异常：保留上一份快照，静默等下一次轮询。
      if (!mountedRef.current) return
    } finally {
      inFlightRef.current = false
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true
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
