import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import type { CabinView } from '@octopus/shared'

vi.mock('@/lib/server-config', () => ({ getServerUrl: () => 'http://localhost:3001' }))
vi.mock('@/hooks/use-cabin', () => ({ useCabin: vi.fn() }))
vi.mock('@/lib/cabin-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/cabin-api')>()
  return {
    ...actual,
    initCabin: vi.fn(),
    wakeCabin: vi.fn(),
    archiveCabin: vi.fn(),
    reopenCabin: vi.fn(),
    listCabinWorktrees: vi.fn(),
  }
})

import { useCabin } from '@/hooks/use-cabin'
import { archiveCabin, initCabin, listCabinWorktrees, reopenCabin, wakeCabin } from '@/lib/cabin-api'
import { CabinOverview } from '../CabinOverview'
import { CabinProvider, useCabinContext } from '../cabin-provider'
import { AskWindowsProvider, useAskWindows } from '../asks/ask-windows-provider'

const mockUseCabin = vi.mocked(useCabin)

function makeView(overrides: Partial<CabinView> = {}): CabinView {
  return {
    cabin: {
      id: 'cabin-1', name: 'Aurora', path: '/tmp/a', workspace_id: 'ws-1', main_session_id: 'sess-1',
      requirements: '', status: 'active', mainline_strategy: 'clean-main', org: null,
      version: 1, created_at: '', updated_at: '', last_active_at: null, archived_at: null,
    },
    attention: [],
    health: { running: 2, queued: 1, dormant: 0, workers: 2, max: 5 },
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

function ViewProbe() {
  const { openWindows } = useCabinContext()
  return <div data-testid="view-probe">{openWindows.join(',')}</div>
}

function renderOverview(view: CabinView) {
  mockCabin(view)
  return render(
    <CabinProvider cabinId="cabin-1">
      <ViewProbe />
      <CabinOverview />
    </CabinProvider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(listCabinWorktrees).mockResolvedValue([
    { repo: 'pay', worktrees: [{ path: '/w1', head: 'abc', branch: 'cabin-x' }, { path: '/w2', head: 'def', branch: 't1' }] },
    { repo: 'web', worktrees: [{ path: '/w3', head: 'ghi', branch: 'cabin-x' }] },
  ])
})

describe('CabinOverview — serial inbox', () => {
  it('renders attention in server order with person-first focus marker', () => {
    const view = makeView({
      attention: [
        { id: 'review-t1', job_id: null, stage: 'review', awaiting: 'person', title: '任务A · 待验收', task_id: 't1', repo: 'pay', wt: 'cabin-cabin-1', deep_link: 'task:t1', question: '验收吗？' },
        { id: 'run-t2', job_id: null, stage: 'blocked', awaiting: 'working', title: '任务B · 运行中', task_id: 't2', repo: null, wt: null, deep_link: null },
      ],
    })
    renderOverview(view)
    const rows = screen.getAllByRole('listitem')
    expect(rows[0].querySelector('[data-attention-id]')?.getAttribute('data-attention-id')).toBe('review-t1')
    expect(rows[0].querySelector('[data-focused="true"]')).not.toBeNull()
    expect(rows[1].querySelector('[data-focused="true"]')).toBeNull()
    expect(screen.getByTestId('cabin-person-count').textContent).toContain('1')
  })

  it('clicking a review item opens the task acceptance in the chat base', () => {
    const spy = vi.fn()
    window.addEventListener('octopus:open-task', spy)
    const view = makeView({
      attention: [
        { id: 'review-t1', job_id: null, stage: 'review', awaiting: 'person', title: '任务A · 待验收', task_id: 't1', repo: null, wt: null, deep_link: null },
      ],
    })
    renderOverview(view)
    fireEvent.click(screen.getByText('任务A · 待验收'))
    expect(spy).toHaveBeenCalledTimes(1)
    expect((spy.mock.calls[0][0] as CustomEvent).detail).toEqual({ taskId: 't1', view: 'acceptance' })
    window.removeEventListener('octopus:open-task', spy)
  })

  it('ask: 行点开问答窗，不派发 open-task（design 26 §3.6）', () => {
    const spy = vi.fn()
    window.addEventListener('octopus:open-task', spy)
    const attention = [{
      id: 'ask-a1', job_id: null, stage: 'answer' as const, awaiting: 'person' as const,
      title: '接入支付宝 · 待回答', question: '接哪个渠道？', task_id: 't1',
      repo: null, wt: null, deep_link: 'ask:a1',
      ask: { ask_id: 'a1', message_id: 'm1', decision: '接哪个渠道' },
    }]
    mockCabin(makeView({ attention }))
    function AskProbe() {
      const { windows } = useAskWindows()
      return <div data-testid="ask-probe">{windows.map((w) => w.askId).join(',')}</div>
    }
    render(
      <CabinProvider cabinId="cabin-1">
        <AskWindowsProvider attention={attention}>
          <AskProbe />
          <CabinOverview />
        </AskWindowsProvider>
      </CabinProvider>,
    )
    fireEvent.click(screen.getByText('接入支付宝 · 待回答'))
    expect(screen.getByTestId('ask-probe').textContent).toBe('a1')
    expect(spy).not.toHaveBeenCalled()
    window.removeEventListener('octopus:open-task', spy)
  })

  it('empty attention shows the all-clear state', () => {
    renderOverview(makeView())
    expect(screen.getByTestId('cabin-attention-empty')).toBeInTheDocument()
  })
})

describe('CabinOverview — statgrid', () => {
  it('renders the prototype four-stat grid from the derived view + worktrees', async () => {
    renderOverview(makeView({ open_findings: 4 }))
    expect(screen.getByTestId('cabin-health-running').textContent).toBe('2')
    expect(screen.getByTestId('cabin-health-workers').textContent).toBe('2/5')
    expect(screen.getByTestId('cabin-stat-attention').textContent).toBe('0')
    await waitFor(() => expect(screen.getByTestId('cabin-stat-worktrees').textContent).toBe('3'))
    expect(screen.getByTestId('cabin-stat-cost').textContent).toBe('—')
  })
})

describe('CabinOverview — lifecycle bar', () => {
  it('active cabin offers 封存 (soft archive)', async () => {
    vi.mocked(archiveCabin).mockResolvedValue({} as never)
    renderOverview(makeView())
    fireEvent.click(screen.getByTestId('cabin-action-archive'))
    await waitFor(() => expect(archiveCabin).toHaveBeenCalledWith('cabin-1'))
  })

  it('archived cabin offers 重开', async () => {
    vi.mocked(reopenCabin).mockResolvedValue({} as never)
    const view = makeView()
    view.cabin.status = 'archived'
    renderOverview(view)
    fireEvent.click(screen.getByTestId('cabin-action-reopen'))
    await waitFor(() => expect(reopenCabin).toHaveBeenCalledWith('cabin-1'))
    expect(screen.queryByTestId('cabin-action-archive')).not.toBeInTheDocument()
  })

  it('dormant cabin offers 唤醒', async () => {
    vi.mocked(wakeCabin).mockResolvedValue({} as never)
    const view = makeView()
    view.cabin.status = 'dormant'
    renderOverview(view)
    fireEvent.click(screen.getByTestId('cabin-action-wake'))
    await waitFor(() => expect(wakeCabin).toHaveBeenCalledWith('cabin-1'))
  })

  it('draft cabin offers 开始初始化', async () => {
    vi.mocked(initCabin).mockResolvedValue({} as never)
    const view = makeView()
    view.cabin.status = 'draft'
    renderOverview(view)
    fireEvent.click(screen.getByTestId('cabin-action-init'))
    await waitFor(() => expect(initCabin).toHaveBeenCalledWith('cabin-1'))
  })
})