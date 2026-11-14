// S9 入口/出口 + URL 同步规则：
//   · 桌面/舱内 → 全域 → 原路返回（origin 往返，进入用 push）；
//   · 深链直接进 → 出口回 /cabin/:entryCabinId；
//   · 全域内部再点入口不覆盖 origin；
//   · 默认选中（need 优先级降序 → run → queue），只落一次（⌥2/✕ 收面后不被弹回）；
//   · 无效 ref 回退；跨舱 ref 合法且保留 &cabin=；
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
  it('无 ref：编队首次加载完成后落 need（priority 降序）', async () => {
    const rows = [
      jobRow(job('run1', { status: 'running' })),
      jobRow(job('need-low', { status: 'awaiting_review', priority: 2 })),
      jobRow(job('need-high', { status: 'awaiting_review', priority: 9 })),
    ]
    const { load } = renderSync('/cabin/c1/cockpit', fleet([], false))
    expect(screen.getByTestId('selection').textContent).toBe('none')

    load(rows)
    await waitFor(() => expect(screen.getByTestId('selection').textContent).toBe('job:c1:need-high'))
    await waitFor(() => expect(screen.getByTestId('url').textContent).toBe('/cabin/c1/cockpit?job=need-high'))
  })

  it('默认选中只落一次：收面后不会被自动弹回', async () => {
    const rows = [jobRow(job('run1'))]
    const { load } = renderSync('/cabin/c1/cockpit', fleet([], false))
    load(rows)
    await waitFor(() => expect(screen.getByTestId('selection').textContent).toBe('job:c1:run1'))

    fireEvent.click(screen.getByTestId('collapse'))
    await waitFor(() => expect(screen.getByTestId('selection').textContent).toBe('none'))
    await waitFor(() => expect(screen.getByTestId('url').textContent).toBe('/cabin/c1/cockpit'))
    // 再过一帧也不回来
    expect(screen.getByTestId('selection').textContent).toBe('none')
  })

  it('?job 无效 → 落默认选中（编队非空）', async () => {
    const rows = [jobRow(job('j1', { status: 'ready' })), jobRow(job('run1', { status: 'running' }))]
    const { load } = renderSync('/cabin/c1/cockpit?job=gone', fleet([], false))
    load(rows)
    // run 组优先于 queue 组
    await waitFor(() => expect(screen.getByTestId('selection').textContent).toBe('job:c1:run1'))
    await waitFor(() => expect(screen.getByTestId('url').textContent).toBe('/cabin/c1/cockpit?job=run1'))
  })

  it('?job 无效且编队为空 → 收面并清掉 URL 参数', async () => {
    const { load } = renderSync('/cabin/c1/cockpit?job=gone', fleet([], false))
    load([])
    await waitFor(() => expect(screen.getByTestId('selection').textContent).toBe('none'))
    await waitFor(() => expect(screen.getByTestId('url').textContent).toBe('/cabin/c1/cockpit'))
  })

  it('跨舱 ref（?cabin=）合法：不重绑、URL 保留归属舱', async () => {
    const rows = [
      jobRow(job('j1', { status: 'running' })),
      jobRow(job('jx', { status: 'running' }, 'c2')),
    ]
    const { load } = renderSync('/cabin/c1/cockpit?job=jx&cabin=c2', fleet([], false))
    load(rows)
    await waitFor(() => expect(screen.getByTestId('selection').textContent).toBe('job:c2:jx'))
    expect(screen.getByTestId('url').textContent).toBe('/cabin/c1/cockpit?job=jx&cabin=c2')
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
      priority: 4,
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
