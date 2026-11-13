import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import type { CabinView } from '@octopus/shared'

vi.mock('@/lib/server-config', () => ({ getServerUrl: () => 'http://localhost:3001' }))
vi.mock('@/hooks/use-cabin', () => ({ useCabin: vi.fn() }))
vi.mock('@/lib/cabin-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/cabin-api')>()
  return {
    ...actual,
    listCabinJobs: vi.fn(),
    getCabinJob: vi.fn(),
    setCabinJobPriority: vi.fn(),
    setCabinFocus: vi.fn(),
    getCabinTrace: vi.fn(),
    listCabinRepos: vi.fn(),
    listCabinWorktrees: vi.fn(),
  }
})
vi.mock('@/lib/tasks-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/tasks-api')>()
  return { ...actual, listTasks: vi.fn(), getTask: vi.fn(), triggerTask: vi.fn() }
})

import { useCabin } from '@/hooks/use-cabin'
import {
  listCabinJobs, getCabinJob, setCabinJobPriority, setCabinFocus, getCabinTrace, listCabinRepos, listCabinWorktrees,
} from '@/lib/cabin-api'
import { listTasks, getTask } from '@/lib/tasks-api'
import { CabinProvider, useCabinContext } from '../cabin-provider'
import { CabinModulesLayer, CabinWinstrip } from '../CabinModulesLayer'
import { CabinTasks } from '../modules/CabinTasks'
import { CabinQueue } from '../modules/CabinQueue'

const mockUseCabin = vi.mocked(useCabin)

function makeView(overrides: Partial<CabinView> = {}): CabinView {
  return {
    cabin: {
      id: 'cabin-1', name: 'Aurora', path: '/tmp/a', workspace_id: 'ws-1', main_session_id: 'sess-1',
      requirements: '', status: 'active', mainline_strategy: 'clean-main', org: null,
      focused_job_id: null, version: 1, created_at: '', updated_at: '', last_active_at: null, archived_at: null,
    },
    attention: [],
    health: { running: 0, queued: 0, dormant: 0, workers: 0, max: 5 },
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

function OpenProbe({ ids }: { ids: string[] }) {
  const { openModule } = useCabinContext()
  return (
    <button data-testid="open-probe" onClick={() => ids.forEach((id) => openModule(id))}>open</button>
  )
}

beforeAll(() => {
  Element.prototype.setPointerCapture = vi.fn()
  Element.prototype.releasePointerCapture = vi.fn()
})

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getCabinTrace).mockResolvedValue([])
  vi.mocked(listCabinJobs).mockResolvedValue([])
  vi.mocked(listCabinRepos).mockResolvedValue([])
  vi.mocked(listCabinWorktrees).mockResolvedValue([])
  vi.mocked(listTasks).mockResolvedValue({ items: [] })
})

describe('CabinModulesLayer — 全几何（原型 openWin/drag/resize/max/min）', () => {
  it('开窗渲染模块 body；max 铺满；min 隐藏并进 winstrip；close 移除', async () => {
    mockCabin(makeView())
    vi.mocked(listTasks).mockResolvedValue({ items: [] })
    render(
      <CabinProvider cabinId="cabin-1">
        <OpenProbe ids={['tasks']} />
        <CabinWinstrip />
        <CabinModulesLayer />
      </CabinProvider>,
    )
    fireEvent.click(screen.getByTestId('open-probe'))
    const win = await screen.findByTestId('cabin-window')
    expect(win.getAttribute('data-win')).toBe('tasks')
    expect(screen.getByTestId('cabin-tasks-body')).toBeInTheDocument()
    expect(screen.getByTestId('cabin-winstrip')).toBeInTheDocument()

    // max → 100%
    fireEvent.click(screen.getByTestId('cabin-win-max-tasks'))
    expect((screen.getByTestId('cabin-window') as HTMLElement).style.width).toBe('100%')
    fireEvent.click(screen.getByTestId('cabin-win-max-tasks'))

    // min → 层里不可见，winstrip 带角标
    fireEvent.click(screen.getByTestId('cabin-win-min-tasks'))
    expect(screen.queryByTestId('cabin-window')).toBeNull()
    expect(screen.getByTestId('cabin-winstrip').querySelector('[data-winstrip="tasks"]')).not.toBeNull()

    // winstrip 点击恢复
    fireEvent.click(screen.getByTestId('cabin-winstrip').querySelector('[data-winstrip="tasks"]')!)
    expect(await screen.findByTestId('cabin-window')).toBeInTheDocument()

    // close → 全移除
    fireEvent.click(screen.getByTestId('cabin-win-close-tasks'))
    expect(screen.queryByTestId('cabin-window')).toBeNull()
    expect(screen.queryByTestId('cabin-winstrip')).toBeNull()
  })

  it('标题栏拖拽移动窗口；resize 手柄改尺寸', async () => {
    mockCabin(makeView())
    render(
      <CabinProvider cabinId="cabin-1">
        <OpenProbe ids={['engineering']} />
        <CabinModulesLayer />
      </CabinProvider>,
    )
    vi.mocked(listTasks).mockResolvedValue({ items: [] })
    fireEvent.click(screen.getByTestId('open-probe'))
    const win = await screen.findByTestId('cabin-window')
    const bar = win.querySelector('.cursor-grab') as HTMLElement
    fireEvent.pointerDown(bar, { clientX: 100, clientY: 100, pointerId: 1 })
    fireEvent.pointerMove(win, { clientX: 160, clientY: 140, pointerId: 1 })
    fireEvent.pointerUp(win, { pointerId: 1 })
    await waitFor(() => {
      expect((screen.getByTestId('cabin-window') as HTMLElement).style.left).toBe('60px')
      expect((screen.getByTestId('cabin-window') as HTMLElement).style.top).toBe('40px')
    })
    const handle = screen.getByTestId('cabin-win-resize-engineering')
    fireEvent.pointerDown(handle, { clientX: 500, clientY: 500, pointerId: 2 })
    fireEvent.pointerMove(win, { clientX: 200, clientY: 200, pointerId: 2 })
    fireEvent.pointerUp(win, { pointerId: 2 })
    await waitFor(() => {
      expect((screen.getByTestId('cabin-window') as HTMLElement).style.width).toBe('560px')
      expect((screen.getByTestId('cabin-window') as HTMLElement).style.height).toBe('320px')
    })
  })
})

describe('CabinTasks — 四列 kanban（classic-v3）', () => {
  it('按派生状态归四列，点卡发 octopus:open-task', async () => {
    mockCabin(makeView())
    const task = (id: string, status: string) => ({
      id, name: `任务${id}`, status, repo_group: 'pay', workflow_ref: 'dev',
      task_spec: { goal: '', ac: [] }, version: 1, created_at: '', updated_at: '',
    })
    const items = [task('t1', 'running'), task('t2', 'failed'), task('t3', 'aborted'), task('t4', 'awaiting_review')]
    vi.mocked(listTasks).mockResolvedValue({ items: items as never })
    vi.mocked(getTask).mockImplementation(async (id: string) => ({
      ...items.find((t) => t.id === id),
      executions: [],
    }) as never)
    const spy = vi.fn()
    window.addEventListener('octopus:open-task', spy)
    render(
      <CabinProvider cabinId="cabin-1">
        <CabinTasks />
      </CabinProvider>,
    )
    await screen.findByTestId('cabin-kanban')
    await waitFor(() => {
      expect(screen.getByTestId('cabin-kanban').querySelectorAll('[data-task-column]')).toHaveLength(4)
      expect(screen.getByTestId('cabin-kanban').querySelector('[data-task-column="running"]')?.textContent).toContain('任务t1')
      expect(screen.getByTestId('cabin-kanban').querySelector('[data-task-column="review"]')?.textContent).toContain('任务t4')
      expect(screen.getByTestId('cabin-kanban').querySelector('[data-task-column="done"]')?.textContent).toContain('任务t2')
      expect(screen.getByTestId('cabin-kanban').querySelector('[data-task-column="done"]')?.textContent).toContain('任务t3')
    })
    fireEvent.click(screen.getByTestId('cabin-kanban').querySelector('[data-task-card="t2"]')!)
    expect(spy).toHaveBeenCalled()
    window.removeEventListener('octopus:open-task', spy)
  })

  it('迭代筛选：点 M1 只剩该迭代任务', async () => {
    mockCabin(makeView({
      iterations: [{
        id: 'i1', cabin_id: 'cabin-1', code: 'M1', name: '渠道接入',
        sort_order: 0, status: 'active', progress: 50, task_count: 1,
      }],
    }))
    const task = (id: string, iteration_id: string | null) => ({
      id, name: `任务${id}`, status: 'running', iteration_id, repo_group: 'pay', workflow_ref: 'dev',
      task_spec: { goal: '', ac: [] }, version: 1, created_at: '', updated_at: '',
    })
    const items = [task('t1', 'i1'), task('t2', null)]
    vi.mocked(listTasks).mockResolvedValue({ items: items as never })
    vi.mocked(getTask).mockImplementation(async (id: string) => ({
      ...items.find((t) => t.id === id),
      executions: [],
    }) as never)
    render(
      <CabinProvider cabinId="cabin-1">
        <CabinTasks />
      </CabinProvider>,
    )
    await screen.findByTestId('cabin-tasks-iters')
    fireEvent.click(screen.getByTestId('cabin-tasks-iter-i1'))
    await waitFor(() => {
      const body = screen.getByTestId('cabin-kanban')
      expect(body.textContent).toContain('任务t1')
      expect(body.textContent).not.toContain('任务t2')
    })
    fireEvent.click(screen.getByTestId('cabin-tasks-iter-all'))
    await waitFor(() => expect(screen.getByTestId('cabin-kanban').textContent).toContain('任务t2'))
  })
})

describe('CabinJobDetail — 提优先/聚焦/对接', () => {
  function JobOpener() {
    const { openJobDetail } = useCabinContext()
    return <button data-testid="open-job-probe" onClick={() => openJobDetail('j1')}>open</button>
  }

  it('提优先 priority+1；聚焦调 setFocus；对接 tab 展示三方', async () => {
    mockCabin(makeView())
    vi.mocked(listCabinJobs).mockResolvedValue([
      {
        id: 'j1', cabin_id: 'cabin-1', kind: 'task', ref_id: 't1', session_id: null,
        iteration_id: null, title: '接入渠道', mandate: null, prompt: '把渠道接进来', priority: 2,
        created_at: '', ended_at: null, status: 'running', transport: 'task-thread', iteration_code: 'M1',
      },
    ])
    vi.mocked(getCabinJob).mockResolvedValue({
      job: {
        id: 'j1', cabin_id: 'cabin-1', kind: 'task', ref_id: 't1', session_id: null,
        iteration_id: null, title: '接入渠道', mandate: null, prompt: '把渠道接进来', priority: 2,
        created_at: '2026-11-13T14:00:00.000Z', ended_at: null,
      },
      events: [
        {
          id: 'e1', job_id: 'j1', cabin_id: 'cabin-1', kind: 'dispatch', actor: 'orchestrator',
          payload: { summary: '派发接入渠道' }, created_at: '2026-11-13T14:00:00.000Z',
        },
      ],
    })
    vi.mocked(setCabinJobPriority).mockResolvedValue({ ok: true })
    vi.mocked(setCabinFocus).mockResolvedValue(makeView().cabin as never)
    render(
      <CabinProvider cabinId="cabin-1">
        <JobOpener />
        <CabinModulesLayer />
      </CabinProvider>,
    )
    await screen.findByTestId('open-job-probe')
    fireEvent.click(screen.getByTestId('open-job-probe'))
    await screen.findByTestId('cabin-job-detail')
    expect(screen.getByTestId('cabin-job-detail').textContent).toContain('接入渠道')
    fireEvent.click(await screen.findByTestId('cabin-job-priority'))
    await waitFor(() => expect(setCabinJobPriority).toHaveBeenCalledWith('cabin-1', 'j1', 3))
    fireEvent.click(screen.getByTestId('cabin-job-focus'))
    await waitFor(() => expect(setCabinFocus).toHaveBeenCalledWith('cabin-1', 1, 'j1'))
    fireEvent.click(screen.getByTestId('cabin-job-tab-relay'))
    expect((await screen.findByTestId('cabin-job-relay')).textContent).toContain('汐音')
    expect(screen.getByTestId('cabin-job-relay').textContent).toContain('把渠道接进来')
  })
})

describe('CabinQueue — 单线程路由（C4）', () => {
  it('attention 派生排队行；优先路由打开任务；第二条不打断当前（已优先）', async () => {
    const view = makeView({
      attention: [
        { id: 'a1', job_id: null, stage: 'review', awaiting: 'person', title: '任务A 待验收', task_id: 't1', repo: 'pay', wt: null, deep_link: null, priority: 0 },
        { id: 'a2', job_id: null, stage: 'answer', awaiting: 'person', title: '问题B', task_id: null, repo: null, wt: null, deep_link: null, priority: 0 },
      ],
    })
    mockCabin(view)
    const spy = vi.fn()
    window.addEventListener('octopus:open-task', spy)
    render(
      <CabinProvider cabinId="cabin-1">
        <CabinQueue />
      </CabinProvider>,
    )
    await screen.findByTestId('cabin-queue-body')
    expect(screen.getByTestId('cabin-queue-body').textContent).toContain('待路由')
    fireEvent.click(screen.getByTestId('cabin-queue-route-a1'))
    expect(spy).toHaveBeenCalledTimes(1)
    expect((spy.mock.calls[0][0] as CustomEvent).detail).toEqual({ taskId: 't1', view: 'acceptance' })
    expect(screen.getByTestId('cabin-queue-body').querySelector('[data-comm-row="a1"]')?.getAttribute('data-comm-state')).toBe('processing')
    // 单线程：第二条 → 已优先，不打断
    fireEvent.click(screen.getByTestId('cabin-queue-route-a2'))
    expect(spy).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('cabin-queue-body').textContent).toContain('已优先')
    window.removeEventListener('octopus:open-task', spy)
  })
})
