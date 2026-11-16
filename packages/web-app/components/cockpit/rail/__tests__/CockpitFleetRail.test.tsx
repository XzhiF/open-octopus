// S3 左栏编队 RTL：三型行渲染 / 点击 payload / pct=null 不画条 / 空态 /
// arrivals pop / ↑↓ 与输入框让位。数据全部走 useCockpitFleet mock，不 fetch；
// selection 用真实的 CockpitStateProvider 断言。编队只含入口舱（2026-11-15）。

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import type { CabinAttentionItem } from '@octopus/shared'
import type { CabinJobView } from '@/lib/cabin-api'
import type { CabinTaskRow } from '@/components/cabin/modules/ui'
import { CockpitStateProvider, useCockpitState } from '../../state/CockpitStateProvider'
import { buildCounts, sortRows, type CockpitRow } from '../../fleet/fleet-model'
import type { CockpitFleetContextValue } from '../../fleet/CockpitFleetProvider'
import { CockpitFleetRail } from '../CockpitFleetRail'
import { AskWindowsProvider, useAskWindows } from '@/components/cabin/asks/ask-windows-provider'

const fleetState = vi.hoisted(() => ({ value: null as unknown }))

vi.mock('../../fleet/CockpitFleetProvider', () => ({
  useCockpitFleet: () => fleetState.value,
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
    priority: 0,
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
    priority: 1,
    ...over,
  }
}

function attentionRow(
  id: string,
  over: Partial<CabinAttentionItem> = {},
): CockpitRow {
  return {
    key: `attn:${id}`,
    kind: 'attention',
    cabinId: 'c1',
    cabinName: '舱一',
    item: attention(id, over),
  }
}

function taskRow(
  id: string,
  over: Partial<CabinTaskRow> = {},
  pct = 40,
  cabinId = 'c1',
): CockpitRow {
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
    cabinId,
    cabinName: cabinId === 'c1' ? '舱一' : '舱二',
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

describe('CockpitFleetRail', () => {
  it('三型行按组渲染：job / 合成 task / attention-only', () => {
    const needJob = jobRow(jobView('j1', { status: 'awaiting_review', title: 'M2 · 结算对账' }), {
      attention: attention('a1', { job_id: 'j1', stage: 'review' }),
      pct: 100,
    })
    const runJob = jobRow(jobView('j2', { status: 'running', kind: 'workflow', title: 'M2 · 限流阈值' }))
    const syntheticTask = taskRow('t1', { name: '历史舱任务' })
    const onlyAttention = attentionRow('a2', {
      stage: 'answer',
      title: '阈值定多少',
      question: '600 / 900 / 再压测',
    })

    renderRail({
      rows: sortRows([needJob, runJob, syntheticTask, onlyAttention]),
      counts: buildCounts([needJob, runJob, syntheticTask, onlyAttention], null),
    })

    expect(document.querySelector('.ck12-rail-g[data-group="need"]')).toHaveTextContent('需要你')
    expect(document.querySelector('.ck12-rail-g[data-group="run"]')).toHaveTextContent('运行中')

    // job：标题 + 状态 + 挂了 attention 的小徽章
    const jobNode = row('job:j1')
    expect(within(jobNode).getByText('M2 · 结算对账')).toBeInTheDocument()
    expect(within(jobNode).getByText('待验收')).toBeInTheDocument()
    expect(within(jobNode).getByText('等你验收')).toBeInTheDocument()

    // 合成 task：显式「任务」标
    const taskNode = row('task:t1')
    expect(within(taskNode).getByText('历史舱任务')).toBeInTheDocument()
    expect(within(taskNode).getByText('任务', { selector: '.ck12-rail-kind' })).toBeInTheDocument()

    // attention-only：阶段 + title + question 截断 + 等你
    const attnNode = row('attn:a2')
    expect(within(attnNode).getByText('阈值定多少')).toBeInTheDocument()
    expect(within(attnNode).getByText('600 / 900 / 再压测 · 舱一')).toBeInTheDocument()
    expect(within(attnNode).getByText('等你')).toBeInTheDocument()

    // 分组标题下的条数
    expect(within(screen.getByText('需要你').parentElement as HTMLElement).getByText('2'))
      .toBeInTheDocument()
  })

  it('点击三型行分别写出 job / task / attention 的 select payload', () => {
    const job = jobRow(jobView('j1', { status: 'running' }))
    const task = taskRow('t1')
    const attn = attentionRow('a1', { title: '待裁决' })
    renderRail({ rows: sortRows([job, task, attn]) })

    fireEvent.click(row('job:j1'))
    expect(screen.getByTestId('selection')).toHaveTextContent('job:c1:j1')

    fireEvent.click(row('task:t1'))
    expect(screen.getByTestId('selection')).toHaveTextContent('task:c1:t1')

    fireEvent.click(row('attn:a1'))
    expect(screen.getByTestId('selection')).toHaveTextContent('attention:c1:a1')

    expect(row('attn:a1')).toHaveAttribute('aria-selected', 'true')
    expect(row('job:j1')).toHaveAttribute('aria-selected', 'false')
    expect(screen.getByRole('listbox')).toHaveAttribute(
      'aria-activedescendant',
      row('attn:a1').id,
    )
  })

  it('不再渲染舱筛选胶囊（全域只含入口舱）', () => {
    const rows = sortRows([jobRow(jobView('j1'))])
    renderRail({ rows, counts: buildCounts(rows, null) })
    expect(screen.queryByRole('toolbar', { name: '按舱筛选' })).toBeNull()
    expect(screen.queryByRole('button', { name: /全部/ })).toBeNull()
    expect(row('job:j1')).toBeInTheDocument()
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

    // 有上一份编队：不把旧数据冒充最新，显示 stale 条 + 重试
    first.unmount()
    const rows = sortRows([jobRow(jobView('j1'))])
    renderRail({ rows, counts: buildCounts(rows, null), error: 'HTTP 500', refetch })
    expect(screen.getByTestId('cockpit-rail-stale')).toHaveTextContent('刷新失败')
    expect(row('job:j1')).toBeInTheDocument()
  })

  it('pct=null 的 job 不画进度条，task 的真 pct 才画', () => {
    const job = jobRow(jobView('j1', { status: 'running' }), { pct: null })
    const task = taskRow('t1', {}, 40)
    renderRail({ rows: sortRows([job, task]) })

    const jobNode = row('job:j1')
    expect(jobNode.querySelector('.ck12-rail-bar')).toBeNull()
    expect(within(jobNode).queryByText(/%/)).toBeNull()

    const taskNode = row('task:t1')
    expect(taskNode.querySelector('.ck12-rail-bar')).not.toBeNull()
    expect(within(taskNode).getByText('40%')).toBeInTheDocument()
  })

  it('arrivals 命中的 attention 行带 900ms pop class', () => {
    const attn = attentionRow('a1', { title: '刚到的事' })
    const job = jobRow(jobView('j1'))
    renderRail({ rows: sortRows([attn, job]), arrivals: ['a1'] })

    expect(row('attn:a1').className).toMatch(/is-pop/)
    expect(row('job:j1').className).not.toMatch(/is-pop/)
  })

  it('首次出现的新 key 也 pop', () => {
    const j1 = jobRow(jobView('j1'))
    fleetState.value = fleet({ rows: sortRows([j1]) })
    const view = render(ui())
    expect(row('job:j1')).toBeInTheDocument()

    const j2 = jobRow(jobView('j2'))
    fleetState.value = fleet({ rows: sortRows([j1, j2]) })
    view.rerender(ui())

    expect(row('job:j2').className).toMatch(/is-pop/)
    expect(row('job:j1').className).not.toMatch(/is-pop/)
  })

  it('↑↓ 在当前可见行内移动并 select；输入框聚焦时不抢键', () => {
    const attn = attentionRow('a1')
    const job = jobRow(jobView('j1'))
    renderRail({ rows: sortRows([attn, job]) })

    fireEvent.keyDown(document.body, { key: 'ArrowDown' })
    expect(screen.getByTestId('selection')).toHaveTextContent('attention:c1:a1')

    fireEvent.keyDown(document.body, { key: 'ArrowDown' })
    expect(screen.getByTestId('selection')).toHaveTextContent('job:c1:j1')

    fireEvent.keyDown(document.body, { key: 'ArrowUp' })
    expect(screen.getByTestId('selection')).toHaveTextContent('attention:c1:a1')

    // 清空选择后，在输入框里按 ↓ 不接管
    fireEvent.click(row('job:j1'))
    expect(screen.getByTestId('selection')).toHaveTextContent('job:c1:j1')

    const input = screen.getByTestId('chat-input')
    input.focus()
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(screen.getByTestId('selection')).toHaveTextContent('job:c1:j1')
  })
})

// ── 「等你答」组（design 26 §3.1 / §3.6）──────────────────────────────
function AskProbe() {
  const { windows } = useAskWindows()
  return <output data-testid="ask-windows">{windows.map((w) => w.askId).join(',')}</output>
}

function uiWithAsks(attention: CabinAttentionItem[]) {
  return (
    <CockpitStateProvider entryCabinId="c1">
      <AskWindowsProvider attention={attention}>
        <SelectionProbe />
        <AskProbe />
        <CockpitFleetRail />
      </AskWindowsProvider>
    </CockpitStateProvider>
  )
}

describe('CockpitFleetRail · 等你答', () => {
  const askItem = attention('a1', {
    id: 'ask-a1',
    stage: 'answer',
    title: '支付接入 · 待回答',
    question: '接哪个渠道？',
    task_id: 't1',
    deep_link: 'ask:a1',
    ask: {
      ask_id: 'a1',
      message_id: 'm1',
      author_session_id: 's1',
      decision: '接哪个渠道',
      options: [{ label: '支付宝', impact: '3 天' }],
    },
  })

  it('组标题 + 一行一题；点行开窗、不切面、不在 need 重复', () => {
    const job = jobRow(jobView('j1', { status: 'running' }), { attention: askItem })
    const attn = attentionRow('a1', {
      id: 'ask-a1', stage: 'answer', title: '支付接入 · 待回答', question: '接哪个渠道？', ask: askItem.ask,
    })
    fleetState.value = fleet({
      rows: sortRows([job, attn]),
      counts: buildCounts([job, attn], null),
    })
    render(uiWithAsks([askItem]))

    expect(document.querySelector('.ck12-rail-g[data-group="ask"]')).toHaveTextContent('等你答')
    const askNode = screen.getByTestId('cockpit-rail-ask-a1')
    expect(within(askNode).getByText('支付接入')).toBeInTheDocument()
    expect(within(askNode).getByText('接哪个渠道？')).toBeInTheDocument()
    expect(within(askNode).getByText('回答')).toBeInTheDocument()

    // 同一条 attention 不再出现在「需要你」
    expect(screen.queryByTestId('cockpit-rail-row-attn:a1')).not.toBeInTheDocument()

    fireEvent.click(askNode)
    expect(screen.getByTestId('ask-windows').textContent).toBe('a1')
    expect(screen.getByTestId('selection').textContent).toBe('none')
  })

  it('只有提问、没有编队行时仍渲染（不显示「这个舱没有作业」）', () => {
    fleetState.value = fleet({
      rows: sortRows([attentionRow('a1', {
        id: 'ask-a1', stage: 'answer', title: '支付接入 · 待回答', ask: askItem.ask,
      })]),
      counts: buildCounts([], null),
    })
    render(uiWithAsks([askItem]))
    expect(screen.getByTestId('cockpit-rail-ask-a1')).toBeInTheDocument()
    expect(screen.queryByText('这个舱没有作业')).not.toBeInTheDocument()
  })

  it('↑↓ 落在提问行，Enter 开窗', () => {
    fleetState.value = fleet({ rows: sortRows([jobRow(jobView('j1', { status: 'running' }))]) })
    render(uiWithAsks([askItem]))
    fireEvent.keyDown(window, { key: 'ArrowDown' })
    expect(screen.getByTestId('cockpit-rail-ask-a1')).toHaveClass('is-on')
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Enter' })
    expect(screen.getByTestId('ask-windows').textContent).toBe('a1')
  })
})
