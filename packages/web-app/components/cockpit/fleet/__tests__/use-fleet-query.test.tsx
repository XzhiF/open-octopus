// S2：useFleetQuery 轮询/容错/富化测试 —— 全 mock API，不打真服务。
// 覆盖：单舱单 job、空舱、历史舱回退、attention 合并（含 job_id=null）、
// 富化上限 12 + 30s 缓存 + pct=null、单舱失败不拖垮其它舱、失败保留快照、
// arrivals、sessions=null、archived 过滤、10s 轮询。

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { CabinAttentionItem, CabinView } from '@octopus/shared'

vi.mock('@/lib/server-config', () => ({ getServerUrl: () => 'http://localhost:3001' }))
vi.mock('@/lib/cabin-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/cabin-api')>()
  return { ...actual, listCabins: vi.fn(), getCabin: vi.fn(), listCabinJobs: vi.fn() }
})
vi.mock('@/lib/tasks-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/tasks-api')>()
  return { ...actual, listTasks: vi.fn(), getTask: vi.fn() }
})
vi.mock('@/lib/agent/api', () => ({ listRunningSessions: vi.fn() }))

import {
  getCabin,
  listCabins,
  listCabinJobs,
  type CabinDetail,
  type CabinJobView,
} from '@/lib/cabin-api'
import { getTask, listTasks } from '@/lib/tasks-api'
import { listRunningSessions } from '@/lib/agent/api'
import { useFleetQuery } from '../use-fleet-query'

function cabin(id: string, name = `舱${id}`, status: CabinDetail['status'] = 'active'): CabinDetail {
  return {
    id,
    name,
    path: `/tmp/${id}`,
    workspace_id: null,
    main_session_id: null,
    requirements: '',
    status,
    mainline_strategy: 'clean-main',
    org: null,
    focused_job_id: null,
    version: 1,
    created_at: '2026-11-14T00:00:00.000Z',
    updated_at: '2026-11-14T00:00:00.000Z',
    last_active_at: null,
    archived_at: null,
  }
}

function makeView(c: CabinDetail, attention: CabinAttentionItem[] = []): CabinView {
  return {
    cabin: c,
    attention,
    health: { running: 0, queued: 0, dormant: 0, workers: 0, max: 4 },
    iterations: [],
    open_findings: 0,
  }
}

function job(id: string, over: Partial<CabinJobView> = {}): CabinJobView {
  return {
    id,
    cabin_id: 'c1',
    kind: 'task',
    ref_id: `t-${id}`,
    session_id: null,
    iteration_id: null,
    title: `作业${id}`,
    mandate: null,
    prompt: null,
    priority: 0,
    created_at: '2026-11-14T00:00:00.000Z',
    ended_at: null,
    status: 'running',
    transport: 'task-thread',
    iteration_code: null,
    ...over,
  }
}

function task(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    name: `任务${id}`,
    status: 'running',
    repo_group: 'pay',
    created_at: '2026-11-14T00:00:00.000Z',
    updated_at: '2026-11-14T00:10:00.000Z',
    // 真实进度来自 v4 phaseViews：1 个已验收 / 共 2 个 → 50%。
    derived: {
      phaseViews: [
        { status: 'accepted' },
        { status: 'running', currentRound: 1, rounds: [1, 2] },
      ],
    },
    ...over,
  }
}

function attention(id: string, over: Partial<CabinAttentionItem> = {}): CabinAttentionItem {
  return {
    id,
    job_id: null,
    stage: 'answer',
    awaiting: 'person',
    title: `待办${id}`,
    task_id: null,
    repo: null,
    wt: null,
    deep_link: null,
    priority: 0,
    ...over,
  }
}

interface CabinFixture {
  cabin: CabinDetail
  jobs?: CabinJobView[]
  attention?: CabinAttentionItem[]
  fail?: boolean
}

/** 按 cabin id 布线 getCabin / listCabinJobs；fail:true 模拟该舱整体失败。 */
function wire(map: Record<string, CabinFixture>) {
  vi.mocked(getCabin).mockImplementation(async (id: string) => {
    const entry = map[id]
    if (!entry || entry.fail) throw new Error(`cabin ${id} unavailable`)
    return { cabin: entry.cabin, view: makeView(entry.cabin, entry.attention ?? []) }
  })
  vi.mocked(listCabinJobs).mockImplementation(async (id: string) => {
    const entry = map[id]
    if (!entry || entry.fail) throw new Error(`jobs ${id} unavailable`)
    return entry.jobs ?? []
  })
}

/** 等一个宏任务，把 tick 里所有已 resolve 的 await 链跑完。 */
async function flush() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(listCabins).mockResolvedValue([cabin('c1')])
  vi.mocked(listRunningSessions).mockResolvedValue({ items: [] } as never)
  vi.mocked(listTasks).mockResolvedValue({ items: [] } as never)
  vi.mocked(getTask).mockImplementation(async (id: string) => task(id) as never)
  wire({ c1: { cabin: cabin('c1') } })
})

describe('useFleetQuery — 基础装配', () => {
  it('单舱单 job：1 条 job 行、counts 非空、workflow 的 pct=null', async () => {
    wire({ c1: { cabin: cabin('c1', '测试作战舱'), jobs: [job('j1', { kind: 'workflow', status: 'running' })] } })
    vi.mocked(listRunningSessions).mockResolvedValue({ items: [{ id: 's1' }, { id: 's2' }] } as never)

    const { result } = renderHook(() => useFleetQuery())
    await waitFor(() => expect(result.current.rows).toHaveLength(1))

    expect(result.current.rows[0]).toMatchObject({
      key: 'job:j1',
      kind: 'job',
      cabinId: 'c1',
      cabinName: '测试作战舱',
      pct: null,
    })
    expect(result.current.counts).toMatchObject({
      need: 0, run: 1, queue: 0, done: 0, jobs: 1, sessions: 2, perCabin: { c1: 1 },
    })
    expect(result.current.loading).toBe(false)
    expect(result.current.error).toBeNull()
    expect(vi.mocked(getTask)).not.toHaveBeenCalled()
  })

  it('archived 舱不参与轮询', async () => {
    vi.mocked(listCabins).mockResolvedValue([cabin('c1'), cabin('dead', '旧舱', 'archived')])
    wire({ c1: { cabin: cabin('c1') } })

    const { result } = renderHook(() => useFleetQuery())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(vi.mocked(getCabin).mock.calls.map(([id]) => id)).not.toContain('dead')
  })

  it('全空编队：counts 是真实全 0（不是 null），rows 空', async () => {
    vi.mocked(listCabins).mockResolvedValue([])
    const { result } = renderHook(() => useFleetQuery())
    await waitFor(() => expect(result.current.counts).not.toBeNull())
    expect(result.current.rows).toEqual([])
    expect(result.current.counts).toEqual({
      need: 0, run: 0, queue: 0, done: 0, perCabin: {}, jobs: 0, sessions: 0,
    })
  })

  it('空舱（有舱无 job 无任务）：rows 空、counts 全 0', async () => {
    wire({ c1: { cabin: cabin('c1') } })
    const { result } = renderHook(() => useFleetQuery())
    await waitFor(() => expect(result.current.counts).not.toBeNull())
    expect(result.current.rows).toEqual([])
    expect(result.current.counts).toMatchObject({ jobs: 0, need: 0, run: 0, perCabin: {} })
  })
})

describe('useFleetQuery — 历史舱回退', () => {
  it('无 job 账本 → listTasks 合成活态 task 行（done 过滤掉）', async () => {
    wire({ c1: { cabin: cabin('c1') } })
    vi.mocked(listTasks).mockResolvedValue({
      items: [
        task('t1', { status: 'running' }),
        task('t2', { status: 'paused' }),
        task('t3', { status: 'awaiting_review' }),
        task('t4', { status: 'done' }),
      ],
    } as never)

    const { result } = renderHook(() => useFleetQuery())
    await waitFor(() => expect(result.current.rows).toHaveLength(3))

    expect(result.current.rows.every((row) => row.kind === 'task')).toBe(true)
    expect(result.current.rows.map((row) => row.key).sort()).toEqual(['task:t1', 'task:t2', 'task:t3'])
    expect(result.current.counts).toMatchObject({ run: 1, queue: 1, need: 1, jobs: 3 })
    expect(vi.mocked(listTasks)).toHaveBeenCalledWith({ cabin_id: 'c1' })
    expect(vi.mocked(getTask)).not.toHaveBeenCalled() // 回退不触发 N+1 富化
  })

  it('有 job 账本时不再调 listTasks', async () => {
    wire({ c1: { cabin: cabin('c1'), jobs: [job('j1')] } })
    const { result } = renderHook(() => useFleetQuery())
    await waitFor(() => expect(result.current.rows).toHaveLength(1))
    expect(vi.mocked(listTasks)).not.toHaveBeenCalled()
  })
})

describe('useFleetQuery — attention 合并 / arrivals', () => {
  it('job_id 命中挂到 job 行；job_id=null 保留为 attn 行', async () => {
    wire({
      c1: {
        cabin: cabin('c1'),
        jobs: [job('j1', { status: 'running' })],
        attention: [
          attention('a-matched', { job_id: 'j1', priority: 4 }),
          attention('finding-1', { job_id: null, stage: 'adjudicate' }),
        ],
      },
    })

    const { result } = renderHook(() => useFleetQuery())
    await waitFor(() => expect(result.current.rows).toHaveLength(2))

    const jobRow = result.current.rows.find((row) => row.key === 'job:j1')
    expect(jobRow?.kind).toBe('job')
    if (jobRow?.kind === 'job') expect(jobRow.attention?.id).toBe('a-matched')
    expect(result.current.rows.some((row) => row.key === 'attn:finding-1')).toBe(true)
    // job 挂 attention 归 need；纯 attention 行也归 need；jobs 只数 job 行
    expect(result.current.counts).toMatchObject({ need: 2, run: 0, jobs: 1 })
  })

  it('arrivals：首次为空，之后只报新增 id，重复 tick 清空', async () => {
    let attentionItems: CabinAttentionItem[] = [attention('a1')]
    vi.mocked(getCabin).mockImplementation(async () => ({
      cabin: cabin('c1'),
      view: makeView(cabin('c1'), attentionItems),
    }))

    const { result } = renderHook(() => useFleetQuery())
    await waitFor(() => expect(result.current.rows).toHaveLength(1))
    expect(result.current.arrivals).toEqual([])

    attentionItems = [attention('a1'), attention('a2')]
    await act(async () => { result.current.refetch() })
    await waitFor(() => expect(result.current.arrivals).toEqual(['a2']))

    await act(async () => { result.current.refetch() })
    await flush()
    expect(result.current.arrivals).toEqual([])
  })

  it('新加入编队的舱：存量 attention 不算到达；同 tick 里老舱的新增仍算', async () => {
    let cabins = [cabin('c1')]
    let attentionByCabin: Record<string, CabinAttentionItem[]> = { c1: [attention('a1')] }
    vi.mocked(listCabins).mockImplementation(async () => cabins)
    vi.mocked(getCabin).mockImplementation(async (id: string) => {
      const c = cabins.find((item) => item.id === id)
      if (!c) throw new Error(`no cabin ${id}`)
      return { cabin: c, view: makeView(c, attentionByCabin[id] ?? []) }
    })
    vi.mocked(listCabinJobs).mockResolvedValue([])

    const { result } = renderHook(() => useFleetQuery())
    await waitFor(() => expect(result.current.counts).not.toBeNull())
    expect(result.current.arrivals).toEqual([])

    // c2 带着一条存量 attention 加入；同一 tick 里 c1 真的新增了 a2。
    cabins = [cabin('c1'), cabin('c2')]
    attentionByCabin = {
      c1: [attention('a1'), attention('a2')],
      c2: [attention('b1')],
    }
    await act(async () => { result.current.refetch() })
    await waitFor(() => expect(result.current.arrivals).toEqual(['a2']))
  })
})

describe('useFleetQuery — task 进度富化', () => {
  it('只富化 task-kind job 行：上限 12 条，其余 pct=null；30s 缓存不重复请求', async () => {
    const jobs = Array.from({ length: 15 }, (_, i) =>
      job(`j${i + 1}`, {
        kind: 'task',
        ref_id: `t${i + 1}`,
        status: 'running',
        created_at: `2026-11-14T00:${String(i).padStart(2, '0')}:00.000Z`,
      }),
    )
    wire({ c1: { cabin: cabin('c1'), jobs } })

    const { result } = renderHook(() => useFleetQuery())
    await waitFor(() => expect(result.current.rows).toHaveLength(15))

    expect(vi.mocked(getTask)).toHaveBeenCalledTimes(12)
    const withPct = result.current.rows.filter((row) => row.kind === 'job' && row.pct !== null)
    const withoutPct = result.current.rows.filter((row) => row.kind === 'job' && row.pct === null)
    expect(withPct).toHaveLength(12)
    expect(withoutPct).toHaveLength(3)

    // 第二次 tick 命中 30s 缓存：不再新增 getTask 调用，选中集合不变
    await act(async () => { result.current.refetch() })
    await waitFor(() => expect(vi.mocked(getCabin)).toHaveBeenCalledTimes(2))
    await flush()
    expect(vi.mocked(getTask)).toHaveBeenCalledTimes(12)
    expect(result.current.rows.filter((row) => row.kind === 'job' && row.pct !== null)).toHaveLength(12)
  })

  it('workflow / subagent 一律 pct=null，绝不出现假进度', async () => {
    wire({
      c1: {
        cabin: cabin('c1'),
        jobs: [
          job('w1', { kind: 'workflow', ref_id: 'e1', status: 'running' }),
          job('s1', { kind: 'subagent', ref_id: 'sub1', status: 'running' }),
        ],
      },
    })
    const { result } = renderHook(() => useFleetQuery())
    await waitFor(() => expect(result.current.rows).toHaveLength(2))
    expect(result.current.rows.map((row) => (row.kind === 'job' ? row.pct : 'n/a'))).toEqual([null, null])
    expect(vi.mocked(getTask)).not.toHaveBeenCalled()
  })

  it('getTask 失败：该行 pct 保持 null，不影响其它行', async () => {
    wire({
      c1: {
        cabin: cabin('c1'),
        jobs: [job('j1', { kind: 'task', ref_id: 'ok' }), job('j2', { kind: 'task', ref_id: 'bad' })],
      },
    })
    vi.mocked(getTask).mockImplementation(async (id: string) => {
      if (id === 'bad') throw new Error('boom')
      return task(id) as never
    })
    const { result } = renderHook(() => useFleetQuery())
    await waitFor(() => expect(result.current.rows).toHaveLength(2))
    const byKey = new Map(result.current.rows.map((row) => [row.key, row]))
    const okRow = byKey.get('job:j1')
    const badRow = byKey.get('job:j2')
    expect(okRow?.kind).toBe('job')
    expect(badRow?.kind).toBe('job')
    expect(okRow?.kind === 'job' ? okRow.pct : null).not.toBeNull()
    expect(badRow?.kind === 'job' ? badRow.pct : 'x').toBeNull()
  })

  it('task 没有 v4 phaseViews：pct=null（不拿 50% 回退当真实进度）', async () => {
    wire({ c1: { cabin: cabin('c1'), jobs: [job('j1', { kind: 'task', ref_id: 'no-phases' })] } })
    vi.mocked(getTask).mockImplementation(async (id: string) => task(id, { derived: {} }) as never)

    const { result } = renderHook(() => useFleetQuery())
    await waitFor(() => expect(result.current.rows).toHaveLength(1))
    const row = result.current.rows[0]
    expect(row.kind).toBe('job')
    expect(row.kind === 'job' ? row.pct : 'x').toBeNull()
  })
})

describe('useFleetQuery — 容错', () => {
  it('一舱失败不拖垮其它舱', async () => {
    vi.mocked(listCabins).mockResolvedValue([cabin('c1'), cabin('c2')])
    wire({
      c1: { cabin: cabin('c1'), fail: true },
      c2: { cabin: cabin('c2'), jobs: [job('j2', { cabin_id: 'c2', status: 'running' })] },
    })

    const { result } = renderHook(() => useFleetQuery())
    await waitFor(() => expect(result.current.rows).toHaveLength(1))
    expect(result.current.rows[0]).toMatchObject({ key: 'job:j2', cabinId: 'c2' })
    expect(result.current.counts).toMatchObject({ run: 1, jobs: 1, perCabin: { c2: 1 } })
    expect(result.current.error).toBeNull()
  })

  it('失败保留上一份快照（逐舱）', async () => {
    wire({ c1: { cabin: cabin('c1'), jobs: [job('j1', { status: 'running' })] } })
    const { result } = renderHook(() => useFleetQuery())
    await waitFor(() => expect(result.current.rows).toHaveLength(1))

    vi.mocked(getCabin).mockRejectedValue(new Error('network down'))
    await act(async () => { result.current.refetch() })
    await waitFor(() => expect(vi.mocked(getCabin)).toHaveBeenCalledTimes(2))
    await flush()

    expect(result.current.rows).toHaveLength(1)
    expect(result.current.rows[0].key).toBe('job:j1')
    expect(result.current.counts).toMatchObject({ run: 1, jobs: 1 })
  })

  it('listCabins 失败：保留上一份，loading 收尾并报错', async () => {
    wire({ c1: { cabin: cabin('c1'), jobs: [job('j1', { status: 'running' })] } })
    const { result } = renderHook(() => useFleetQuery())
    await waitFor(() => expect(result.current.rows).toHaveLength(1))

    vi.mocked(listCabins).mockRejectedValue(new Error('cabins offline'))
    await act(async () => { result.current.refetch() })
    await waitFor(() => expect(result.current.error).toBe('cabins offline'))
    expect(result.current.rows).toHaveLength(1)
    expect(result.current.loading).toBe(false)
  })

  it('sessions 拿不到 → counts.sessions=null（不是 0）', async () => {
    vi.mocked(listRunningSessions).mockRejectedValue(new Error('no sessions api'))
    const { result } = renderHook(() => useFleetQuery())
    await waitFor(() => expect(result.current.counts).not.toBeNull())
    expect(result.current.counts?.sessions).toBeNull()
  })

  it('首次加载所有舱都失败 → counts 保持 null（不写 0），error 有值', async () => {
    wire({ c1: { cabin: cabin('c1'), fail: true } })
    const { result } = renderHook(() => useFleetQuery())
    await waitFor(() => expect(result.current.error).not.toBeNull())
    expect(result.current.counts).toBeNull()
    expect(result.current.rows).toEqual([])
    expect(result.current.loading).toBe(false)
  })
})

describe('useFleetQuery — 轮询', () => {
  it('每 10s tick 一次', async () => {
    vi.useFakeTimers()
    try {
      renderHook(() => useFleetQuery())
      expect(vi.mocked(listCabins)).toHaveBeenCalledTimes(1)
      await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
      expect(vi.mocked(listCabins)).toHaveBeenCalledTimes(2)
      await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
      expect(vi.mocked(listCabins)).toHaveBeenCalledTimes(3)
    } finally {
      vi.useRealTimers()
    }
  })
})
