// S4 — JobFace（从 CabinJobDetail 抽出的五页签主体）：
//   · 不再依赖 CabinProvider（渲染时故意不包 provider）；
//   · cockpit 变体：五页签、行2 真字段派生、真实动作调用、跨舱不显示「去主对话」；
//   · window 变体：旧 DOM 形状保持不变（详细回归在 CabinModulesP3）。

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
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
import { JobFace } from '../job-face'
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
  onMutated,
}: {
  cabinId?: string
  entryCabinId?: string
  attention?: CabinAttentionItem | null
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
