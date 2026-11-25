// v21（design 31 §3.1）左栏编队 RTL：单列 hex 卡 / 状态+创建时间排序 /
// 6 行 + 更多 / 点击写 select / pct=null 不画条 / attention 行归右栏 inbox。
// 数据全部走 useCockpitFleet mock，不 fetch；selection 用真实的 CockpitStateProvider。

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import type { CabinAttentionItem } from '@octopus/shared'
import type { CabinJobView } from '@/lib/cabin-api'
import type { CabinTaskRow } from '@/components/cabin/modules/ui'
import { CockpitStateProvider, useCockpitState } from '../../state/CockpitStateProvider'
import { buildCounts, sortRows, type CockpitRow } from '../../fleet/fleet-model'
import type { CockpitFleetContextValue } from '../../fleet/CockpitFleetProvider'
import { CockpitFleetRail } from '../CockpitFleetRail'

const fleetState = vi.hoisted(() => ({ value: null as unknown }))
/** 假线程表：key 在集合里 = 这条作战有会话，行体 / 💬 能开 chat 窗。 */
const threadState = vi.hoisted(() => ({ keys: new Set<string>() }))

vi.mock('../../fleet/CockpitFleetProvider', () => ({
  useCockpitFleet: () => fleetState.value,
}))
vi.mock('../../chat/use-cockpit-threads', () => ({
  useCockpitThreads: () => ({
    threads: [],
    byKey: new Map([...threadState.keys].map((key) => [key, { key, short: key, state: 'wait', ref: null }])),
    active: null,
    visible: [],
  }),
}))

function fleet(over: Partial<CockpitFleetContextValue> = {}): CockpitFleetContextValue {
  return {
    rows: [],
    mainSessionId: null,
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
  const { selection, wins, tab } = useCockpitState()
  return (
    <output data-testid="selection" data-wins={wins.windows.length} data-tab={tab}>
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
  threadState.keys = new Set()
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

  it('没有会话的行：点击 job / task 退回详情（写出对应 select payload）', () => {
    renderRail({ rows: sortRows([jobRow(jobView('j1')), taskRow('t1')]) })

    fireEvent.click(row('job:j1'))
    expect(screen.getByTestId('selection')).toHaveTextContent('job:c1:j1')

    fireEvent.click(row('task:t1'))
    expect(screen.getByTestId('selection')).toHaveTextContent('task:c1:t1')
    expect(row('task:t1')).toHaveAttribute('aria-selected', 'true')
    expect(row('job:j1')).toHaveAttribute('aria-selected', 'false')
  })

  it('有会话的行：行体 / 💬 开独立 chat 窗（不动主通讯台）；▦ 开「运行」详情', () => {
    threadState.keys.add('job:j1')
    renderRail({ rows: sortRows([jobRow(jobView('j1'))]) })

    fireEvent.click(row('job:j1'))
    expect(screen.getByTestId('selection')).toHaveTextContent('none')
    expect(screen.getByTestId('selection')).toHaveAttribute('data-wins', '1')

    fireEvent.click(screen.getByTestId('cockpit-rail-detail-job:j1'))
    expect(screen.getByTestId('selection')).toHaveTextContent('job:c1:j1')
    expect(screen.getByTestId('selection')).toHaveAttribute('data-tab', 'run')
    // 已开一扇窗：行框标 is-chat。
    expect(row('job:j1').className).toMatch(/is-chat/)
  })

  it('待归档任务：状态签写「待归档」、不画假百分比；详情按钮变 📦 并落归档页签', () => {
    renderRail({ rows: sortRows([taskRow('t-arch', { status: 'awaiting_archive' }, 100)]) })
    const node = row('task:t-arch')
    expect(within(node).getByText('待归档')).toBeInTheDocument()
    expect(node.querySelector('.ck12-flpct')).toBeNull()

    const detail = screen.getByTestId('cockpit-rail-detail-task:t-arch')
    expect(detail.textContent).toContain('📦')
    fireEvent.click(detail)
    expect(screen.getByTestId('selection')).toHaveTextContent('task:c1:t-arch')
    expect(screen.getByTestId('selection')).toHaveAttribute('data-tab', 'archive')
  })

  it('归档中：按「在跑」计数与排序，状态签写「归档中」', () => {
    const archiving = taskRow('t-run-arch', { status: 'archiving' })
    const waiting = taskRow('t-queue', { status: 'ready' })
    renderRail({ rows: sortRows([waiting, archiving]) })
    expect(within(row('task:t-run-arch')).getByText('归档中')).toBeInTheDocument()
    expect(row('task:t-run-arch').getAttribute('data-tone')).toBe('run')
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

  it('pct=null：不画进度条也不猜百分比；真实 pct 只显示数字', () => {
    const running = jobRow(jobView('j1', { status: 'running' }), { pct: null })
    const pending = jobRow(jobView('j2', { status: 'pending' }), { pct: null })
    const task = taskRow('t1', {}, 40)
    renderRail({ rows: sortRows([running, pending, task]) })

    const runNode = row('job:j1')
    expect(runNode.querySelector('.ck12-flbar')).toBeNull()
    expect(within(runNode).queryByText(/%/)).toBeNull()
    expect(runNode.style.getPropertyValue('--p')).toBe('')

    expect(row('job:j2').querySelector('.ck12-flbar')).toBeNull()

    // 2026-11-25 用户：进度条撤了，真实 pct 仍以数字保留。
    const taskNode = row('task:t1')
    expect(taskNode.querySelector('.ck12-flbar')).toBeNull()
    expect(within(taskNode).getByText('40%')).toBeInTheDocument()
    expect(taskNode.style.getPropertyValue('--p')).toBe('')
  })

  it('arrivals 命中的 job 行带 pop class', () => {
    const attn = attention('a1')
    const job = jobRow(jobView('j1'), { attention: attn })
    const other = jobRow(jobView('j2', { created_at: '2026-11-14T10:00:00.000Z' }))
    renderRail({ rows: sortRows([job, other]), arrivals: ['a1'] })

    expect(row('job:j1').className).toMatch(/is-pop|is-arrived/)
    expect(row('job:j2').className).not.toMatch(/is-pop|is-arrived/)
  })

  // v22 #6（2026-11-23 用户）：作战中要有计时，跟流式结果一样每秒走字。
  // 2026-11-25 用户：秒表前加 braille 转字（与 chat 工作行同一套帧）。
  it('作战中行挂活秒表（braille 转字 + mm:ss 每秒走字）；待命/等你答行不画', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-11-14T09:01:05.000Z'))
      const run = jobRow(jobView('j1', { status: 'running', created_at: '2026-11-14T09:00:00.000Z' }))
      const authoring = jobRow(jobView('j3', {
        status: 'ready',
        agent_running: true,
        created_at: '2026-11-14T09:00:05.000Z',
      }))
      const queue = jobRow(jobView('j2', {
        status: 'pending',
        created_at: '2026-11-14T09:00:00.000Z',
      }))
      renderRail({ rows: sortRows([run, authoring, queue]) })

      const clock = within(row('job:j1')).getByTestId('cockpit-rail-clock')
      expect(clock).toHaveTextContent('01:05')
      expect(clock.querySelector('.ck12-flspin')).not.toBeNull()
      expect(clock).toHaveAttribute('title', expect.stringContaining('01:05'))
      // 作者在推进（job 还没进 running）同样算作战中。
      expect(within(row('job:j3')).getByTestId('cockpit-rail-clock')).toHaveTextContent('01:00')
      // 待命行不画秒表。
      expect(within(row('job:j2')).queryByTestId('cockpit-rail-clock')).toBeNull()

      act(() => { vi.advanceTimersByTime(1000) })
      expect(within(row('job:j1')).getByTestId('cockpit-rail-clock')).toHaveTextContent('01:06')
    } finally {
      vi.useRealTimers()
    }
  })

  // v23 十六轮（2026-11-24 用户）：待验收的任务作者还在推进 —— chip 保持生命周期
  // 「等你验收」，行加流动态 / 统一秒表；副行让给秒表。
  // 2026-11-25 用户：进度条撤掉，动势只剩天蓝左缘 + 秒表转字。
  it('待验收 + 作者在跑：chip 仍等你验收，加流动态与统一秒表，不画进度条', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-11-14T09:02:00.000Z'))
      const reviewed = jobRow(jobView('j1', {
        status: 'awaiting_review',
        agent_running: true,
        created_at: '2026-11-14T09:00:00.000Z',
      }), {
        attention: attention('a1', { job_id: 'j1', stage: 'review', title: '待验收' }),
        pct: 100,
      })
      renderRail({ rows: sortRows([reviewed]) })

      const node = row('job:j1')
      expect(node.className).toMatch(/is-wait/)
      expect(node.className).toMatch(/is-flow/)
      expect(within(node).getByText('等你验收')).toBeInTheDocument()
      expect(within(node).queryByText('作战中')).toBeNull()
      expect(within(node).getByTestId('cockpit-rail-clock')).toHaveTextContent('02:00')
      expect(node.querySelector('.ck12-flbar')).toBeNull()
      expect(node.querySelector('.ck12-flspin')).not.toBeNull()
      // 干活行不再显示「项目 · transport」，宽度留给秒表。
      expect(node.querySelector('.ck12-flsub-t')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('作者在等后台：秒表转琥珀色（is-bgw）', () => {
    const waiting = jobRow(jobView('j1', {
      status: 'ready',
      agent_running: true,
      created_at: '2026-11-14T09:00:00.000Z',
    }), { live_phase: 'background-wait' })
    renderRail({ rows: sortRows([waiting]) })

    const clock = within(row('job:j1')).getByTestId('cockpit-rail-clock')
    expect(clock.className).toMatch(/is-bgw/)
  })

  it('已归档行：残留流不点秒表，也不加流动态', () => {
    const done = jobRow(jobView('j1', {
      status: 'done',
      ended_at: '2026-11-14T09:30:00.000Z',
      agent_running: true,
      created_at: '2026-11-14T09:00:00.000Z',
    }), { pct: 100 })
    renderRail({ rows: sortRows([done]) })

    const node = row('job:j1')
    expect(within(node).queryByTestId('cockpit-rail-clock')).toBeNull()
    expect(node.className).not.toMatch(/is-flow/)
    expect(node.querySelector('.ck12-flbar')).toBeNull()
  })

  // 2026-11-25 用户：完结 ≠ 归档。会话交完结论是「待命」（还能继续聊），
  // 归档是汐音管理的独立终态；任务走完归档闸才写「已归档」。
  it('完结 ≠ 归档：会话 done = 待命、archived_at = 已归档；任务走完归档闸 = 已归档', () => {
    const chatJob = jobRow(jobView('chat1', {
      kind: 'subagent', status: 'completed', title: 'D · 环境体检',
      ended_at: '2026-11-14T09:30:00.000Z',
    }))
    const taskJob = jobRow(jobView('t1', {
      kind: 'task', status: 'done', title: 'M2 · 结算',
      ended_at: '2026-11-14T09:30:00.000Z',
    }))
    const delegation: CockpitRow = {
      key: 'delegation:c1:d1',
      kind: 'delegation',
      cabinId: 'c1',
      cabinName: '舱一',
      pct: null,
      delegation: {
        id: 'd1', cabin_id: 'c1', title: '环境体检：五仓 + UAT', intent_text: '体检',
        brief: null, autonomy: 'hands-off', state: 'done',
        doer_session_id: 's1', result_summary: '全绿',
        created_at: '2026-11-14T09:00:00.000Z', updated_at: '2026-11-14T09:30:00.000Z',
        ended_at: '2026-11-14T09:30:00.000Z', archived_at: null, handle: 'D1', color: 1,
      },
    }
    const archived: CockpitRow = {
      ...delegation,
      key: 'delegation:c1:d2',
      delegation: {
        ...delegation.delegation,
        id: 'd2', title: '环境体检：已收口', archived_at: '2026-11-14T10:00:00.000Z',
      },
    }

    renderRail({ rows: sortRows([chatJob, taskJob, delegation, archived]) })

    expect(within(row('job:chat1')).getByText('已完成')).toBeInTheDocument()
    expect(within(row('job:t1')).getByText('已归档')).toBeInTheDocument()
    expect(within(row('delegation:c1:d1')).getByText('待命')).toBeInTheDocument()
    expect(within(row('delegation:c1:d2')).getByText('已归档')).toBeInTheDocument()
    expect(row('delegation:c1:d1').getAttribute('data-tone')).toBe('queue')
    expect(row('delegation:c1:d2').getAttribute('data-tone')).toBe('archived')
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
