// S9 全域座舱键盘：
//   · ⌥1 最紧要（need→run→queue）；⌥2 收面；⌘K 开聊天窗；⌥W 跃迁；
//   · ⌥G 不处理（两套界面的切换只走 classic 右上角按钮 / 全域「← 返回作战舱」）；
//   · 输入框聚焦时不抢键（⌘K 是唯一例外）；
//   · 隐藏窗口 / 后台标签（active=false）不抢键；
//   · ↑↓ 不在这里（S3 的 CockpitFleetRail 负责）。
// 编队数据走 useCockpitFleet mock。

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { CabinJobView } from '@/lib/cabin-api'
import type { AppNavigationValue } from '@/lib/app-navigation'
import { AppNavigationScope } from '@/lib/app-navigation'
import { CockpitStateProvider, useCockpitState } from '../../state/CockpitStateProvider'
import { buildCounts, type CockpitRow } from '../../fleet/fleet-model'
import type { CockpitFleetContextValue } from '../../fleet/CockpitFleetProvider'
import { CockpitShortcuts } from '../CockpitShortcuts'

const fleetState = vi.hoisted(() => ({ current: null as unknown }))

vi.mock('../../fleet/CockpitFleetProvider', () => ({
  useCockpitFleet: () => fleetState.current,
}))

function job(id: string, over: Partial<CabinJobView> = {}): CabinJobView {
  return {
    id,
    cabin_id: 'c1',
    kind: 'task',
    ref_id: null,
    session_id: null,
    iteration_id: null,
    title: `作业 ${id}`,
    mandate: null,
    prompt: null,
    priority: 0,
    created_at: '2026-11-14T09:00:00.000Z',
    ended_at: null,
    status: 'running',
    transport: 'task-thread',
    iteration_code: null,
    ...over,
  }
}

function row(j: CabinJobView): CockpitRow {
  return {
    key: `job:${j.id}`,
    kind: 'job',
    cabinId: j.cabin_id,
    cabinName: '舱 c1',
    job: j,
    pct: null,
  }
}

function fleet(rows: CockpitRow[]): CockpitFleetContextValue {
  return {
    rows,
    counts: buildCounts(rows, null),
    arrivals: [],
    loading: false,
    error: null,
    refetch: () => {},
  }
}

function Probe() {
  const { selection, chatWindow, fx } = useCockpitState()
  return (
    <>
      <output data-testid="selection">
        {selection ? `${selection.kind}:${selection.cabinId}:${selection.id}` : 'none'}
      </output>
      <output data-testid="chat-open">{chatWindow.open ? 'open' : 'closed'}</output>
      <output data-testid="jumps">{fx.jumpNonce}</output>
    </>
  )
}

function renderShortcuts(active = true) {
  const tree = (
    <CockpitStateProvider entryCabinId="c1">
      <CockpitShortcuts />
      <Probe />
      <input data-testid="typing" aria-label="聊天输入" />
    </CockpitStateProvider>
  )
  if (active) return render(tree)
  return render(
    <AppNavigationScope value={{ active: false } as unknown as AppNavigationValue}>
      {tree}
    </AppNavigationScope>,
  )
}

beforeEach(() => {
  fleetState.current = fleet([])
})

describe('CockpitShortcuts', () => {
  it('⌥1 选最紧要的一条（need 优先级降序 → run → queue）', async () => {
    fleetState.current = fleet([
      row(job('run1', { status: 'running' })),
      row(job('need-low', { status: 'awaiting_review', priority: 2 })),
      row(job('need-high', { status: 'awaiting_review', priority: 8 })),
    ])
    renderShortcuts()
    fireEvent.keyDown(window, { key: '1', code: 'Digit1', altKey: true })
    await waitFor(() => expect(screen.getByTestId('selection').textContent).toBe('job:c1:need-high'))
  })

  it('⌥1 在没有 need 时选 run，再没有则选 queue', async () => {
    fleetState.current = fleet([
      row(job('q1', { status: 'ready' })),
      row(job('r1', { status: 'running' })),
    ])
    renderShortcuts()
    fireEvent.keyDown(window, { key: '1', code: 'Digit1', altKey: true })
    await waitFor(() => expect(screen.getByTestId('selection').textContent).toBe('job:c1:r1'))
  })

  it('⌥2 收面（select(null)）', async () => {
    fleetState.current = fleet([row(job('run1'))])
    renderShortcuts()
    fireEvent.keyDown(window, { key: '1', code: 'Digit1', altKey: true })
    await waitFor(() => expect(screen.getByTestId('selection').textContent).toBe('job:c1:run1'))

    fireEvent.keyDown(window, { key: '2', code: 'Digit2', altKey: true })
    await waitFor(() => expect(screen.getByTestId('selection').textContent).toBe('none'))
  })

  it('⌘K 打开聊天窗（输入框里也生效）', async () => {
    renderShortcuts()
    const input = screen.getByTestId('typing')
    input.focus()
    fireEvent.keyDown(input, { key: 'k', code: 'KeyK', metaKey: true })
    await waitFor(() => expect(screen.getByTestId('chat-open').textContent).toBe('open'))
  })

  it('⌥W 触发跃迁特效', async () => {
    renderShortcuts()
    expect(screen.getByTestId('jumps').textContent).toBe('0')
    fireEvent.keyDown(window, { key: 'w', code: 'KeyW', altKey: true })
    await waitFor(() => expect(screen.getByTestId('jumps').textContent).toBe('1'))
  })

  it('输入框聚焦时 ⌥1 / ⌥W 不抢键', async () => {
    fleetState.current = fleet([row(job('run1'))])
    renderShortcuts()
    const input = screen.getByTestId('typing')
    input.focus()
    fireEvent.keyDown(input, { key: '1', code: 'Digit1', altKey: true })
    fireEvent.keyDown(input, { key: 'w', code: 'KeyW', altKey: true })
    expect(screen.getByTestId('selection').textContent).toBe('none')
    expect(screen.getByTestId('jumps').textContent).toBe('0')
  })

  it('⌥G 不处理（不抢键、不改状态）', () => {
    fleetState.current = fleet([row(job('run1'))])
    renderShortcuts()
    const notPrevented = fireEvent.keyDown(window, { key: 'g', code: 'KeyG', altKey: true })
    expect(notPrevented).toBe(true)
    expect(screen.getByTestId('selection').textContent).toBe('none')
  })

  it('active=false（隐藏窗口/后台标签）不抢任何键', async () => {
    fleetState.current = fleet([row(job('run1'))])
    renderShortcuts(false)
    fireEvent.keyDown(window, { key: '1', code: 'Digit1', altKey: true })
    fireEvent.keyDown(window, { key: 'k', code: 'KeyK', metaKey: true })
    expect(screen.getByTestId('selection').textContent).toBe('none')
    expect(screen.getByTestId('chat-open').textContent).toBe('closed')
  })
})
