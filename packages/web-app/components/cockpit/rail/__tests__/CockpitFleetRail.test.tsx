// v21（design 31 §3.1）左栏编队 RTL：单列 hex 卡 / 状态+创建时间排序 /
// 6 行 + 更多 / 点击写 select / pct=null 不画条 / attention 行归右栏 inbox。
// 数据全部走 useCockpitFleet mock，不 fetch；selection 用真实的 CockpitStateProvider。

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import type { CabinAttentionItem } from '@octopus/shared'
import type { CabinJobView } from '@/lib/cabin-api'
import type { CabinTaskRow } from '@/components/cabin/modules/ui'
import { CockpitStateProvider, useCockpitState } from '../../state/CockpitStateProvider'
import { buildCounts, sortRows, type CockpitRow } from '../../fleet/fleet-model'
import type { CockpitFleetContextValue } from '../../fleet/CockpitFleetProvider'
import { CockpitFleetRail } from '../CockpitFleetRail'

const fleetState = vi.hoisted(() => ({ value: null as unknown }))

vi.mock('../../fleet/CockpitFleetProvider', () => ({
  useCockpitFleet: () => fleetState.value,
}))
vi.mock('../../chat/use-cockpit-threads', () => ({
  useCockpitThreads: () => ({ threads: [], byKey: new Map(), active: null, visible: [] }),
}))

function fleet(over: Partial<CockpitFleetContextValue> = {}): CockpitFleetContextValue {
  return {
    rows: [],
    counts: null,
    arrivals: [],
    loading: false,
    error: null,
    refetch: () => {},
    ...over,
  }
}

function jobView(id: string, over: Partial<CabinJobView> = {}): CabinJobView {
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

function jobRow(
  job: CabinJobView,
  over: Partial<Extract<CockpitRow, { kind: 'job' }>> = {},
): CockpitRow {
  return {
    key: `job:${job.id}`,
    kind: 'job',
    cabinId: 'c1',
    cabinName: '舱一',
    job,
    pct: null,
    ...over,
  }
}

function attention(id: string, over: Partial<CabinAttentionItem> = {}): CabinAttentionItem {
  return {
    id,
    job_id: null,
    stage: 'review',
    awaiting: 'person',
    title: `事项 ${id}`,
    task_id: null,
    repo: null,
    wt: null,
    deep_link: null,
    ...over,
  }
}

function attentionRow(id: string, over: Partial<CabinAttentionItem> = {}): CockpitRow {
  return {
    key: `attn:${id}`,
    kind: 'attention',
    cabinId: 'c1',
    cabinName: '舱一',
    item: attention(id, over),
  }
}

function taskRow(id: string, over: Partial<CabinTaskRow> = {}, pct = 40): CockpitRow {
  const task = {
    id,
    repo_group: 'repo-a',
    name: `任务 ${id}`,
    status: 'running',
    created_at: '2026-11-14T09:00:00.000Z',
    updated_at: '2026-11-14T09:30:00.000Z',
    ...over,
  } as unknown as CabinTaskRow
  return {
    key: `task:${id}`,
    kind: 'task',
    cabinId: 'c1',
    cabinName: '舱一',
    task,
    pct,
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

function ui() {
  return (
    <CockpitStateProvider entryCabinId="c1">
      <input data-testid="chat-input" aria-label="聊天输入" />
      <SelectionProbe />
      <CockpitFleetRail />
    </CockpitStateProvider>
  )
}

function renderRail(over: Partial<CockpitFleetContextValue> = {}) {
  fleetState.value = fleet(over)
  return render(ui())
}

function row(key: string) {
  return screen.getByTestId(`cockpit-rail-row-${key}`)
}

beforeEach(() => {
  fleetState.value = fleet()
})

describe('CockpitFleetRail · v21 单列编队', () => {
  it('job / 合成 task 渲染成单列 hex 卡；attention-only 行不进编队', () => {
    const needJob = jobRow(jobView('j1', { status: 'awaiting_review', title: 'M2 · 结算对账' }), {
      attention: attention('a1', { job_id: 'j1', stage: 'review' }),
      pct: 100,
    })
    const runJob = jobRow(jobView('j2', { status: 'running', kind: 'workflow', title: 'M2 · 限流阈值' }))
    const syntheticTask = taskRow('t1', { name: '历史舱任务' })
    const onlyAttention = attentionRow('a2', { stage: 'answer', title: '阈值定多少' })

    renderRail({
      rows: sortRows([needJob, runJob, syntheticTask, onlyAttention]),
      counts: buildCounts([needJob, runJob, syntheticTask, onlyAttention], null),
    })

    // 单列：不再有分组标题
    expect(document.querySelector('.ck12-rail-g')).toBeNull()

    const jobNode = row('job:j1')
    expect(within(jobNode).getByText('M2 · 结算对账')).toBeInTheDocument()
    expect(within(jobNode).getAllByText('等你验收').length).toBeGreaterThan(0)
    expect(jobNode.querySelector('.ck12-flhw')).not.toBeNull()

    expect(within(row('task:t1')).getByText('历史舱任务')).toBeInTheDocument()
    expect(within(row('job:j2')).getByText('作战中')).toBeInTheDocument()

    // 纯 attention 行走右栏 inbox，不在左栏重复
    expect(screen.queryByTestId('cockpit-rail-row-attn:a2')).toBeNull()
  })

  it('按状态 rank → 创建时间升序排序（受阻→等你→在跑→待命→归档）', () => {
    const queue = jobRow(jobView('q', {
      status: 'pending',
      title: '待命',
      created_at: '2026-11-14T10:00:00.000Z',
    }))
    const run = jobRow(jobView('r', { status: 'running', title: '在跑', created_at: '2026-11-14T09:00:00.000Z' }))
    const blocked = jobRow(jobView('b', { status: 'blocked', title: '受阻', created_at: '2026-11-14T11:00:00.000Z' }))
    const wait = jobRow(jobView('w', {
      status: 'awaiting_review',
      title: '等你',
      created_at: '2026-11-14T08:00:00.000Z',
    }))
    renderRail({ rows: sortRows([queue, run, blocked, wait]) })

    const ids = [...document.querySelectorAll('[data-testid^="cockpit-rail-row-"]')]
      .map((node) => node.getAttribute('data-testid'))
    expect(ids).toEqual([
      'cockpit-rail-row-job:b',
      'cockpit-rail-row-job:w',
      'cockpit-rail-row-job:r',
      'cockpit-rail-row-job:q',
    ])
  })

  it('默认 6 行；更多 +N 展开全部，收起回到 6 行', () => {
    const rows = Array.from({ length: 9 }, (_, i) => jobRow(jobView(`j${i}`, {
      title: `作业 ${i}`,
      created_at: `2026-11-14T0${i}:00:00.000Z`,
    })))
    renderRail({ rows, counts: buildCounts(rows, null) })

    expect(document.querySelectorAll('[data-testid^="cockpit-rail-row-"]')).toHaveLength(6)
    const more = screen.getByTestId('cockpit-fleet-more')
    expect(more).toHaveTextContent('+3')

    fireEvent.click(more)
    expect(document.querySelectorAll('[data-testid^="cockpit-rail-row-"]')).toHaveLength(9)
    expect(screen.getByTestId('cockpit-fleet-more')).toHaveTextContent('收起')

    fireEvent.click(screen.getByTestId('cockpit-fleet-more'))
    expect(document.querySelectorAll('[data-testid^="cockpit-rail-row-"]')).toHaveLength(6)
  })

  it('点击 job / task 写出对应 select payload', () => {
    renderRail({ rows: sortRows([jobRow(jobView('j1')), taskRow('t1')]) })

    fireEvent.click(row('job:j1'))
    expect(screen.getByTestId('selection')).toHaveTextContent('job:c1:j1')

    fireEvent.click(row('task:t1'))
    expect(screen.getByTestId('selection')).toHaveTextContent('task:c1:t1')
    expect(row('task:t1')).toHaveAttribute('aria-selected', 'true')
    expect(row('job:j1')).toHaveAttribute('aria-selected', 'false')
  })

  it('空编队显示空态', () => {
    renderRail({ rows: [] })
    expect(screen.getByText('编队空着 · 从主对话派一条')).toBeInTheDocument()
  })

  it('加载失败：空态给出错误与重试；有旧快照时明确标 stale', () => {
    const refetch = vi.fn()
    const first = renderRail({ rows: [], loading: false, error: 'HTTP 404', refetch })
    expect(screen.getByText(/编队加载失败 · HTTP 404/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(refetch).toHaveBeenCalledTimes(1)

    first.unmount()
    const rows = sortRows([jobRow(jobView('j1'))])
    renderRail({ rows, counts: buildCounts(rows, null), error: 'HTTP 500', refetch })
    expect(screen.getByTestId('cockpit-rail-stale')).toHaveTextContent('刷新失败')
    expect(row('job:j1')).toBeInTheDocument()
  })

  it('pct=null 不画进度条；真 pct 才画条并写 --p', () => {
    const job = jobRow(jobView('j1', { status: 'running' }), { pct: null })
    const task = taskRow('t1', {}, 40)
    renderRail({ rows: sortRows([job, task]) })

    const jobNode = row('job:j1')
    expect(jobNode.querySelector('.ck12-flbar')).toBeNull()
    expect(within(jobNode).queryByText(/%/)).toBeNull()
    expect(jobNode.style.getPropertyValue('--p')).toBe('0')

    const taskNode = row('task:t1')
    expect(taskNode.querySelector('.ck12-flbar')).not.toBeNull()
    expect(within(taskNode).getByText('40%')).toBeInTheDocument()
    expect(taskNode.style.getPropertyValue('--p')).toBe('40')
  })

  it('arrivals 命中的 job 行带 pop class', () => {
    const attn = attention('a1')
    const job = jobRow(jobView('j1'), { attention: attn })
    const other = jobRow(jobView('j2', { created_at: '2026-11-14T10:00:00.000Z' }))
    renderRail({ rows: sortRows([job, other]), arrivals: ['a1'] })

    expect(row('job:j1').className).toMatch(/is-pop|is-arrived/)
    expect(row('job:j2').className).not.toMatch(/is-pop|is-arrived/)
  })

  it('↑↓ 在可见行内移动并 select；输入框聚焦时不抢键', () => {
    const j1 = jobRow(jobView('j1'))
    const j2 = jobRow(jobView('j2', { created_at: '2026-11-14T10:00:00.000Z' }))
    renderRail({ rows: sortRows([j1, j2]) })

    fireEvent.keyDown(document.body, { key: 'ArrowDown' })
    expect(screen.getByTestId('selection')).toHaveTextContent('job:c1:j1')

    fireEvent.keyDown(document.body, { key: 'ArrowDown' })
    expect(screen.getByTestId('selection')).toHaveTextContent('job:c1:j2')

    fireEvent.keyDown(document.body, { key: 'ArrowUp' })
    expect(screen.getByTestId('selection')).toHaveTextContent('job:c1:j1')

    const input = screen.getByTestId('chat-input')
    input.focus()
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(screen.getByTestId('selection')).toHaveTextContent('job:c1:j1')
  })
})
