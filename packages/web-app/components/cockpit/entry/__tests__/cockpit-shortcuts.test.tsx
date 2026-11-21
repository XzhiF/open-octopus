// S9 全域座舱键盘：
//   · ⌥1 最紧要（need→run→queue）；⌥2 收面；⌘K 开聊天窗；⌥W 跃迁；
//   · ⌥G 打开 / 收起本舱变更窗（cwd 工作区改动；仅 cwd 是独立 git 仓库时）；
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
import { resetCabinTree, useCabinTreeOpen } from '../../face/cabin-tree-store'
import { resetChanges, useChangesOpen } from '../../face/changes-store'
import { buildCounts, type CockpitRow } from '../../fleet/fleet-model'
import type { CockpitFleetContextValue } from '../../fleet/CockpitFleetProvider'
import { CockpitShortcuts } from '../CockpitShortcuts'

const fleetState = vi.hoisted(() => ({ current: null as unknown }))
/** 本舱 cwd 是否为独立 git 仓库 —— ⌥G 的出现条件。 */
const cabinState = vi.hoisted(() => ({ cwdGit: true }))

vi.mock('../../fleet/CockpitFleetProvider', () => ({
  useCockpitFleet: () => fleetState.current,
}))

vi.mock('@/components/cabin/cabin-provider', () => ({
  useCabinOptional: () => ({ cabin: { cwd_git: cabinState.cwdGit } }),
}))

function job(id: string, over: Partial<CabinJobView> = {}): CabinJobView {
  return {
    id,
    cabin_id: 'c1',
    kind: 'task',
    ref_id: null,
    session_id: null,
    title: `作业 ${id}`,
    mandate: null,
    prompt: null,
    created_at: '2026-11-14T09:00:00.000Z',
    ended_at: null,
    status: 'running',
    transport: 'task-thread',
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

function CabinTreeProbe() {
  return <output data-testid="cabin-tree">{useCabinTreeOpen() ? 'open' : 'closed'}</output>
}

function ChangesProbe() {
  return <output data-testid="changes-win">{useChangesOpen() ? 'open' : 'closed'}</output>
}

function renderShortcuts(active = true) {
  const tree = (
    <CockpitStateProvider entryCabinId="c1">
      <CockpitShortcuts />
      <Probe />
      <CabinTreeProbe />
      <ChangesProbe />
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
  cabinState.cwdGit = true
  resetCabinTree()
  resetChanges()
})

describe('CockpitShortcuts', () => {
  it('⌥1 选最紧要的一条（第一条 need → run → queue）', async () => {
    fleetState.current = fleet([
      row(job('run1', { status: 'running' })),
      row(job('need-first', { status: 'awaiting_review' })),
      row(job('need-second', { status: 'awaiting_review' })),
    ])
    renderShortcuts()
    fireEvent.keyDown(window, { key: '1', code: 'Digit1', altKey: true })
    await waitFor(() => expect(screen.getByTestId('selection').textContent).toBe('job:c1:need-first'))
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

  it('⌥F 打开 / 收起本舱目录窗', async () => {
    renderShortcuts()
    expect(screen.getByTestId('cabin-tree').textContent).toBe('closed')
    fireEvent.keyDown(window, { key: 'f', code: 'KeyF', altKey: true })
    await waitFor(() => expect(screen.getByTestId('cabin-tree').textContent).toBe('open'))
    fireEvent.keyDown(window, { key: 'f', code: 'KeyF', altKey: true })
    await waitFor(() => expect(screen.getByTestId('cabin-tree').textContent).toBe('closed'))
  })

  it('⌥A 通知 ChatArea 开合星核挂载面板（输入框里也生效）', () => {
    renderShortcuts()
    const onAttach = vi.fn()
    window.addEventListener('octopus:composer-attach', onAttach)
    const notPrevented = fireEvent.keyDown(window, { key: 'a', code: 'KeyA', altKey: true })
    const input = screen.getByTestId('typing')
    input.focus()
    fireEvent.keyDown(input, { key: 'a', code: 'KeyA', altKey: true })
    window.removeEventListener('octopus:composer-attach', onAttach)
    expect(notPrevented).toBe(false)
    expect(onAttach).toHaveBeenCalledTimes(2)
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

  it('⌥G 打开 / 收起本舱变更窗（问题 #1）', async () => {
    renderShortcuts()
    expect(screen.getByTestId('changes-win').textContent).toBe('closed')
    const prevented = fireEvent.keyDown(window, { key: 'g', code: 'KeyG', altKey: true })
    await waitFor(() => expect(screen.getByTestId('changes-win').textContent).toBe('open'))
    expect(prevented).toBe(false)
    fireEvent.keyDown(window, { key: 'g', code: 'KeyG', altKey: true })
    await waitFor(() => expect(screen.getByTestId('changes-win').textContent).toBe('closed'))
  })

  it('⌥G 在 cwd 不是独立 git 仓库时不生效、也不抢键', async () => {
    cabinState.cwdGit = false
    renderShortcuts()
    const prevented = fireEvent.keyDown(window, { key: 'g', code: 'KeyG', altKey: true })
    expect(screen.getByTestId('changes-win').textContent).toBe('closed')
    expect(prevented).toBe(true)
  })

  it('⌥V 点右栏「活动」按钮；按钮不存在（没有运行中活动）时不抢键', () => {
    const onClick = vi.fn()
    render(
      <CockpitStateProvider entryCabinId="c1">
        <CockpitShortcuts />
        <button type="button" data-testid="cockpit-menu-activity" onClick={onClick}>活动</button>
      </CockpitStateProvider>,
    )
    const prevented = fireEvent.keyDown(window, { key: 'v', code: 'KeyV', altKey: true })
    expect(onClick).toHaveBeenCalledTimes(1)
    expect(prevented).toBe(false)
  })

  it('⌥V 在按钮不存在时什么都不做', () => {
    render(
      <CockpitStateProvider entryCabinId="c1">
        <CockpitShortcuts />
      </CockpitStateProvider>,
    )
    const prevented = fireEvent.keyDown(window, { key: 'v', code: 'KeyV', altKey: true })
    expect(prevented).toBe(true)
  })

  it('active=false（隐藏窗口/后台标签）不抢任何键', async () => {
    fleetState.current = fleet([row(job('run1'))])
    renderShortcuts(false)
    fireEvent.keyDown(window, { key: '1', code: 'Digit1', altKey: true })
    fireEvent.keyDown(window, { key: 'k', code: 'KeyK', metaKey: true })
    expect(screen.getByTestId('selection').textContent).toBe('none')
    // v21 三轮：通讯台默认展开；不抢键 = 状态保持原样。
    expect(screen.getByTestId('chat-open').textContent).toBe('open')
  })
})
