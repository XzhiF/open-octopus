// S4 — JobFace（从 CabinJobDetail 抽出的五页签主体）：
//   · 不再依赖 CabinProvider（渲染时故意不包 provider）；
//   · cockpit 变体：五页签、行2 真字段派生、真实动作调用、跨舱不显示「去主对话」；
//   · window 变体：旧 DOM 形状保持不变（详细回归在 CabinModulesP3）。

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react'
import { useState } from 'react'
import type { CabinAttentionItem } from '@octopus/shared'

vi.mock('@/lib/server-config', () => ({ getServerUrl: () => 'http://localhost:3001' }))
vi.mock('@/lib/billing-currency', () => ({
  useBillingCurrency: () => ({ currency: 'CNY', rate: 7 }),
}))
vi.mock('@/lib/cabin-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/cabin-api')>()
  return {
    ...actual,
    getCabinJob: vi.fn(),
    listCabinJobs: vi.fn(),
    getCabinUsage: vi.fn(),
    setCabinJobPriority: vi.fn(),
    setCabinFocus: vi.fn(),
    noteCabinJob: vi.fn(),
  }
})
vi.mock('@/lib/tasks-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/tasks-api')>()
  return {
    ...actual,
    getTask: vi.fn(),
    pauseTask: vi.fn(),
    resumeTask: vi.fn(),
    abortTask: vi.fn(),
  }
})

import {
  getCabinJob, getCabinUsage, listCabinJobs, type CabinJobView,
} from '@/lib/cabin-api'
import { abortTask, getTask, pauseTask, resumeTask } from '@/lib/tasks-api'
import { JobFace, JOB_FACE_TIMEOUT_MS } from '../job-face'
import type { CockpitTab } from '../../cockpit/state/cockpit-state'

function jobView(over: Partial<CabinJobView> = {}): CabinJobView {
  return {
    id: 'j1',
    cabin_id: 'cabin-1',
    kind: 'task',
    ref_id: 't1',
    session_id: 'sess-abcdefgh',
    iteration_id: null,
    title: '接入渠道',
    mandate: null,
    prompt: '把渠道接进来',
    priority: 2,
    created_at: '2026-11-13T14:00:00.000Z',
    ended_at: null,
    status: 'running',
    transport: 'task-thread',
    iteration_code: 'M1',
    ...over,
  }
}

function mockJob(view: Partial<CabinJobView> = {}, opts: { branch?: string } = {}) {
  vi.mocked(listCabinJobs).mockResolvedValue([jobView(view)])
  vi.mocked(getCabinJob).mockResolvedValue({
    job: {
      id: 'j1',
      cabin_id: view.cabin_id ?? 'cabin-1',
      kind: view.kind ?? 'task',
      ref_id: view.ref_id ?? 't1',
      session_id: view.session_id ?? 'sess-abcdefgh',
      iteration_id: null,
      title: view.title ?? '接入渠道',
      mandate: null,
      prompt: '把渠道接进来',
      priority: 2,
      created_at: '2026-11-13T14:00:00.000Z',
      ended_at: view.ended_at ?? null,
    },
    events: [
      {
        id: 'e1',
        job_id: 'j1',
        cabin_id: 'cabin-1',
        kind: 'dispatch',
        actor: 'orchestrator',
        payload: { summary: '派发接入渠道' },
        created_at: '2026-11-13T14:00:00.000Z',
      },
      {
        id: 'e2',
        job_id: 'j1',
        cabin_id: 'cabin-1',
        kind: 'report',
        actor: 'doer',
        payload: { summary: '正在跑 node-2' },
        created_at: '2026-11-13T14:05:00.000Z',
      },
    ],
  })
  vi.mocked(getTask).mockResolvedValue({
    id: 't1',
    name: '接入渠道',
    status: 'running',
    task_spec: { goal: '接入渠道', ac: ['a'], branch: opts.branch },
    executions: [],
  } as never)
  vi.mocked(getCabinUsage).mockResolvedValue({
    summary: {}, byJob: [], subagents: { runs: [] }, grand: {}, timing: {},
  } as never)
}

function Harness({
  cabinId = 'cabin-1',
  entryCabinId = 'cabin-1',
  attention = null,
  hint = null,
  onMutated,
}: {
  cabinId?: string
  entryCabinId?: string
  attention?: CabinAttentionItem | null
  hint?: { title: string; kind: CabinJobView['kind']; status?: string | null } | null
  onMutated?: () => void
}) {
  const [tab, setTab] = useState<CockpitTab>('overview')
  return (
    <JobFace
      cabinId={cabinId}
      cabinVersion={1}
      workspaceId="ws-1"
      jobId="j1"
      variant="cockpit"
      entryCabinId={entryCabinId}
      onMutated={onMutated}
      mainSessionId="sess-main"
      cockpit={{
        cabinName: 'Aurora',
        attention,
        hint,
        tab,
        onTabChange: setTab,
        onClose: () => {},
      }}
    />
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(pauseTask).mockResolvedValue({} as never)
  vi.mocked(resumeTask).mockResolvedValue({} as never)
  vi.mocked(abortTask).mockResolvedValue({} as never)
})

describe('JobFace（cockpit）', () => {
  it('五页签渲染与切换；概览用真事件时间线', async () => {
    // workflow + 无 ref：运行/变更/验收都是轻量空态，只验页签与真时间线。
    mockJob({ kind: 'workflow', ref_id: null, title: '接入渠道' })
    render(<Harness />)
    await screen.findByTestId('cockpit-job-header')
    expect((await screen.findByTestId('cabin-job-overview')).textContent).toContain('派发接入渠道')

    fireEvent.click(screen.getByTestId('cockpit-tab-relay'))
    expect(await screen.findByTestId('cabin-job-relay')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('cockpit-tab-run'))
    expect(await screen.findByTestId('cabin-job-run')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('cockpit-tab-changes'))
    expect(await screen.findByTestId('cabin-job-changes')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('cockpit-tab-accept'))
    expect(await screen.findByTestId('cabin-job-accept')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('cockpit-tab-overview'))
    expect(await screen.findByTestId('cabin-job-overview')).toBeInTheDocument()
  })

  it('行2 用 §1.5 派生：分支 / 在做 / 执行者短 id / 舱名 / 用时 / ¥', async () => {
    mockJob({}, { branch: 'feat-cabin' })
    vi.mocked(getCabinUsage).mockResolvedValue({
      summary: {},
      byJob: [
        {
          job_id: 'j1',
          kind: 'task',
          label: '接入渠道',
          ref_id: 't1',
          totalCalls: 1,
          usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
          totals: { tokens: 0, cost: { usd: 0.18, complete: true }, cacheHitRate: null },
        },
      ],
      subagents: { runs: [] },
      grand: {},
      timing: {},
    } as never)

    render(<Harness />)
    const header = await screen.findByTestId('cockpit-job-header')
    await waitFor(() => expect(header.textContent).toContain('feat-cabin'))
    expect(header.textContent).toContain('正在跑 node-2') // 最后一条 event summary
    expect(header.textContent).toContain('sess-abc') // session_id 短 id
    expect(header.textContent).toContain('⏱')
    await waitFor(() => expect(header.textContent).toContain('¥1.26'))
  })

  it('§1.5 缺值不留占位：无 branch/成本时行2 只剩真实段', async () => {
    mockJob()
    render(<Harness />)
    const header = await screen.findByTestId('cockpit-job-header')
    await waitFor(() => expect(header.textContent).toContain('sess-abc'))
    expect(header.textContent).not.toContain('¥')
    expect(header.textContent).not.toContain('--')
  })

  it('同舱：对接页有「去主对话」并派发 octopus:cabin-main-chat', async () => {
    mockJob()
    const spy = vi.fn()
    window.addEventListener('octopus:cabin-main-chat', spy)
    render(<Harness />)
    fireEvent.click(await screen.findByTestId('cockpit-tab-relay'))
    fireEvent.click(await screen.findByTestId('cockpit-relay-main-chat'))
    expect(spy).toHaveBeenCalledTimes(1)
    window.removeEventListener('octopus:cabin-main-chat', spy)
  })

  it('跨舱：对接页不出现「去主对话」', async () => {
    mockJob({ cabin_id: 'cabin-2' })
    render(<Harness cabinId="cabin-2" entryCabinId="cabin-1" />)
    fireEvent.click(await screen.findByTestId('cockpit-tab-relay'))
    expect(await screen.findByTestId('cabin-job-relay')).toBeInTheDocument()
    expect(screen.queryByTestId('cockpit-relay-main-chat')).toBeNull()
  })

  it('task 动作：暂停/中止走 lib/tasks-api 现有函数并 refetch', async () => {
    mockJob()
    const onMutated = vi.fn()
    render(<Harness onMutated={onMutated} />)
    fireEvent.click(await screen.findByTestId('cockpit-job-pause'))
    await waitFor(() => expect(pauseTask).toHaveBeenCalledWith('t1'))
    fireEvent.click(screen.getByTestId('cockpit-job-abort'))
    await waitFor(() => expect(abortTask).toHaveBeenCalledWith('t1'))
    await waitFor(() => expect(onMutated).toHaveBeenCalled())
  })

  it('paused 时只给「继续」，调用 resumeTask', async () => {
    mockJob({ status: 'paused' })
    render(<Harness />)
    expect(await screen.findByTestId('cockpit-job-resume')).toBeInTheDocument()
    expect(screen.queryByTestId('cockpit-job-pause')).toBeNull()
    fireEvent.click(screen.getByTestId('cockpit-job-resume'))
    await waitFor(() => expect(resumeTask).toHaveBeenCalledWith('t1'))
  })

  it('非 task 作业：变更/验收是明确空态（不伪造）', async () => {
    mockJob({ kind: 'workflow', ref_id: 'exec-1', title: '审计工作流' })
    render(<Harness />)
    fireEvent.click(await screen.findByTestId('cockpit-tab-changes'))
    expect((await screen.findByTestId('cabin-job-changes')).textContent)
      .toContain('这条工作流作业没有交付变更账本')
    fireEvent.click(screen.getByTestId('cockpit-tab-accept'))
    expect((await screen.findByTestId('cabin-job-accept')).textContent)
      .toContain('这条工作流作业没有交付验收单')
  })

  it('有 attention 时「去处理 →」按 stage 切页签（review → 验收）', async () => {
    mockJob({ kind: 'workflow', ref_id: null, status: 'awaiting_review' })
    render(
      <Harness
        attention={{
          id: 'a1', job_id: 'j1', stage: 'review', awaiting: 'person', title: '产物已就绪',
          task_id: 't1', repo: 'pay', wt: null, deep_link: null, priority: 3,
        }}
      />,
    )
    fireEvent.click(await screen.findByTestId('cockpit-job-go'))
    expect(await screen.findByTestId('cabin-job-accept')).toBeInTheDocument()
  })

  it('对接：一条按时间排的交接时间线，每行标出这一跳的方向', async () => {
    const ev = (id: string, kind: string, actor: string, summary: string, at: string) => ({
      id, job_id: 'j1', cabin_id: 'cabin-1', kind, actor,
      payload: { summary }, created_at: at,
    })
    vi.mocked(listCabinJobs).mockResolvedValue([
      jobView({ kind: 'workflow', ref_id: null, title: '审计工作流' }),
    ])
    vi.mocked(getCabinJob).mockResolvedValue({
      job: {
        id: 'j1', cabin_id: 'cabin-1', kind: 'workflow', ref_id: null,
        session_id: null, iteration_id: null, title: '审计工作流',
        mandate: null, prompt: '把渠道接进来', priority: 1,
        created_at: '2026-11-13T14:00:00.000Z', ended_at: null,
      },
      events: [
        // 故意乱序给：时间线必须按 created_at 排，不是给什么顺序画什么顺序。
        ev('e2', 'report', 'doer', '回报：已完成', '2026-11-13T14:20:00.000Z'),
        ev('e1', 'dispatch', 'orchestrator', '派发执行', '2026-11-13T14:10:00.000Z'),
        ev('e3', 'human_input', 'human', '补充一句', '2026-11-13T14:30:00.000Z'),
      ],
    })

    render(<Harness />)
    fireEvent.click(await screen.findByTestId('cockpit-tab-relay'))

    const rows = await screen.findAllByTestId(/^cabin-relay-event-/)
    expect(rows.map((row) => row.getAttribute('data-testid'))).toEqual([
      'cabin-relay-event-e1', 'cabin-relay-event-e2', 'cabin-relay-event-e3',
    ])
    // 方向按事件类型写死：派发=汐音→执行者，回报=执行者→汐音，人输入=你→汐音。
    expect(rows[0].textContent).toContain('汐音')
    expect(rows[0].textContent).toContain('执行者')
    expect(rows[1].textContent).toContain('回报：已完成')
    expect(rows[2].textContent).toContain('你')
    // 派发原文钉在第 0 条（整段需求默认收 3 行）。
    expect(screen.getByTestId('cabin-job-relay').textContent).toContain('派发原文')
    expect(screen.getByTestId('cabin-job-relay').textContent).toContain('把渠道接进来')
  })

  it('对接：连续的「提优先」折叠成一条，并写明区间与次数', async () => {
    const bump = (id: string, priority: number, at: string) => ({
      id, job_id: 'j1', cabin_id: 'cabin-1', kind: 'human_input', actor: 'human',
      payload: { action: 'priority', priority }, created_at: at,
    })
    vi.mocked(listCabinJobs).mockResolvedValue([
      jobView({ kind: 'workflow', ref_id: null, title: '审计工作流' }),
    ])
    vi.mocked(getCabinJob).mockResolvedValue({
      job: {
        id: 'j1', cabin_id: 'cabin-1', kind: 'workflow', ref_id: null,
        session_id: null, iteration_id: null, title: '审计工作流',
        mandate: null, prompt: null, priority: 6,
        created_at: '2026-11-13T14:00:00.000Z', ended_at: null,
      },
      events: [
        bump('p2', 2, '2026-11-13T14:01:00.000Z'),
        bump('p3', 3, '2026-11-13T14:02:00.000Z'),
        bump('p4', 4, '2026-11-13T14:03:00.000Z'),
        bump('p5', 5, '2026-11-13T14:04:00.000Z'),
        bump('p6', 6, '2026-11-13T14:05:00.000Z'),
      ],
    })

    render(<Harness />)
    fireEvent.click(await screen.findByTestId('cockpit-tab-relay'))
    const rows = await screen.findAllByTestId(/^cabin-relay-event-/)
    expect(rows).toHaveLength(1)
    expect(rows[0].textContent).toContain('提优先 P2 → P6 · 5 次')
  })
})

describe('JobFace（cockpit）· 加载容错', () => {
  it('作业详情吊死：到预算显示失败 + 重试，重试成功即出图', async () => {
    vi.useFakeTimers()
    try {
      vi.mocked(getCabinJob).mockImplementation(() => new Promise(() => {}))
      vi.mocked(listCabinJobs).mockResolvedValue([jobView()])
      render(<Harness />)
      expect(screen.getByTestId('cockpit-face-job')).toBeInTheDocument()

      await act(async () => { await vi.advanceTimersByTimeAsync(JOB_FACE_TIMEOUT_MS) })

      const err = screen.getByTestId('cockpit-face-job-error')
      expect(err.textContent).toContain('作业详情超时')

      // 接口恢复后点重试：同一份界面不再卡在「载入作业…」。
      mockJob({ kind: 'workflow', ref_id: null, title: '接入渠道' })
      fireEvent.click(screen.getByText('重试'))
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })

      expect(screen.queryByTestId('cockpit-face-job-error')).toBeNull()
      expect(screen.getByTestId('cockpit-job-header')).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('载入中：头部就用编队行摘要画（标题/类型/状态），不是空白占位', () => {
    vi.mocked(getCabinJob).mockImplementation(() => new Promise(() => {}))
    vi.mocked(listCabinJobs).mockImplementation(() => new Promise(() => {}))
    render(
      <Harness hint={{ title: 'C 端用户体系', kind: 'task', status: 'aborted' }} />,
    )
    const header = screen.getByTestId('cockpit-job-header')
    expect(header.textContent).toContain('C 端用户体系')
    expect(header.textContent).toContain('任务')
    expect(header.textContent).toContain('已中止')
    // 载入态带秒数自证：不是一动不动的「载入作业…」。
    expect(screen.getByTestId('cockpit-face-job').textContent).toMatch(/载入作业.*已 \d+s/)
  })

  it('作业列表吊死：不挡详情出图（两条请求解耦）', async () => {
    mockJob({ kind: 'workflow', ref_id: null, title: '接入渠道' })
    vi.mocked(listCabinJobs).mockImplementation(() => new Promise(() => {}))
    render(<Harness />)
    expect(await screen.findByTestId('cabin-job-overview')).toBeInTheDocument()
    expect(screen.queryByTestId('cockpit-face-job-error')).toBeNull()
    // 列表没回来时状态退回编队行摘要（没有就省略），面本身照常可用。
  })
})

describe('JobFace（window 回归形状）', () => {
  it('旧窗根 testid/页签 testid 保持不变，且不渲染 cockpit 头部', async () => {
    mockJob()
    render(
      <JobFace
        cabinId="cabin-1"
        cabinVersion={1}
        workspaceId="ws-1"
        jobId="j1"
        variant="window"
        entryCabinId="cabin-1"
        mainSessionId="sess-main"
        focusedJobId={null}
      />,
    )
    const root = await screen.findByTestId('cabin-job-detail')
    expect(root.textContent).toContain('接入渠道')
    expect(screen.getByTestId('cabin-job-tab-overview')).toBeInTheDocument()
    expect(screen.getByTestId('cabin-job-tab-accept')).toBeInTheDocument()
    expect(screen.queryByTestId('cockpit-job-header')).toBeNull()
    expect(screen.queryByTestId('cockpit-job-close')).toBeNull()
  })
})
