import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import type { CabinAttentionItem, CabinView } from '@octopus/shared'

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
  return {
    ...actual,
    listTasks: vi.fn(), getTask: vi.fn(), triggerTask: vi.fn(),
    readyTask: vi.fn(), resumeTask: vi.fn(),
  }
})

import { useCabin } from '@/hooks/use-cabin'
import {
  listCabinJobs, getCabinTrace, getCabinUsage, getCabinFindings,
  listCabinRepos, listCabinWorktrees,
} from '@/lib/cabin-api'
import { listTasks, getTask, readyTask, resumeTask, triggerTask } from '@/lib/tasks-api'
import { CabinProvider, useCabinContext } from '../cabin-provider'
import { CabinOverview } from '../CabinOverview'
import { CabinFleet } from '../CabinFleet'
import { CabinInbox } from '../CabinInbox'
import { AskWindowsProvider, useAskWindows } from '../asks/ask-windows-provider'
import { CabinEngineering } from '../modules/CabinEngineering'
import { CabinRecords } from '../modules/CabinRecords'

const mockUseCabin = vi.mocked(useCabin)

function makeView(overrides: Partial<CabinView> = {}): CabinView {
  return {
    cabin: {
      id: 'cabin-1', name: 'Aurora', path: '/tmp/a', workspace_id: 'ws-1', main_session_id: 'sess-1',
      requirements: '', status: 'active', mainline_strategy: 'clean-main', org: null,
      version: 1, created_at: '', updated_at: '', last_active_at: null, archived_at: null,
    },
    attention: [],
    health: { running: 1, queued: 0, dormant: 0, workers: 1, max: 5 },
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
    id, name: `任务${id}`, status: 'running', repo_group: 'pay', workflow_ref: 'dev',
    task_spec: { goal: '', ac: [] }, version: 1, created_at: '', updated_at: '', ...over,
  }
}

function job(id: string, over: Record<string, unknown> = {}) {
  return {
    id, cabin_id: 'cabin-1', kind: 'task', ref_id: 't1', session_id: null,
    title: `作业${id}`, mandate: null, prompt: null, created_at: '2026-11-13T10:00:00.000Z',
    ended_at: null, status: 'running', transport: 'task-thread', ...over,
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
  it('只有任务/工程/记录三张门卡；点门卡开对应窗', async () => {
    mockCabin(makeView())
    vi.mocked(listCabinWorktrees).mockResolvedValue([
      { repo: 'aurora', worktrees: [{ path: '/w1', head: 'h1', branch: 'feat-x' }] },
    ])
    vi.mocked(listTasks).mockResolvedValue({ items: [task('t1'), task('t2')] as never })

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
  })
})

describe('CabinEngineering — 仓库展开工作树', () => {
  it('默认折叠；点仓库行展开工作树', async () => {
    mockCabin(makeView())
    vi.mocked(listCabinRepos).mockResolvedValue([
      {
        key: 'org:XzhiF/aurora', name: 'aurora', source: 'org', org: 'XzhiF', group: 'XzhiF',
        repoName: 'aurora', main_path: '/repos/aurora', local_path: null, external: false,
        mainline_branch: 'main', worktree_path: null, branch: null, worktrees: [],
        git: { branch: 'main', detached: false, commit: 'abc1234', msg: 'init' },
      },
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

  it('主线程 agent 在跑：ready 也显示「作者在推进」，排在待执行前、不画 0%', async () => {
    mockCabin(makeView())
    vi.mocked(listCabinJobs).mockResolvedValue([
      job('j1', { title: '接入支付宝', status: 'ready', agent_running: true }),
      job('j2', { title: '排队作业', status: 'ready' }),
    ] as never)

    render(
      <CabinProvider cabinId="cabin-1">
        <CabinFleet />
      </CabinProvider>,
    )
    const rows = await screen.findAllByTestId(/^cabin-fleet-row-/)
    expect(rows).toHaveLength(2)
    expect(rows[0].textContent).toContain('接入支付宝')
    expect(rows[0].textContent).toContain('作者在推进')
    expect(rows[0].textContent).not.toContain('0%')
    expect(rows[0].getAttribute('data-tone')).toBe('run')
    expect(rows[0].getAttribute('data-live')).toBe('true')
    // 没有流在跑的 ready 作业维持「待执行」。
    expect(rows[1].textContent).toContain('待执行')
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

// ── 要我处理（classic 编队 v6：inbox 独立悬浮）────────────────────────
const ASK_ATTENTION: CabinAttentionItem[] = [{
  id: 'ask-a1',
  job_id: null,
  stage: 'answer',
  awaiting: 'person',
  title: '接入支付宝 · 待回答',
  question: '接哪个渠道？',
  task_id: 't1',
  repo: null,
  wt: null,
  deep_link: 'ask:a1',
  ask: { ask_id: 'a1', message_id: 'm1', decision: '接哪个渠道' },
}]
const REVIEW_ATTENTION: CabinAttentionItem = {
  id: 'review-t2',
  job_id: null,
  stage: 'review',
  awaiting: 'person',
  title: '结算台 UI · 待验收',
  detail: '4 个 phase 全过',
  task_id: 't2',
  repo: null,
  wt: null,
  deep_link: 'task:t2',
}
const BLOCKED_ATTENTION: CabinAttentionItem = {
  id: 'blocked-t9',
  job_id: null,
  stage: 'blocked',
  awaiting: 'person',
  title: '收银台回归 · 失败已升级',
  question: '同一组用例反复失败',
  task_id: 't9',
  repo: null,
  wt: null,
  deep_link: 'task:t9',
}
const START_ATTENTION: CabinAttentionItem = {
  id: 'start-t3',
  job_id: 'j3',
  stage: 'start',
  awaiting: 'person',
  title: '结算台 UI · 待触发',
  detail: '已入列，等你触发执行',
  task_id: 't3',
  start_kind: 'trigger',
  repo: null,
  wt: null,
  deep_link: 'task:t3',
}
const ALL_ATTENTION = [...ASK_ATTENTION, REVIEW_ATTENTION, BLOCKED_ATTENTION]

function AskWindowsProbe() {
  const { windows } = useAskWindows()
  return <div data-testid="ask-probe">{windows.map((w) => w.askId).join(',')}</div>
}

function captureTaskOpens() {
  const opened: Array<{ taskId: string; view?: string }> = []
  const onOpen = (event: Event) => {
    opened.push((event as CustomEvent<{ taskId: string; view?: string }>).detail)
  }
  window.addEventListener('octopus:open-task', onOpen)
  return { opened, dispose: () => window.removeEventListener('octopus:open-task', onOpen) }
}

describe('CabinInbox · 要我处理', () => {
  it('chip 给总数 + 三色计数；点开在左侧出分组列表，点待你定开问答窗', async () => {
    mockCabin(makeView({ attention: ALL_ATTENTION }))
    render(
      <CabinProvider cabinId="cabin-1">
        <AskWindowsProvider attention={ALL_ATTENTION}>
          <CabinInbox />
          <AskWindowsProbe />
        </AskWindowsProvider>
      </CabinProvider>,
    )

    const chip = screen.getByTestId('cabin-inbox-chip')
    expect(chip.textContent).toContain('要我处理')
    expect(chip.textContent).toContain('待你定 1')
    expect(chip.textContent).toContain('验收 1')
    expect(chip.textContent).toContain('受阻 1')
    expect(chip.textContent).toContain('3')

    expect(screen.queryByTestId('cabin-inbox-pop')).toBeNull()
    fireEvent.click(chip)
    expect(screen.getByTestId('cabin-inbox-pop')).toBeInTheDocument()
    expect(screen.getByTestId('cabin-inbox-row-ask-a1').textContent).toContain('接入支付宝')
    expect(screen.getByTestId('cabin-inbox-row-review-t2').textContent).toContain('结算台 UI')
    expect(screen.getByTestId('cabin-inbox-row-blocked-t9').textContent).toContain('收银台回归')

    fireEvent.click(screen.getByTestId('cabin-inbox-row-ask-a1'))
    await waitFor(() => expect(screen.getByTestId('ask-probe').textContent).toBe('a1'))
    expect(screen.queryByTestId('cabin-inbox-pop')).toBeNull()
  })

  it('待验收开验收视图，受阻开对应任务', async () => {
    mockCabin(makeView({ attention: ALL_ATTENTION }))
    const capture = captureTaskOpens()
    try {
      render(
        <CabinProvider cabinId="cabin-1">
          <AskWindowsProvider attention={ALL_ATTENTION}>
            <CabinInbox />
          </AskWindowsProvider>
        </CabinProvider>,
      )

      fireEvent.click(screen.getByTestId('cabin-inbox-chip'))
      fireEvent.click(screen.getByTestId('cabin-inbox-row-review-t2'))
      expect(capture.opened[0]).toEqual({ taskId: 't2', view: 'acceptance' })

      fireEvent.click(screen.getByTestId('cabin-inbox-chip'))
      fireEvent.click(screen.getByTestId('cabin-inbox-row-blocked-t9'))
      expect(capture.opened[1]).toEqual({ taskId: 't9' })
    } finally {
      capture.dispose()
    }
  })

  it('待放行：计入待你定，点行直接开放行窗，确认触发后消项（不跳任务线程）', async () => {
    mockCabin(makeView({ attention: [START_ATTENTION] }))
    vi.mocked(triggerTask).mockResolvedValue({} as never)
    vi.mocked(readyTask).mockResolvedValue({} as never)
    vi.mocked(resumeTask).mockResolvedValue({} as never)
    const capture = captureTaskOpens()
    try {
      render(
        <CabinProvider cabinId="cabin-1">
          <AskWindowsProvider attention={[START_ATTENTION]}>
            <CabinInbox />
          </AskWindowsProvider>
        </CabinProvider>,
      )

      const chip = screen.getByTestId('cabin-inbox-chip')
      expect(chip.textContent).toContain('待你定 1')
      expect(chip.textContent).toContain('1')

      fireEvent.click(chip)
      const row = screen.getByTestId('cabin-inbox-row-start-t3')
      expect(row.textContent).toContain('待放行')
      expect(row.textContent).toContain('结算台 UI')
      expect(row.textContent).toContain('放行 →')
      fireEvent.click(row)

      // 不再跳任务线程：浮窗里由汐音总结 + 选项。
      expect(capture.opened).toHaveLength(0)
      const win = screen.getByTestId('cabin-start-window-start-t3')
      expect(win.textContent).toContain('汐音')
      expect(win.textContent).toContain('立即触发')
      expect(win.textContent).toContain('已入列，等你触发执行')

      fireEvent.click(screen.getByTestId('cabin-start-window-exec'))
      await waitFor(() => expect(triggerTask).toHaveBeenCalledWith('t3'))
      expect(readyTask).not.toHaveBeenCalled()
      expect(screen.getByTestId('cabin-start-window-receipt').textContent).toContain('已触发执行')

      // 乐观消项：重开列表已经看不到这条。
      fireEvent.click(screen.getByTestId('cabin-inbox-chip'))
      expect(screen.queryByTestId('cabin-inbox-row-start-t3')).toBeNull()
      expect(screen.getByTestId('cabin-inbox-empty').textContent).toContain('都处理完了')
    } finally {
      capture.dispose()
    }
  })

  it('待入列：窗里默认立即开跑 = ready → trigger；也可只入列', async () => {
    const enqueueAttn: CabinAttentionItem = {
      ...START_ATTENTION,
      id: 'start-t4',
      title: '结算台 UI · 待入列',
      detail: '规格与 phase 绑定已齐，等你入列',
      task_id: 't4',
      start_kind: 'enqueue',
      deep_link: 'task:t4',
    }
    mockCabin(makeView({ attention: [enqueueAttn] }))
    vi.mocked(readyTask).mockResolvedValue({} as never)
    vi.mocked(triggerTask).mockResolvedValue({} as never)

    render(
      <CabinProvider cabinId="cabin-1">
        <AskWindowsProvider attention={[enqueueAttn]}>
          <CabinInbox />
        </AskWindowsProvider>
      </CabinProvider>,
    )

    fireEvent.click(screen.getByTestId('cabin-inbox-chip'))
    fireEvent.click(screen.getByTestId('cabin-inbox-row-start-t4'))
    expect(screen.getByTestId('cabin-start-window-start-t4').textContent).toContain('立即开跑')
    fireEvent.click(screen.getByTestId('cabin-start-window-exec'))
    await waitFor(() => expect(triggerTask).toHaveBeenCalledWith('t4'))
    expect(readyTask).toHaveBeenCalledWith('t4', { silentCard: true })
  })

  it('没有待办：chip 变灰、显示暂无待办，点开是「都处理完了」', () => {
    mockCabin(makeView())
    render(
      <CabinProvider cabinId="cabin-1">
        <AskWindowsProvider attention={[]}>
          <CabinInbox />
        </AskWindowsProvider>
      </CabinProvider>,
    )
    const chip = screen.getByTestId('cabin-inbox-chip')
    expect(chip.textContent).toContain('暂无待办')
    expect(chip.getAttribute('data-zero')).toBe('true')
    fireEvent.click(chip)
    expect(screen.getByTestId('cabin-inbox-empty').textContent).toContain('都处理完了')
  })
})

describe('CabinFleet · 只放作战实体', () => {
  it('提问行不再混进编队；编队行点开作业详情', async () => {
    mockCabin(makeView({ attention: ALL_ATTENTION }))
    vi.mocked(listCabinJobs).mockResolvedValue([job('j1', { title: '接入支付宝' })] as never)
    vi.mocked(listTasks).mockResolvedValue({ items: [task('t1')] as never })

    render(
      <CabinProvider cabinId="cabin-1">
        <AskWindowsProvider attention={ALL_ATTENTION}>
          <CabinFleet />
          <WindowProbe />
        </AskWindowsProvider>
      </CabinProvider>,
    )

    const rows = await screen.findAllByTestId(/^cabin-fleet-row-/)
    expect(rows).toHaveLength(1)
    expect(screen.queryByTestId('cabin-fleet-asks')).toBeNull()
    expect(screen.queryByTestId('cabin-fleet-ask-a1')).toBeNull()

    fireEvent.click(rows[0])
    await waitFor(() => expect(screen.getByTestId('window-probe').textContent).toContain('job'))
  })

  it('只有待办、没有作业行时编队不渲染（inbox 自己独立显示）', async () => {
    mockCabin(makeView({ attention: ALL_ATTENTION }))
    vi.mocked(listCabinJobs).mockResolvedValue([])
    vi.mocked(listTasks).mockResolvedValue({ items: [] })

    render(
      <CabinProvider cabinId="cabin-1">
        <AskWindowsProvider attention={ALL_ATTENTION}>
          <CabinFleet />
          <CabinInbox />
        </AskWindowsProvider>
      </CabinProvider>,
    )

    await waitFor(() => expect(screen.queryByTestId('cabin-fleet')).toBeNull())
    expect(screen.getByTestId('cabin-inbox')).toBeInTheDocument()
    expect(screen.getByTestId('cabin-inbox-chip').textContent).toContain('3')
  })
})
