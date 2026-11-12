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
  listCabinJobs, setCabinJobPriority, setCabinFocus, getCabinTrace, listCabinRepos,
} from '@/lib/cabin-api'
import { listTasks, getTask } from '@/lib/tasks-api'
import { CabinProvider, useCabinContext } from '../cabin-provider'
import { CabinModulesLayer, CabinWinstrip } from '../CabinModulesLayer'
import { CabinTasks } from '../modules/CabinTasks'
import { CabinJobs } from '../modules/CabinJobs'
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
        <OpenProbe ids={['repos']} />
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
    const handle = screen.getByTestId('cabin-win-resize-repos')
    fireEvent.pointerDown(handle, { clientX: 500, clientY: 500, pointerId: 2 })
    fireEvent.pointerMove(win, { clientX: 200, clientY: 200, pointerId: 2 })
    fireEvent.pointerUp(win, { pointerId: 2 })
    await waitFor(() => {
      expect((screen.getByTestId('cabin-window') as HTMLElement).style.width).toBe('520px')
      expect((screen.getByTestId('cabin-window') as HTMLElement).style.height).toBe('360px')
    })
  })
})

describe('CabinTasks — 八列 kanban（failed/aborted 独立态）', () => {
  it('按派生状态归列，点卡发 octopus:open-task', async () => {
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
      expect(screen.getByTestId('cabin-kanban').querySelector('[data-task-column="failed"]')?.textContent).toContain('任务t2')
      expect(screen.getByTestId('cabin-kanban').querySelector('[data-task-column="aborted"]')?.textContent).toContain('任务t3')
      expect(screen.getByTestId('cabin-kanban').querySelector('[data-task-column="running"]')?.textContent).toContain('任务t1')
    })
    fireEvent.click(screen.getByTestId('cabin-kanban').querySelector('[data-task-card="t2"]')!)
    expect(spy).toHaveBeenCalled()
    window.removeEventListener('octopus:open-task', spy)
  })
})

describe('CabinJobs — 提优先/聚焦/trace 下钻', () => {
  it('提优先 priority+1；聚焦调 setFocus；trace 开窗带过滤', async () => {
    mockCabin(makeView())
    vi.mocked(listCabinJobs).mockResolvedValue([
      {
        id: 'j1', cabin_id: 'cabin-1', kind: 'task', ref_id: 't1', session_id: null,
        iteration_id: null, title: '接入渠道', mandate: null, prompt: null, priority: 2,
        created_at: '', ended_at: null, status: 'running', transport: 'task-thread', iteration_code: 'M1',
      },
    ])
    vi.mocked(setCabinJobPriority).mockResolvedValue({ ok: true })
    vi.mocked(setCabinFocus).mockResolvedValue(makeView().cabin as never)
    render(
      <CabinProvider cabinId="cabin-1">
        <CabinJobs />
        <CabinModulesLayer />
      </CabinProvider>,
    )
    await screen.findByTestId('cabin-jobs-body')
    await waitFor(() => expect(screen.getByTestId('cabin-job-priority-j1')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('cabin-job-priority-j1'))
    await waitFor(() => expect(setCabinJobPriority).toHaveBeenCalledWith('cabin-1', 'j1', 3))
    fireEvent.click(screen.getByTestId('cabin-job-focus-j1'))
    await waitFor(() => expect(setCabinFocus).toHaveBeenCalledWith('cabin-1', 1, 'j1'))
    fireEvent.click(screen.getByTestId('cabin-job-trace-j1'))
    expect(await screen.findByTestId('cabin-trace-body')).toBeInTheDocument()
    expect((screen.getByTestId('cabin-trace-filter') as HTMLSelectElement).value).toBe('j1')
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
