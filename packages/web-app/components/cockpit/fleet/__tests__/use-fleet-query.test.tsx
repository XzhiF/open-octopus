// S2：useFleetQuery 轮询/容错/富化测试 —— 全 mock API，不打真服务。
// 覆盖：入口舱单舱 job、空舱、历史舱回退、attention 合并（含 job_id=null）、
// 富化上限 12 + 30s 缓存 + pct=null、失败保留快照、arrivals、sessions=null、
// 不请求别的舱、10s 轮询。

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { CabinAttentionItem, CabinView } from '@octopus/shared'

vi.mock('@/lib/server-config', () => ({ getServerUrl: () => 'http://localhost:3001' }))
vi.mock('@/lib/cabin-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/cabin-api')>()
  return { ...actual, getCabin: vi.fn(), listCabinJobs: vi.fn() }
})
vi.mock('@/lib/tasks-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/tasks-api')>()
  return { ...actual, listTasks: vi.fn(), getTask: vi.fn() }
})
vi.mock('@/lib/agent/api', () => ({ listRunningSessions: vi.fn() }))

import {
  getCabin,
  listCabinJobs,
  type CabinDetail,
  type CabinJobView,
} from '@/lib/cabin-api'
import { getTask, listTasks } from '@/lib/tasks-api'
import { listRunningSessions } from '@/lib/agent/api'
import { useFleetQuery, FLEET_TICK_TIMEOUT_MS, CABIN_REQUEST_TIMEOUT_MS } from '../use-fleet-query'

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
    title: `作业${id}`,
    mandate: null,
    prompt: null,
    created_at: '2026-11-14T00:00:00.000Z',
    ended_at: null,
    status: 'running',
    transport: 'task-thread',
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
  vi.mocked(listRunningSessions).mockResolvedValue({ items: [] } as never)
  vi.mocked(listTasks).mockResolvedValue({ items: [] } as never)
  vi.mocked(getTask).mockImplementation(async (id: string) => task(id) as never)
  wire({ c1: { cabin: cabin('c1') } })
})

describe('useFleetQuery — 基础装配', () => {
  it('单舱单 job：1 条 job 行、counts 非空、workflow 的 pct=null', async () => {
    wire({ c1: { cabin: cabin('c1', '测试作战舱'), jobs: [job('j1', { kind: 'workflow', status: 'running' })] } })
    vi.mocked(listRunningSessions).mockResolvedValue({ items: [{ id: 's1' }, { id: 's2' }] } as never)

    const { result } = renderHook(() => useFleetQuery('c1'))
    await waitFor(() => expect(result.current.rows).toHaveLength(1))
    await waitFor(() => expect(result.current.counts?.sessions).toBe(2))

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

  it('作者流相位：session_id 命中的 job 行带上 live_phase（等后台 → 琥珀秒表）', async () => {
    wire({
      c1: {
        cabin: cabin('c1'),
        jobs: [job('j1', { status: 'awaiting_review', agent_running: true, session_id: 's1' })],
      },
    })
    vi.mocked(listRunningSessions).mockResolvedValue({
      items: [{ id: 's1', phase: 'background-wait' }],
    } as never)

    const { result } = renderHook(() => useFleetQuery('c1'))
    await waitFor(() => {
      expect(result.current.rows[0]).toMatchObject({ key: 'job:j1', live_phase: 'background-wait' })
    })
  })

  it('只轮询入口舱：别的舱有作业也不请求、不进编队', async () => {
    wire({
      c1: { cabin: cabin('c1') },
      c2: { cabin: cabin('c2'), jobs: [job('j2', { cabin_id: 'c2', status: 'running' })] },
    })

    const { result } = renderHook(() => useFleetQuery('c1'))
    await waitFor(() => expect(result.current.counts).not.toBeNull())
    expect(result.current.rows).toEqual([])
    expect(vi.mocked(getCabin).mock.calls.map(([id]) => id)).toEqual(['c1'])
    expect(vi.mocked(listCabinJobs).mock.calls.map(([id]) => id)).toEqual(['c1'])
  })

  it('空舱（有舱无 job 无任务）：rows 空、counts 全 0', async () => {
    wire({ c1: { cabin: cabin('c1') } })
    const { result } = renderHook(() => useFleetQuery('c1'))
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

    const { result } = renderHook(() => useFleetQuery('c1'))
    await waitFor(() => expect(result.current.rows).toHaveLength(3))

    expect(result.current.rows.every((row) => row.kind === 'task')).toBe(true)
    expect(result.current.rows.map((row) => row.key).sort()).toEqual(['task:t1', 'task:t2', 'task:t3'])
    expect(result.current.counts).toMatchObject({ run: 1, queue: 1, need: 1, jobs: 3 })
    expect(vi.mocked(listTasks)).toHaveBeenCalledWith({ cabin_id: 'c1' }, expect.any(AbortSignal))
    expect(vi.mocked(getTask)).not.toHaveBeenCalled() // 回退不触发 N+1 富化
  })

  it('有 job 账本时不再调 listTasks', async () => {
    wire({ c1: { cabin: cabin('c1'), jobs: [job('j1')] } })
    const { result } = renderHook(() => useFleetQuery('c1'))
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
          attention('a-matched', { job_id: 'j1' }),
          attention('finding-1', { job_id: null, stage: 'adjudicate' }),
        ],
      },
    })

    const { result } = renderHook(() => useFleetQuery('c1'))
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

    const { result } = renderHook(() => useFleetQuery('c1'))
    await waitFor(() => expect(result.current.rows).toHaveLength(1))
    expect(result.current.arrivals).toEqual([])

    attentionItems = [attention('a1'), attention('a2')]
    await act(async () => { result.current.refetch() })
    await waitFor(() => expect(result.current.arrivals).toEqual(['a2']))

    await act(async () => { result.current.refetch() })
    await flush()
    expect(result.current.arrivals).toEqual([])
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

    const { result } = renderHook(() => useFleetQuery('c1'))
    // 行先出（不等富化），pct 随后补上。
    await waitFor(() => expect(result.current.rows).toHaveLength(15))
    await waitFor(() =>
      expect(result.current.rows.filter((row) => row.kind === 'job' && row.pct !== null)).toHaveLength(12),
    )

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
    const { result } = renderHook(() => useFleetQuery('c1'))
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
    const { result } = renderHook(() => useFleetQuery('c1'))
    await waitFor(() => expect(result.current.rows).toHaveLength(2))
    await waitFor(() => {
      const ok = result.current.rows.find((row) => row.key === 'job:j1')
      expect(ok?.kind === 'job' ? ok.pct : null).not.toBeNull()
    })
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

    const { result } = renderHook(() => useFleetQuery('c1'))
    await waitFor(() => expect(result.current.rows).toHaveLength(1))
    await waitFor(() => expect(vi.mocked(getTask)).toHaveBeenCalled())
    await flush()
    const row = result.current.rows[0]
    expect(row.kind).toBe('job')
    expect(row.kind === 'job' ? row.pct : 'x').toBeNull()
  })
})

describe('useFleetQuery — 容错', () => {
  it('舱详情失败：保留上一份快照并照常出作业行', async () => {
    wire({ c1: { cabin: cabin('c1'), jobs: [job('j1', { status: 'running' })] } })
    const { result } = renderHook(() => useFleetQuery('c1'))
    await waitFor(() => expect(result.current.rows).toHaveLength(1))

    vi.mocked(getCabin).mockRejectedValue(new Error('network down'))
    await act(async () => { result.current.refetch() })
    await waitFor(() => expect(vi.mocked(getCabin)).toHaveBeenCalledTimes(2))
    await flush()

    expect(result.current.rows).toHaveLength(1)
    expect(result.current.rows[0].key).toBe('job:j1')
    expect(result.current.counts).toMatchObject({ run: 1, jobs: 1 })
  })

  it('作业列表失败：保留上一份快照，loading 收尾并标 stale', async () => {
    wire({ c1: { cabin: cabin('c1'), jobs: [job('j1', { status: 'running' })] } })
    const { result } = renderHook(() => useFleetQuery('c1'))
    await waitFor(() => expect(result.current.rows).toHaveLength(1))

    vi.mocked(listCabinJobs).mockRejectedValue(new Error('jobs offline'))
    await act(async () => { result.current.refetch() })
    await waitFor(() => expect(result.current.error).toBe('jobs offline'))
    expect(result.current.rows).toHaveLength(1)
    expect(result.current.loading).toBe(false)
  })

  it('sessions 拿不到 → counts.sessions=null（不是 0）', async () => {
    vi.mocked(listRunningSessions).mockRejectedValue(new Error('no sessions api'))
    const { result } = renderHook(() => useFleetQuery('c1'))
    await waitFor(() => expect(result.current.counts).not.toBeNull())
    expect(result.current.counts?.sessions).toBeNull()
  })

  it('首次加载失败 → counts 保持 null（不写 0），error 有值', async () => {
    wire({ c1: { cabin: cabin('c1'), fail: true } })
    const { result } = renderHook(() => useFleetQuery('c1'))
    await waitFor(() => expect(result.current.error).not.toBeNull())
    expect(result.current.counts).toBeNull()
    expect(result.current.rows).toEqual([])
    expect(result.current.loading).toBe(false)
  })

  it('请求吊死：单请求预算到点收尾并报超时（不永久停在「载入编队…」）', async () => {
    vi.useFakeTimers()
    try {
      vi.mocked(getCabin).mockImplementation(() => new Promise(() => {}))
      vi.mocked(listCabinJobs).mockImplementation(() => new Promise(() => {}))
      const { result } = renderHook(() => useFleetQuery('c1'))
      expect(result.current.loading).toBe(true)

      await act(async () => { await vi.advanceTimersByTimeAsync(FLEET_TICK_TIMEOUT_MS) })

      expect(result.current.loading).toBe(false)
      expect(result.current.counts).toBeNull()
      expect(result.current.error).toContain('超时')
    } finally {
      vi.useRealTimers()
    }
  })

  it('舱详情吊死：作业列表照常出图（classic 看得到的作业不会消失）', async () => {
    vi.useFakeTimers()
    try {
      vi.mocked(getCabin).mockImplementation(() => new Promise(() => {}))
      wire({ c1: { cabin: cabin('c1'), jobs: [job('j1', { status: 'running' })] } })

      const { result } = renderHook(() => useFleetQuery('c1'))
      expect(result.current.loading).toBe(true)

      await act(async () => { await vi.advanceTimersByTimeAsync(CABIN_REQUEST_TIMEOUT_MS) })

      expect(result.current.loading).toBe(false)
      expect(result.current.rows.map((row) => row.key)).toEqual(['job:j1'])
      expect(result.current.counts).toMatchObject({ jobs: 1, run: 1 })
      expect(result.current.error).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('作业列表吊死：单请求预算到点就收尾并报出是哪一段', async () => {
    vi.useFakeTimers()
    try {
      vi.mocked(listCabinJobs).mockImplementation(() => new Promise(() => {}))
      const { result } = renderHook(() => useFleetQuery('c1'))
      expect(result.current.loading).toBe(true)

      await act(async () => { await vi.advanceTimersByTimeAsync(CABIN_REQUEST_TIMEOUT_MS) })

      expect(result.current.loading).toBe(false)
      expect(result.current.counts).toBeNull()
      expect(result.current.error).toContain('作业列表超时')
    } finally {
      vi.useRealTimers()
    }
  })

  it('富化吊死：作业行照常发布（进度条永远不挡编队）', async () => {
    wire({ c1: { cabin: cabin('c1'), jobs: [job('j1', { kind: 'task', ref_id: 'slow' })] } })
    vi.mocked(getTask).mockImplementation(() => new Promise(() => {}))

    const { result } = renderHook(() => useFleetQuery('c1'))
    await waitFor(() => expect(result.current.rows).toHaveLength(1))

    expect(result.current.loading).toBe(false)
    expect(result.current.counts).toMatchObject({ jobs: 1, perCabin: { c1: 1 } })
    const row = result.current.rows[0]
    expect(row.kind === 'job' ? row.pct : 'x').toBeNull()
  })

  it('分身数吊死：编队行不等它', async () => {
    vi.mocked(listRunningSessions).mockImplementation(() => new Promise(() => {}) as never)
    wire({ c1: { cabin: cabin('c1'), jobs: [job('j1')] } })

    const { result } = renderHook(() => useFleetQuery('c1'))
    await waitFor(() => expect(result.current.rows).toHaveLength(1))
    expect(result.current.counts).toMatchObject({ jobs: 1, sessions: null })
  })
})

describe('useFleetQuery — 轮询', () => {
  it('每 10s tick 一次', async () => {
    vi.useFakeTimers()
    try {
      renderHook(() => useFleetQuery('c1'))
      // 每个请求都走 withDeadline（微任务后才真正发请求）。
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      expect(vi.mocked(listCabinJobs)).toHaveBeenCalledTimes(1)
      await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
      expect(vi.mocked(listCabinJobs)).toHaveBeenCalledTimes(2)
      await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
      expect(vi.mocked(listCabinJobs)).toHaveBeenCalledTimes(3)
    } finally {
      vi.useRealTimers()
    }
  })
})
