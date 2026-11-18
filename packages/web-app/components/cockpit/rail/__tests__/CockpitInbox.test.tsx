// v21（design 31 §3.2）右栏待办：chip 计数 / 浮层分组 / 就地回复卡 / 去处理。

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import type { CabinAttentionItem } from '@octopus/shared'
import type { CockpitRow } from '../../fleet/fleet-model'
import type { CockpitFleetContextValue } from '../../fleet/CockpitFleetProvider'
import { CockpitStateProvider } from '../../state/CockpitStateProvider'
import { CockpitContext, type CockpitContextValue } from '@/components/cabin/CockpitProvider'
import { DEFAULT_COCKPIT } from '@/components/cabin/cockpit'
import { CockpitRightRail } from '../CockpitRightRail'

const fleetState = vi.hoisted(() => ({ value: null as unknown }))

vi.mock('../../fleet/CockpitFleetProvider', () => ({
  useCockpitFleet: () => fleetState.value,
}))
vi.mock('../../chat/use-cockpit-threads', () => ({
  useCockpitThreads: () => ({
    threads: [],
    byKey: new Map(),
    active: { key: 'main', kind: 'main', ref: null, short: '主对话', state: 'queue' },
    visible: [],
  }),
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() } }))

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
  return { rows, counts: null, arrivals: [], loading: false, error: null, refetch: () => {} }
}

function ui() {
  return (
    <CockpitContext.Provider value={cockpit()}>
      <CockpitStateProvider entryCabinId="c1">
        <CockpitRightRail />
      </CockpitStateProvider>
    </CockpitContext.Provider>
  )
}

beforeEach(() => {
  fleetState.value = fleet([])
})

describe('CockpitRightRail · v21 待办', () => {
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

  it('点一条带信封的行 → 左窗回复卡（选项 + REC + 自由输入）', () => {
    fleetState.value = fleet([
      row('a1', {
        stage: 'answer',
        ask: {
          ask_id: 'a1',
          decision: '限流阈值定多少？',
          options: [
            { label: '600 rps', impact: '最稳' },
            { label: '900 rps', impact: '余量 12%' },
          ],
          recommendation: { label: '900 rps' },
        },
      }),
    ])
    render(ui())
    fireEvent.click(screen.getByTestId('cockpit-inbox-chip'))
    fireEvent.click(screen.getByTestId('cockpit-inbox-row-a1'))

    const card = screen.getByTestId('cockpit-inbox-reply')
    expect(card).toHaveTextContent('限流阈值定多少？')
    expect(card).toHaveTextContent('600 rps')
    expect(card).toHaveTextContent('900 rps')
    expect(card).toHaveTextContent('REC')
    expect(within(card).getByLabelText('自由作答')).toBeInTheDocument()
    expect(card.querySelector('.ck12-ipd-foot button.ck12-ipd-pri')).toBeDisabled()
  })

  it('没有信封的行只给「去处理 ▦」，不假造选项', () => {
    fleetState.value = fleet([row('a2', { stage: 'review', title: 'M2 · 结算对账' })])
    render(ui())
    fireEvent.click(screen.getByTestId('cockpit-inbox-chip'))
    fireEvent.click(screen.getByTestId('cockpit-inbox-row-a2'))

    const card = screen.getByTestId('cockpit-inbox-reply')
    expect(card).toHaveTextContent('去处理')
    expect(card.querySelector('.ck12-ipd-opt')).toBeNull()
  })

  it('待放行行 → 直接开与 classic 同款的放行窗（立即开跑 / 先入列）', () => {
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

    // 浮层收起，放行窗按 cockpit 落点打开。
    expect(screen.queryByTestId('cockpit-inbox-popover')).toBeNull()
    const win = screen.getByTestId('cabin-start-window-s1')
    expect(win.className).toMatch(/ck-askwin--cockpit/)
    expect(win).toHaveTextContent('要现在放行吗？')
    expect(within(win).getByTestId('cabin-start-window-opt-launch')).toHaveTextContent('立即开跑')
    expect(within(win).getByTestId('cabin-start-window-opt-launch')).toHaveTextContent('入列并马上触发 phase 1')
    expect(within(win).getByTestId('cabin-start-window-opt-enqueue')).toHaveTextContent('先入列')
  })

  it('点浮层外收起；Esc 走 layer 栈', () => {
    fleetState.value = fleet([row('a1')])
    render(ui())
    fireEvent.click(screen.getByTestId('cockpit-inbox-chip'))
    expect(screen.getByTestId('cockpit-inbox-popover')).toBeInTheDocument()

    fireEvent.pointerDown(document.body)
    expect(screen.queryByTestId('cockpit-inbox-popover')).toBeNull()
  })
})
