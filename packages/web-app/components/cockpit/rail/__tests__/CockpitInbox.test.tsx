// v21（design 31 §3.2）右栏待办 → v22 #5（2026-11-23 用户）一级动作：
// chip 计数 / 浮层分组 / 一级行直给「💬 对话 | ▦ 详情」/ 放行与完成回流仍是就地卡。

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { CabinAttentionItem } from '@octopus/shared'
import type { CockpitRow } from '../../fleet/fleet-model'
import type { CockpitFleetContextValue } from '../../fleet/CockpitFleetProvider'
import { CockpitStateProvider, useCockpitState } from '../../state/CockpitStateProvider'
import { CockpitContext, type CockpitContextValue } from '@/components/cabin/CockpitProvider'
import { DEFAULT_COCKPIT } from '@/components/cabin/cockpit'
import { CockpitRightRail } from '../CockpitRightRail'

const fleetState = vi.hoisted(() => ({ value: null as unknown }))
/** 假线程表：把某个编队行 key 放进来 = 这条作战有会话可开 chat 窗。 */
const threadState = vi.hoisted(() => ({ keys: new Set<string>() }))

vi.mock('../../fleet/CockpitFleetProvider', () => ({
  useCockpitFleet: () => fleetState.value,
}))
vi.mock('../../chat/use-cockpit-threads', () => ({
  useCockpitThreads: () => ({
    threads: [],
    byKey: new Map(
      [...threadState.keys].map((key) => [
        key,
        {
          key,
          kind: 'job',
          sessionId: `sess-${key}`,
          taskId: null,
          title: key,
          short: key,
          state: 'wait',
          ref: { kind: 'job', cabinId: 'c1', id: key },
        },
      ]),
    ),
    active: { key: 'main', kind: 'main', ref: null, short: '主对话', state: 'queue' },
    visible: [],
  }),
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() } }))
vi.mock('@/lib/cabin-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/cabin-api')>()
  return {
    ...actual,
    ackCabinAttention: vi.fn(async () => ({ acked: true })),
    dismissCabinAsk: vi.fn(async () => ({ dismissed: 1 })),
  }
})
vi.mock('@/lib/tasks-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/tasks-api')>()
  return {
    ...actual,
    readyTask: vi.fn(async () => ({})),
    triggerTask: vi.fn(async () => ({})),
    resumeTask: vi.fn(async () => ({})),
  }
})

import { ackCabinAttention, dismissCabinAsk } from '@/lib/cabin-api'
import { readyTask, triggerTask } from '@/lib/tasks-api'

function cockpit(): CockpitContextValue {
  return {
    prefs: DEFAULT_COCKPIT,
    mood: 'idle',
    moodOverride: null,
    streaming: false,
    setStreaming: vi.fn(),
    setPref: vi.fn(),
    applyPrefs: vi.fn(),
    reset: vi.fn(),
    randomize: vi.fn(),
    setMoodOverride: vi.fn(),
    presenceLine: null,
    presenceDueAt: 0,
    presenceSnoozeUntil: 0,
    dismissPresence: vi.fn(),
    snoozePresence: vi.fn(),
    testPresence: vi.fn(),
    setCrewBusy: vi.fn(),
    setPresenceActive: vi.fn(),
    scene: { key: 'cabin-1' } as unknown as CockpitContextValue['scene'],
  }
}

function item(id: string, over: Partial<CabinAttentionItem> = {}): CabinAttentionItem {
  return {
    id,
    job_id: null,
    stage: 'answer',
    awaiting: 'person',
    title: `事项 ${id}`,
    task_id: null,
    repo: null,
    wt: null,
    deep_link: null,
    ...over,
  }
}

function row(id: string, over: Partial<CabinAttentionItem> = {}): CockpitRow {
  return { key: `attn:${id}`, kind: 'attention', cabinId: 'c1', cabinName: '舱一', item: item(id, over) }
}

function fleet(rows: CockpitRow[]): CockpitFleetContextValue {
  return { rows, mainSessionId: null, counts: null, arrivals: [], loading: false, error: null, refetch: () => {} }
}

/** 读状态探针：动作落到哪条选中 / 哪个页签 / 哪扇窗。 */
function Probe() {
  const { selection, tab, detailSource, wins, inboxOpen } = useCockpitState()
  return (
    <span
      data-testid="probe-selection"
      data-source={detailSource}
      data-wins={wins.windows.length}
      data-inbox-open={inboxOpen ? '1' : '0'}
    >
      {selection ? `${selection.kind}:${selection.id}:${tab}` : `none:${tab}`}
    </span>
  )
}

function ui() {
  return (
    <CockpitContext.Provider value={cockpit()}>
      <CockpitStateProvider entryCabinId="c1">
        <CockpitRightRail />
        <Probe />
      </CockpitStateProvider>
    </CockpitContext.Provider>
  )
}

beforeEach(() => {
  fleetState.value = fleet([])
  threadState.keys = new Set()
})

describe('CockpitRightRail · 待办（v22 #5 一级动作）', () => {
  it('chip 显示总数；零待办转灰', () => {
    fleetState.value = fleet([row('a1'), row('a2', { stage: 'review' })])
    const { rerender } = render(ui())
    expect(screen.getByTestId('cockpit-inbox-count')).toHaveTextContent('2')
    expect(screen.getByTestId('cockpit-inbox-chip').className).not.toMatch(/is-zero/)

    fleetState.value = fleet([])
    rerender(ui())
    expect(screen.getByTestId('cockpit-inbox-count')).toHaveTextContent('0')
    expect(screen.getByTestId('cockpit-inbox-chip').className).toMatch(/is-zero/)
  })

  it('浮层打开时右栏走共享 z 栈：每次重开都压过已抬高的主 chat（用户 #1）', () => {
    fleetState.value = fleet([row('a1')])
    render(ui())
    const rail = screen.getByTestId('cockpit-right-rail')
    expect(rail.style.zIndex).toBe('')

    fireEvent.click(screen.getByTestId('cockpit-inbox-chip'))
    const first = Number(rail.style.zIndex)
    expect(first).toBeGreaterThan(0)

    // 关掉再开 → 重新取号，必须比上一次更高（主 chat 的 z 会一直涨）。
    fireEvent.click(screen.getByTestId('cockpit-inbox-chip'))
    fireEvent.click(screen.getByTestId('cockpit-inbox-chip'))
    expect(Number(rail.style.zIndex)).toBeGreaterThan(first)
  })

  it('点 chip 开浮层：✕ 在头部最左，按 待你定/待验收/受阻 分组', () => {
    fleetState.value = fleet([
      row('a1', { stage: 'answer' }),
      row('a2', { stage: 'review' }),
      row('a3', { stage: 'blocked' }),
    ])
    render(ui())
    fireEvent.click(screen.getByTestId('cockpit-inbox-chip'))

    const pop = screen.getByTestId('cockpit-inbox-popover')
    const header = pop.querySelector('.ck12-ip-h') as HTMLElement
    expect(header.firstElementChild).toHaveAttribute('aria-label', '收起要我处理')
    expect(within(pop).getByText('待你定')).toBeInTheDocument()
    expect(within(pop).getByText('待验收')).toBeInTheDocument()
    expect(within(pop).getByText('受阻')).toBeInTheDocument()
  })

  it('待你定一级行直给「💬 对话 | ▦」，行体点击 = 开 chat 窗（有会话）并收起浮层', () => {
    threadState.keys.add('attn:a1')
    fleetState.value = fleet([row('a1', { stage: 'answer', title: 'M3 · 风控告警' })])
    render(ui())
    fireEvent.click(screen.getByTestId('cockpit-inbox-chip'))

    const pop = screen.getByTestId('cockpit-inbox-popover')
    const chat = within(pop).getByTestId('cockpit-inbox-chat-a1')
    expect(chat).toHaveTextContent('💬 对话')
    expect(within(pop).getByTestId('cockpit-inbox-detail-a1')).toBeInTheDocument()
    // 不再有二级回复卡包装。
    expect(screen.queryByTestId('cockpit-inbox-reply')).toBeNull()

    fireEvent.click(screen.getByTestId('cockpit-inbox-row-a1'))
    const probe = screen.getByTestId('probe-selection')
    expect(probe).toHaveAttribute('data-wins', '1')
    expect(probe).toHaveAttribute('data-inbox-open', '0')
  })

  it('待你定一级行「忽略」：dismiss 消息卡 + ack 收项，行与计数立即消失（v22 #9）', async () => {
    fleetState.value = fleet([row('a1', { stage: 'answer', ask: { ask_id: 'ask-77' } })])
    render(ui())
    expect(screen.getByTestId('cockpit-inbox-count')).toHaveTextContent('1')
    fireEvent.click(screen.getByTestId('cockpit-inbox-chip'))

    const pop = screen.getByTestId('cockpit-inbox-popover')
    const ignore = within(pop).getByTestId('cockpit-inbox-ignore-a1')
    expect(ignore).toHaveTextContent('忽略')

    fireEvent.click(ignore)
    await waitFor(() => expect(vi.mocked(dismissCabinAsk)).toHaveBeenCalledWith('c1', 'ask-77'))
    expect(vi.mocked(ackCabinAttention)).toHaveBeenCalledWith('c1', 'a1')
    // 乐观消项：行与 chip 计数都不等下一轮轮询。
    await waitFor(() => expect(screen.queryByTestId('cockpit-inbox-row-a1')).toBeNull())
    expect(screen.getByTestId('cockpit-inbox-count')).toHaveTextContent('0')
  })

  it('没有会话的行：行体点击退回详情（运行页签）；💬 按钮同样退回详情', () => {
    fleetState.value = fleet([row('a1', { stage: 'blocked', title: 'M3 · 风控告警' })])
    render(ui())
    fireEvent.click(screen.getByTestId('cockpit-inbox-chip'))
    fireEvent.click(screen.getByTestId('cockpit-inbox-row-a1'))

    expect(screen.getByTestId('probe-selection')).toHaveTextContent('attention:a1:run')
    expect(screen.getByTestId('probe-selection')).toHaveAttribute('data-source', 'inbox')
    expect(screen.getByTestId('probe-selection')).toHaveAttribute('data-wins', '0')
  })

  it('待验收一级行：「▦ 验收」开验收详情，浮层留着；行体点击 = 收浮层 + 开验收详情', () => {
    fleetState.value = fleet([row('a2', { stage: 'review', title: 'M2 · 结算对账' })])
    render(ui())
    fireEvent.click(screen.getByTestId('cockpit-inbox-chip'))

    fireEvent.click(screen.getByTestId('cockpit-inbox-detail-a2'))
    expect(screen.getByTestId('probe-selection')).toHaveTextContent('attention:a2:accept')
    expect(screen.getByTestId('probe-selection')).toHaveAttribute('data-source', 'inbox')
    expect(screen.getByTestId('cockpit-inbox-popover')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('cockpit-inbox-row-a2'))
    expect(screen.getByTestId('probe-selection')).toHaveTextContent('attention:a2:accept')
    expect(screen.getByTestId('probe-selection')).toHaveAttribute('data-inbox-open', '0')
  })

  it('待放行行 → 浮层里就地展开单栏放行卡（选项 + 确认执行），行尾动作是 ⚑ 放行', () => {
    fleetState.value = fleet([
      row('s1', {
        stage: 'start',
        start_kind: 'enqueue',
        task_id: 't1',
        title: 'app-user 与 admin-user 体系分离 · 待入列',
      }),
    ])
    render(ui())
    fireEvent.click(screen.getByTestId('cockpit-inbox-chip'))
    expect(screen.getByTestId('cockpit-inbox-start-s1')).toHaveTextContent('⚑ 放行')

    fireEvent.click(screen.getByTestId('cockpit-inbox-row-s1'))
    const pop = screen.getByTestId('cockpit-inbox-popover')
    expect(pop.className).not.toMatch(/is-two/)

    const card = screen.getByTestId('cockpit-inbox-start')
    expect(card).toHaveTextContent('要现在放行吗？')
    expect(within(card).getByTestId('cockpit-inbox-start-opt-launch')).toHaveTextContent('立即开跑')
    expect(within(card).getByTestId('cockpit-inbox-start-exec')).toHaveTextContent('确认执行')
    // 放行卡也能直接去 chat。
    expect(within(card).getByTestId('cockpit-inbox-start-chat')).toHaveTextContent('💬 去对话')
  })

  it('放行卡「看任务详情」→ 作战详情落「运行」页签；浮层不关、卡片仍在', () => {
    fleetState.value = fleet([
      row('s1', {
        stage: 'start',
        start_kind: 'enqueue',
        task_id: 't1',
        title: 'app-user 与 admin-user 体系分离 · 待入列',
      }),
    ])
    render(ui())
    fireEvent.click(screen.getByTestId('cockpit-inbox-chip'))
    fireEvent.click(screen.getByTestId('cockpit-inbox-row-s1'))

    fireEvent.click(screen.getByTestId('cockpit-inbox-start-detail'))
    expect(screen.getByTestId('probe-selection')).toHaveTextContent('attention:s1:run')
    expect(screen.getByTestId('cockpit-inbox-popover')).toBeInTheDocument()
    expect(screen.getByTestId('cockpit-inbox-start')).toBeInTheDocument()
  })

  it('放行卡「确认执行」（立即开跑）→ ready(silent) + trigger，回执照常出现', async () => {
    fleetState.value = fleet([
      row('s1', {
        stage: 'start',
        start_kind: 'enqueue',
        task_id: 't1',
        title: 'app-user 与 admin-user 体系分离 · 待入列',
      }),
    ])
    render(ui())
    fireEvent.click(screen.getByTestId('cockpit-inbox-chip'))
    fireEvent.click(screen.getByTestId('cockpit-inbox-row-s1'))

    fireEvent.click(screen.getByTestId('cockpit-inbox-start-exec'))
    await waitFor(() => expect(vi.mocked(readyTask)).toHaveBeenCalledWith('t1', { silentCard: true }))
    expect(vi.mocked(triggerTask)).toHaveBeenCalledWith('t1')
    const receipt = await screen.findByTestId('cockpit-inbox-receipt')
    expect(receipt).toHaveTextContent('已放行')
    expect(receipt).toHaveTextContent('已开跑')
  })

  it('点外面不自动收起 —— 只有主动 ✕（或 Esc，走 layer 栈）才关', () => {
    fleetState.value = fleet([row('a1')])
    render(ui())
    fireEvent.click(screen.getByTestId('cockpit-inbox-chip'))
    const pop = screen.getByTestId('cockpit-inbox-popover')

    fireEvent.pointerDown(document.body)
    expect(screen.getByTestId('cockpit-inbox-popover')).toBeInTheDocument()

    fireEvent.click(within(pop).getAllByLabelText('收起要我处理')[0])
    expect(screen.queryByTestId('cockpit-inbox-popover')).toBeNull()
  })

  it('零待办点开：空态常驻，不被计时器自动收起（只手动 ✕ / Esc）', async () => {
    fleetState.value = fleet([])
    render(ui())
    fireEvent.click(screen.getByTestId('cockpit-inbox-chip'))
    expect(screen.getByTestId('cockpit-inbox-empty')).toHaveTextContent('都处理完了')

    await new Promise((resolve) => setTimeout(resolve, 900))
    expect(screen.getByTestId('cockpit-inbox-popover')).toBeInTheDocument()
  })

  // 2026-11-19 用户 #9：完成回流进 inbox → 人可确认「无需回复」收项（纯 ack）。
  it('已完成分组：「✓ 收下」/ 行体点击开完成卡，收下调 ack、不再回复任务/会话', async () => {
    fleetState.value = fleet([
      row('done-task-t1', {
        stage: 'notice',
        title: '任务A · 已完成',
        detail: '执行与归档已收口，确认无需回复就收下',
        handle: '#1',
        task_id: 't1',
      }),
    ])
    render(ui())

    expect(screen.getByTestId('cockpit-inbox-count')).toHaveTextContent('1')
    fireEvent.click(screen.getByTestId('cockpit-inbox-chip'))
    expect(screen.getByText('已完成')).toBeInTheDocument()
    expect(screen.getByTestId('cockpit-inbox-ack-done-task-t1')).toHaveTextContent('✓ 收下')

    fireEvent.click(screen.getByTestId('cockpit-inbox-row-done-task-t1'))
    const card = screen.getByTestId('cockpit-inbox-notice')
    expect(card).toHaveTextContent('任务A · 已完成')
    fireEvent.click(within(card).getByTestId('cockpit-inbox-notice-ack'))

    await waitFor(() => expect(vi.mocked(ackCabinAttention)).toHaveBeenCalledWith('c1', 'done-task-t1'))
    const receipt = await screen.findByTestId('cockpit-inbox-receipt')
    expect(receipt).toHaveTextContent('已收下')
    expect(receipt).toHaveTextContent('没有回复任务/会话')
  })
})
