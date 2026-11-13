import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import type { CabinView } from '@octopus/shared'

vi.mock('@/lib/server-config', () => ({ getServerUrl: () => 'http://localhost:3001' }))
vi.mock('@/hooks/use-cabin', () => ({ useCabin: vi.fn() }))
vi.mock('@/lib/billing-currency', () => ({ useBillingCurrency: () => ({ currency: 'CNY', rate: 7 }) }))
vi.mock('@/lib/cabin-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/cabin-api')>()
  return {
    ...actual,
    listCabinJobs: vi.fn(),
    getCabinJob: vi.fn(),
    getCabinTrace: vi.fn(),
    getCabinUsage: vi.fn(),
    getCabinFindings: vi.fn(),
    listCabinRepos: vi.fn(),
    listCabinWorktrees: vi.fn(),
    pullCabinRepo: vi.fn(),
  }
})
vi.mock('@/lib/tasks-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/tasks-api')>()
  return { ...actual, listTasks: vi.fn(), getTask: vi.fn(), triggerTask: vi.fn() }
})

import { useCabin } from '@/hooks/use-cabin'
import {
  listCabinJobs, getCabinTrace, getCabinUsage, getCabinFindings,
  listCabinRepos, listCabinWorktrees,
} from '@/lib/cabin-api'
import { listTasks, getTask } from '@/lib/tasks-api'
import { CabinProvider, useCabinContext } from '../cabin-provider'
import { CabinOverview } from '../CabinOverview'
import { CabinFleet } from '../CabinFleet'
import { CabinEngineering } from '../modules/CabinEngineering'
import { CabinRecords } from '../modules/CabinRecords'

const mockUseCabin = vi.mocked(useCabin)

function makeView(overrides: Partial<CabinView> = {}): CabinView {
  return {
    cabin: {
      id: 'cabin-1', name: 'Aurora', path: '/tmp/a', workspace_id: 'ws-1', main_session_id: 'sess-1',
      requirements: '', status: 'active', mainline_strategy: 'clean-main', org: null,
      focused_job_id: null, version: 1, created_at: '', updated_at: '', last_active_at: null, archived_at: null,
    },
    attention: [],
    health: { running: 1, queued: 0, dormant: 0, workers: 1, max: 5 },
    iterations: [],
    open_findings: 0,
    ...overrides,
  }
}

function mockCabin(view: CabinView) {
  mockUseCabin.mockReturnValue({
    cabin: view.cabin as never,
    view,
    initState: null,
    loading: false,
    error: null,
    refresh: vi.fn().mockResolvedValue(undefined),
  })
}

function task(id: string, over: Record<string, unknown> = {}) {
  return {
    id, name: `任务${id}`, status: 'running', iteration_id: null, repo_group: 'pay', workflow_ref: 'dev',
    task_spec: { goal: '', ac: [] }, version: 1, created_at: '', updated_at: '', ...over,
  }
}

function job(id: string, over: Record<string, unknown> = {}) {
  return {
    id, cabin_id: 'cabin-1', kind: 'task', ref_id: 't1', session_id: null, iteration_id: null,
    title: `作业${id}`, mandate: null, prompt: null, priority: 0, created_at: '2026-11-13T10:00:00.000Z',
    ended_at: null, status: 'running', transport: 'task-thread', iteration_code: null, ...over,
  }
}

function WindowProbe() {
  const { openWindows, taskIter } = useCabinContext()
  return <div data-testid="window-probe">{openWindows.join(',')}|{taskIter ?? ''}</div>
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getCabinUsage).mockResolvedValue({
    grand: { totals: { cost: { usd: 1, complete: true } } },
  } as never)
  vi.mocked(getCabinFindings).mockResolvedValue([] as never)
  vi.mocked(getCabinTrace).mockResolvedValue([])
  vi.mocked(listCabinJobs).mockResolvedValue([])
  vi.mocked(listCabinRepos).mockResolvedValue([])
  vi.mocked(listCabinWorktrees).mockResolvedValue([])
  vi.mocked(listTasks).mockResolvedValue({ items: [] })
})

describe('CabinOverview — classic-v3 三入口', () => {
  it('只有任务/工程/记录三张门卡；点门卡开对应窗；点迭代带筛选开任务窗', async () => {
    mockCabin(makeView({
      iterations: [{
        id: 'i1', cabin_id: 'cabin-1', code: 'M1', name: '渠道接入',
        sort_order: 0, status: 'active', progress: 50, task_count: 1,
      }],
    }))
    vi.mocked(listCabinWorktrees).mockResolvedValue([
      { repo: 'aurora', worktrees: [{ path: '/w1', head: 'h1', branch: 'feat-x' }] },
    ])
    const items = [task('t1', { iteration_id: 'i1' }), task('t2')]
    vi.mocked(listTasks).mockResolvedValue({ items: items as never })

    render(
      <CabinProvider cabinId="cabin-1">
        <CabinOverview />
        <WindowProbe />
      </CabinProvider>,
    )
    await screen.findByTestId('cabin-hub-doors')
    expect(screen.getAllByTestId(/^cabin-hub-door-/)).toHaveLength(3)
    expect(screen.getByTestId('cabin-hub-door-tasks').textContent).toContain('任务')
    expect(screen.getByTestId('cabin-hub-door-engineering').textContent).toContain('工程')
    expect(screen.getByTestId('cabin-hub-door-records').textContent).toContain('记录')

    fireEvent.click(screen.getByTestId('cabin-hub-door-engineering'))
    await waitFor(() => expect(screen.getByTestId('window-probe').textContent).toContain('engineering'))

    fireEvent.click(await screen.findByTestId('cabin-iteration-M1'))
    await waitFor(() => {
      expect(screen.getByTestId('window-probe').textContent).toContain('tasks')
      expect(screen.getByTestId('window-probe').textContent).toContain('i1')
    })
  })
})

describe('CabinEngineering — 仓库展开工作树', () => {
  it('默认折叠；点仓库行展开工作树', async () => {
    mockCabin(makeView())
    vi.mocked(listCabinRepos).mockResolvedValue([
      { name: 'aurora', git: { branch: 'main', detached: false, commit: 'abc1234', msg: 'init' } },
    ])
    vi.mocked(listCabinWorktrees).mockResolvedValue([
      { repo: 'aurora', worktrees: [{ path: '/w1', head: 'h1', branch: 'feat-x' }] },
    ])
    vi.mocked(getTask).mockResolvedValue(task('t1') as never)

    render(
      <CabinProvider cabinId="cabin-1">
        <CabinEngineering />
      </CabinProvider>,
    )
    const repoRow = await screen.findByTestId('cabin-eng-repo-aurora')
    expect(screen.queryByTestId('cabin-eng-worktrees-aurora')).toBeNull()
    expect(repoRow.textContent).toContain('1 工作树')

    fireEvent.click(repoRow)
    const box = await screen.findByTestId('cabin-eng-worktrees-aurora')
    expect(box.textContent).toContain('feat-x')

    fireEvent.click(repoRow)
    await waitFor(() => expect(screen.queryByTestId('cabin-eng-worktrees-aurora')).toBeNull())
  })
})

describe('CabinRecords — 归档 / Trace 两标签', () => {
  it('默认归档；切到通信 Trace', async () => {
    mockCabin(makeView())
    render(
      <CabinProvider cabinId="cabin-1">
        <CabinRecords />
      </CabinProvider>,
    )
    await screen.findByTestId('cabin-records-body')
    expect(screen.getByTestId('cabin-archive-body')).toBeInTheDocument()
    expect(screen.queryByTestId('cabin-trace-body')).toBeNull()

    fireEvent.click(screen.getByTestId('cabin-records-tab-trace'))
    expect(await screen.findByTestId('cabin-trace-body')).toBeInTheDocument()
    expect(screen.queryByTestId('cabin-archive-body')).toBeNull()

    fireEvent.click(screen.getByTestId('cabin-records-tab-archive'))
    expect(await screen.findByTestId('cabin-archive-body')).toBeInTheDocument()
  })
})

describe('CabinFleet — 编队面板', () => {
  it('行 = live 在前；点行开作业详情', async () => {
    mockCabin(makeView())
    vi.mocked(listCabinJobs).mockResolvedValue([
      job('j1', { title: '接入支付宝', status: 'running' }),
      job('j2', { kind: 'workflow', ref_id: 'e1', title: '对账流', status: 'completed', ended_at: '2026-11-13T11:00:00.000Z' }),
    ] as never)
    vi.mocked(listTasks).mockResolvedValue({ items: [task('t1')] as never })
    vi.mocked(getTask).mockResolvedValue(task('t1') as never)

    render(
      <CabinProvider cabinId="cabin-1">
        <CabinFleet />
        <WindowProbe />
      </CabinProvider>,
    )
    const rows = await screen.findAllByTestId(/^cabin-fleet-row-/)
    expect(rows).toHaveLength(2)
    expect(rows[0].textContent).toContain('接入支付宝')
    expect(rows[1].textContent).toContain('对账流')

    fireEvent.click(rows[0])
    await waitFor(() => expect(screen.getByTestId('window-probe').textContent).toContain('job'))
  })

  it('没有 job 账本时回退为活态任务', async () => {
    mockCabin(makeView())
    vi.mocked(listCabinJobs).mockResolvedValue([])
    vi.mocked(listTasks).mockResolvedValue({ items: [task('t1', { status: 'running' }), task('t2', { status: 'done' })] as never })
    vi.mocked(getTask).mockImplementation(async (id: string) => (id === 't1' ? task('t1') : task('t2', { status: 'done' })) as never)

    render(
      <CabinProvider cabinId="cabin-1">
        <CabinFleet />
      </CabinProvider>,
    )
    const rows = await screen.findAllByTestId(/^cabin-fleet-row-/)
    expect(rows).toHaveLength(1)
    expect(rows[0].textContent).toContain('任务t1')
  })
})
