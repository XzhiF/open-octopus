// S9 入口/出口 + URL 同步规则：
//   · 桌面/舱内 → 全域 → 原路返回（origin 往返，进入用 push）；
//   · 深链直接进 → 出口回 /cabin/:entryCabinId；
//   · 全域内部再点入口不覆盖 origin；
//   · v21 三轮：首载不自动选面（详情是点击编队行才开的模态 dossier）；
//   · 无效 ref 回退；旧 ?cabin= 跨舱参数被忽略并清掉（全域只含入口舱）；
//   · merged attention 命中 job 行时 ?attn 仍算有效。
// 编队数据走 useCockpitFleet mock（不 fetch），selection/URL 都是真组件。

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { CabinJobView } from '@/lib/cabin-api'
import { AppNavProvider, useAppNavigation } from '@/lib/app-navigation'
import { CockpitStateProvider, useCockpitState } from '../../state/CockpitStateProvider'
import { buildCounts, type CockpitRow } from '../../fleet/fleet-model'
import type { CockpitFleetContextValue } from '../../fleet/CockpitFleetProvider'
import { CockpitUrlSync } from '../use-cockpit-url-sync'
import {
  COCKPIT_ORIGIN_KEY,
  readCockpitOrigin,
  useCockpitEntry,
  writeCockpitOrigin,
} from '../use-cockpit-entry'

const fleetState = vi.hoisted(() => ({ current: null as unknown }))

vi.mock('../../fleet/CockpitFleetProvider', () => ({
  useCockpitFleet: () => fleetState.current,
}))

function fleet(rows: CockpitRow[], loaded = true): CockpitFleetContextValue {
  return {
    rows,
    counts: loaded ? buildCounts(rows, null) : null,
    arrivals: [],
    loading: !loaded,
    error: null,
    refetch: () => {},
  }
}

function job(id: string, over: Partial<CabinJobView> = {}, cabinId = 'c1'): CabinJobView {
  return {
    id,
    cabin_id: cabinId,
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

function jobRow(j: CabinJobView): CockpitRow {
  return {
    key: `job:${j.id}`,
    kind: 'job',
    cabinId: j.cabin_id,
    cabinName: `舱 ${j.cabin_id}`,
    job: j,
    pct: null,
  }
}

function SelectionProbe() {
  const { selection } = useCockpitState()
  return (
    <output data-testid="selection">
      {selection ? `${selection.kind}:${selection.cabinId}:${selection.id}` : 'none'}
    </output>
  )
}

function UrlProbe() {
  const nav = useAppNavigation()
  const search = nav?.searchParams.toString() ?? ''
  return (
    <output data-testid="url">{nav ? `${nav.pathname}${search ? `?${search}` : ''}` : ''}</output>
  )
}

function CollapseButton() {
  const { select } = useCockpitState()
  return <button type="button" data-testid="collapse" onClick={() => select(null)}>collapse</button>
}

function renderSync(initial: string, initialFleet: CockpitFleetContextValue) {
  fleetState.current = initialFleet
  const tree = () => (
    <MemoryRouter initialEntries={[initial]}>
      <AppNavProvider>
        <CockpitStateProvider entryCabinId="c1">
          <CockpitUrlSync />
          <SelectionProbe />
          <UrlProbe />
          <CollapseButton />
        </CockpitStateProvider>
      </AppNavProvider>
    </MemoryRouter>
  )
  const utils = render(tree())
  const load = (rows: CockpitRow[]) => {
    fleetState.current = fleet(rows)
    utils.rerender(tree())
  }
  return { ...utils, load }
}

beforeEach(() => {
  window.sessionStorage.clear()
  fleetState.current = fleet([], false)
})

describe('CockpitUrlSync — 默认选中 / 无效 ref 回退 / 跨舱', () => {
  it('无 ref：编队首次加载完成后也不自动选面（停在舰桥）', async () => {
    const rows = [
      jobRow(job('run1', { status: 'running' })),
      jobRow(job('need-first', { status: 'awaiting_review' })),
      jobRow(job('need-second', { status: 'awaiting_review' })),
    ]
    const { load } = renderSync('/cabin/c1/cockpit', fleet([], false))
    expect(screen.getByTestId('selection').textContent).toBe('none')

    load(rows)
    // 编队到齐后仍不弹详情；URL 也不写 job 参数。
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(screen.getByTestId('selection').textContent).toBe('none')
    expect(screen.getByTestId('url').textContent).toBe('/cabin/c1/cockpit')
  })

  it('?job 无效 → 收面并清掉 URL 参数（不自动弹另一条）', async () => {
    const rows = [jobRow(job('j1', { status: 'ready' })), jobRow(job('run1', { status: 'running' }))]
    const { load } = renderSync('/cabin/c1/cockpit?job=gone', fleet([], false))
    load(rows)
    await waitFor(() => expect(screen.getByTestId('selection').textContent).toBe('none'))
    await waitFor(() => expect(screen.getByTestId('url').textContent).toBe('/cabin/c1/cockpit'))
  })

  it('?job 无效且编队为空 → 收面并清掉 URL 参数', async () => {
    const { load } = renderSync('/cabin/c1/cockpit?job=gone', fleet([], false))
    load([])
    await waitFor(() => expect(screen.getByTestId('selection').textContent).toBe('none'))
    await waitFor(() => expect(screen.getByTestId('url').textContent).toBe('/cabin/c1/cockpit'))
  })

  it('旧跨舱参数 ?cabin= 被忽略：只认入口舱，残留参数被清掉', async () => {
    const rows = [
      jobRow(job('j1', { status: 'running' })),
      jobRow(job('jx', { status: 'running' }, 'c2')),
    ]
    const { load } = renderSync('/cabin/c1/cockpit?job=jx&cabin=c2', fleet([], false))
    load(rows)
    // jx 属于 c2：对入口舱 c1 来说是无效深链 → 收面，不弹别的作业。
    await waitFor(() => expect(screen.getByTestId('selection').textContent).toBe('none'))
    await waitFor(() => expect(screen.getByTestId('url').textContent).toBe('/cabin/c1/cockpit'))
  })

  it('merged attention 命中 job 行时 ?attn 仍算有效（不回退）', async () => {
    const attention = {
      id: 'a1',
      job_id: 'j1',
      stage: 'review' as const,
      awaiting: 'person' as const,
      title: '待验收',
      task_id: null,
      repo: null,
      wt: null,
      deep_link: null,
    }
    const rows: CockpitRow[] = [{ ...jobRow(job('j1')), attention } as CockpitRow]
    const { load } = renderSync('/cabin/c1/cockpit?attn=a1', fleet([], false))
    load(rows)
    await waitFor(() => expect(screen.getByTestId('selection').textContent).toBe('attention:c1:a1'))
    expect(screen.getByTestId('url').textContent).toBe('/cabin/c1/cockpit?attn=a1')
  })
})

function EntryProbe() {
  const { enterCockpit, exitCockpit } = useCockpitEntry()
  const nav = useAppNavigation()
  const search = nav?.searchParams.toString() ?? ''
  return (
    <>
      <output data-testid="path">{nav ? `${nav.pathname}${search ? `?${search}` : ''}` : ''}</output>
      <button
        type="button"
        data-testid="enter-job"
        onClick={() => enterCockpit({ cabinId: 'c1', ref: { kind: 'job', cabinId: 'c1', id: 'j1' } })}
      >enter-job</button>
      <button
        type="button"
        data-testid="enter-default"
        onClick={() => enterCockpit({ cabinId: 'c1' })}
      >enter-default</button>
      <button type="button" data-testid="exit" onClick={() => exitCockpit('c1')}>exit</button>
    </>
  )
}

function renderEntry(initial: string) {
  return render(
    <MemoryRouter initialEntries={[initial]}>
      <AppNavProvider>
        <EntryProbe />
      </AppNavProvider>
    </MemoryRouter>,
  )
}

describe('useCockpitEntry — origin 往返', () => {
  it('桌面 → 全域 → 桌面（origin 回原路径，退出后清除）', async () => {
    renderEntry('/')
    fireEvent.click(screen.getByTestId('enter-job'))
    await waitFor(() => expect(screen.getByTestId('path').textContent).toBe('/cabin/c1/cockpit?job=j1'))
    expect(window.sessionStorage.getItem(COCKPIT_ORIGIN_KEY)).toBe('/')

    fireEvent.click(screen.getByTestId('exit'))
    await waitFor(() => expect(screen.getByTestId('path').textContent).toBe('/'))
    expect(readCockpitOrigin()).toBeNull()
  })

  it('舱内 → 全域 → 舱内（origin 带路径）', async () => {
    renderEntry('/cabin/c1')
    fireEvent.click(screen.getByTestId('enter-default'))
    await waitFor(() => expect(screen.getByTestId('path').textContent).toBe('/cabin/c1/cockpit'))
    expect(window.sessionStorage.getItem(COCKPIT_ORIGIN_KEY)).toBe('/cabin/c1')

    fireEvent.click(screen.getByTestId('exit'))
    await waitFor(() => expect(screen.getByTestId('path').textContent).toBe('/cabin/c1'))
  })

  it('深链直接进（无 origin）→ 出口回 /cabin/:entryCabinId', async () => {
    renderEntry('/cabin/c1/cockpit?job=j1')
    expect(readCockpitOrigin()).toBeNull()
    fireEvent.click(screen.getByTestId('exit'))
    await waitFor(() => expect(screen.getByTestId('path').textContent).toBe('/cabin/c1'))
  })

  it('全域内部再点入口不覆盖已有 origin', async () => {
    window.sessionStorage.setItem(COCKPIT_ORIGIN_KEY, '/desk')
    renderEntry('/cabin/c1/cockpit?job=j1')
    fireEvent.click(screen.getByTestId('enter-job'))
    await waitFor(() => expect(screen.getByTestId('path').textContent).toBe('/cabin/c1/cockpit?job=j1'))
    expect(window.sessionStorage.getItem(COCKPIT_ORIGIN_KEY)).toBe('/desk')

    fireEvent.click(screen.getByTestId('exit'))
    await waitFor(() => expect(screen.getByTestId('path').textContent).toBe('/desk'))
  })

  it('origin 不能是 /cockpit（防止返回原地打转）', () => {
    writeCockpitOrigin('/cabin/c1/cockpit?job=j1')
    expect(readCockpitOrigin()).toBeNull()
    writeCockpitOrigin('https://evil.example/x')
    expect(readCockpitOrigin()).toBeNull()
    writeCockpitOrigin('/cabin/c1')
    expect(readCockpitOrigin()).toBe('/cabin/c1')
  })
})
