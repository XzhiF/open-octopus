// S4 — 作业面 chrome：三型选中（job / task / attention）解析、关闭（DOM 首焦点 +
// Esc 层栈）、attention 的 CTA 只在有真实去处时出现。
// 编队数据走真实 CockpitFleetProvider（只轮询入口舱，API 全 mock，不打真服务）。

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import type { CabinAttentionItem, CabinView } from '@octopus/shared'

vi.mock('@/lib/server-config', () => ({ getServerUrl: () => 'http://localhost:3001' }))
vi.mock('@/lib/billing-currency', () => ({
  useBillingCurrency: () => ({ currency: 'CNY', rate: 7 }),
}))
vi.mock('@/lib/cabin-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/cabin-api')>()
  return {
    ...actual,
    getCabin: vi.fn(),
    listCabinJobs: vi.fn(),
    getCabinJob: vi.fn(),
    getCabinUsage: vi.fn(),
  }
})
vi.mock('@/lib/tasks-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/tasks-api')>()
  return {
    ...actual,
    listTasks: vi.fn(),
    getTask: vi.fn(),
    pauseTask: vi.fn(),
    resumeTask: vi.fn(),
    abortTask: vi.fn(),
  }
})
vi.mock('@/lib/agent/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/agent/api')>()
  return { ...actual, listRunningSessions: vi.fn() }
})

import {
  getCabin, getCabinJob, getCabinUsage, listCabinJobs,
  type CabinDetail, type CabinJobView,
} from '@/lib/cabin-api'
import { getTask, listTasks } from '@/lib/tasks-api'
import { listRunningSessions } from '@/lib/agent/api'
import { CockpitStateProvider, useCockpitState } from '../../state/CockpitStateProvider'
import { CockpitLayerStack } from '../../state/CockpitLayerStack'
import { CockpitFleetProvider } from '../../fleet/CockpitFleetProvider'
import type { CockpitRef, CockpitSelectSource } from '../../state/cockpit-state'
import { CockpitFace } from '../CockpitFace'

function cabin(id: string, name = `舱${id}`): CabinDetail {
  return {
    id,
    name,
    path: `/tmp/${id}`,
    workspace_id: `ws-${id}`,
    main_session_id: `sess-${id}`,
    requirements: '',
    status: 'active',
    mainline_strategy: 'clean-main',
    org: null,
    version: 3,
    created_at: '2026-11-14T00:00:00.000Z',
    updated_at: '2026-11-14T00:00:00.000Z',
    last_active_at: null,
    archived_at: null,
  }
}

function makeView(c: CabinDetail, attention: CabinAttentionItem[] = []): CabinView {
  return {
    cabin: c,
    attention,
    health: { running: 0, queued: 0, dormant: 0, workers: 0, max: 4 },
    open_findings: 0,
  }
}

function jobView(cabinId: string, over: Partial<CabinJobView> = {}): CabinJobView {
  return {
    id: 'j1',
    cabin_id: cabinId,
    kind: 'workflow',
    ref_id: null,
    session_id: null,
    title: '审计工作流',
    mandate: null,
    prompt: '跑一遍审计',
    created_at: '2026-11-14T00:00:00.000Z',
    ended_at: null,
    status: 'running',
    transport: 'workflow',
    ...over,
  }
}

function attentionItem(over: Partial<CabinAttentionItem> = {}): CabinAttentionItem {
  return {
    id: 'a1',
    job_id: null,
    stage: 'review',
    awaiting: 'person',
    title: '产物已就绪',
    question: '这轮能过吗？',
    detail: '两处偏差已列在报告里',
    task_id: 't1',
    repo: 'pay',
    wt: '/wt/pay',
    deep_link: null,
    ...over,
  }
}

function mockJob(cabinId = 'cabin-1', over: Partial<CabinJobView> = {}) {
  const job = jobView(cabinId, over)
  vi.mocked(listCabinJobs).mockImplementation(async (id: string) =>
    id === cabinId ? [job] : [],
  )
  vi.mocked(getCabinJob).mockResolvedValue({
    job: {
      id: job.id,
      cabin_id: cabinId,
      kind: job.kind,
      ref_id: job.ref_id,
      session_id: job.session_id,
      title: job.title,
      mandate: null,
      prompt: job.prompt,
      created_at: job.created_at,
      ended_at: job.ended_at,
    },
    events: [],
  })
}

function SelectProbe({ target, source }: { target: CockpitRef; source?: CockpitSelectSource }) {
  const { select } = useCockpitState()
  return (
    <button data-testid="select-probe" onClick={() => select(target, undefined, source)}>
      select
    </button>
  )
}

function Harness({ target, source }: { target: CockpitRef; source?: CockpitSelectSource }) {
  return (
    <CockpitStateProvider entryCabinId="cabin-1">
      <CockpitLayerStack>
        <CockpitFleetProvider>
          <SelectProbe target={target} source={source} />
          <CockpitFace entryCabinId="cabin-1" />
        </CockpitFleetProvider>
      </CockpitLayerStack>
    </CockpitStateProvider>
  )
}

async function pick() {
  fireEvent.click(await screen.findByTestId('select-probe'))
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getCabin).mockImplementation(async (id: string) => {
    const c = id === 'cabin-1' ? cabin('cabin-1') : cabin(id)
    return { cabin: c, view: makeView(c) }
  })
  vi.mocked(listCabinJobs).mockResolvedValue([])
  vi.mocked(listTasks).mockResolvedValue({ items: [] })
  vi.mocked(listRunningSessions).mockResolvedValue({ items: [] } as never)
  vi.mocked(getCabinUsage).mockResolvedValue({
    summary: {}, byJob: [], subagents: { runs: [] }, grand: {}, timing: {},
  } as never)
  vi.mocked(getTask).mockResolvedValue({
    id: 't1', name: '接入渠道', status: 'running', task_spec: {}, executions: [],
  } as never)
})

describe('CockpitFace — job 选中', () => {
  it('渲染作业面；header 第一个可聚焦元素是关闭；关闭 = select(null) 收面', async () => {
    mockJob()
    render(<Harness target={{ kind: 'job', cabinId: 'cabin-1', id: 'j1' }} />)
    await pick()

    const face = await screen.findByTestId('cockpit-face')
    await screen.findByTestId('cockpit-job-header')
    const focusables = face.querySelectorAll(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    )
    expect(focusables[0]).toBe(screen.getByTestId('cockpit-job-close'))

    // 五个页签都在
    for (const key of ['dialog', 'relay', 'run', 'changes', 'accept']) {
      expect(screen.getByTestId(`cockpit-tab-${key}`)).toBeInTheDocument()
    }

    fireEvent.click(screen.getByTestId('cockpit-job-close'))
    await waitFor(() => expect(screen.queryByTestId('cockpit-face')).toBeNull())
  })

  it('落位：inbox 来源 → 左侧 aside；编队来源 → 居中', async () => {
    mockJob()
    const aside = render(
      <Harness target={{ kind: 'job', cabinId: 'cabin-1', id: 'j1' }} source="inbox" />,
    )
    await pick()
    await screen.findByTestId('cockpit-job-header')
    const face = screen.getByTestId('cockpit-face')
    expect(face.className).toContain('is-aside-inbox')
    // 不套会话内保存的拖拽几何（否则拖过一次就回中间）。
    expect(face.className).not.toContain('is-geo')
    expect(face.getAttribute('style')).toBeNull()
    aside.unmount()

    render(<Harness target={{ kind: 'job', cabinId: 'cabin-1', id: 'j1' }} />)
    await pick()
    const centered = await screen.findByTestId('cockpit-face')
    expect(centered.className).not.toContain('is-aside-inbox')
  })

  it('Esc 只收面（走 CockpitLayerStack）', async () => {
    mockJob()
    render(<Harness target={{ kind: 'job', cabinId: 'cabin-1', id: 'j1' }} />)
    await pick()
    await screen.findByTestId('cockpit-job-header')
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByTestId('cockpit-face')).toBeNull())
  })

  it('选中项不在编队（已删/已截断）：只给回退占位，不挂 JobFace、不发详情请求', async () => {
    mockJob()
    render(<Harness target={{ kind: 'job', cabinId: 'cabin-1', id: 'gone' }} />)
    await pick()

    expect(await screen.findByTestId('cockpit-face-stale')).toBeInTheDocument()
    expect(screen.queryByTestId('cockpit-job-header')).toBeNull()
    expect(getCabinJob).not.toHaveBeenCalled()
  })
})

describe('CockpitFace — attention 面', () => {
  it('只渲染真实字段；task_id 有真实去处 → CTA 走 octopus:open-task（review 带 acceptance）', async () => {
    vi.mocked(getCabin).mockImplementation(async (id: string) => {
      const c = cabin(id)
      return { cabin: c, view: makeView(c, [attentionItem()]) }
    })
    const spy = vi.fn()
    window.addEventListener('octopus:open-task', spy)

    render(<Harness target={{ kind: 'attention', cabinId: 'cabin-1', id: 'a1' }} />)
    await pick()

    const face = await screen.findByTestId('cockpit-face')
    await waitFor(() => expect(face.textContent).toContain('产物已就绪'))
    expect(face.textContent).toContain('待验收')
    expect(face.textContent).toContain('这轮能过吗？')
    expect(face.textContent).toContain('两处偏差已列在报告里')
    expect(face.textContent).toContain('pay · /wt/pay')

    fireEvent.click(screen.getByTestId('cockpit-attn-open-task'))
    expect(spy).toHaveBeenCalledTimes(1)
    expect((spy.mock.calls[0][0] as CustomEvent).detail).toEqual({
      taskId: 't1',
      view: 'acceptance',
    })
    window.removeEventListener('octopus:open-task', spy)
  })

  it('finding 类（无 task_id）只展示事实，不放按钮', async () => {
    vi.mocked(getCabin).mockImplementation(async (id: string) => {
      const c = cabin(id)
      return {
        cabin: c,
        view: makeView(c, [
          attentionItem({ stage: 'blocked', awaiting: 'person', task_id: null, title: 'finding: 权限漂移' }),
        ]),
      }
    })
    const spy = vi.fn()
    window.addEventListener('octopus:open-task', spy)

    render(<Harness target={{ kind: 'attention', cabinId: 'cabin-1', id: 'a1' }} />)
    await pick()

    const face = await screen.findByTestId('cockpit-face')
    await waitFor(() => expect(face.textContent).toContain('finding: 权限漂移'))
    expect(screen.queryByTestId('cockpit-attn-open-task')).toBeNull()
    // 右上只有关闭 + ⛶（v21 五轮：dossier 头不再放动作按钮）。
    expect(face.querySelectorAll('button').length).toBe(2)
    window.removeEventListener('octopus:open-task', spy)
  })

  it('attention 挂在 job 上（job_id 命中）时落到该 job 的完整五页签面', async () => {
    const item = attentionItem({ job_id: 'j1', stage: 'answer', awaiting: 'person', task_id: null })
    vi.mocked(getCabin).mockImplementation(async (id: string) => {
      const c = cabin(id)
      return { cabin: c, view: makeView(c, [item]) }
    })
    mockJob()

    render(<Harness target={{ kind: 'attention', cabinId: 'cabin-1', id: 'a1' }} />)
    await pick()

    await screen.findByTestId('cockpit-job-header')
    expect(screen.getByTestId('cockpit-face-job')).toBeInTheDocument()
    // v21 五轮：头部不再有「去处理 →」捷径（用户：右上按钮多余）；
    // 待办入口在右栏「要我处理」，详情里按页签自己切。
    expect(screen.queryByTestId('cockpit-job-go')).toBeNull()
    expect(screen.getByTestId('cockpit-tab-dialog')).toHaveAttribute('aria-selected', 'true')
  })
})

describe('CockpitFace — task 选中（历史舱合成行）', () => {
  it('渲染任务面：五页签 + 真实字段，没有 job 账本给明确空态', async () => {
    vi.mocked(listTasks).mockResolvedValue({
      items: [
        {
          id: 't1',
          name: '接入渠道',
          status: 'running',
          repo_group: 'pay',
          workflow_ref: 'dev',
          task_spec: { goal: '接入渠道', ac: ['能收单'] },
          version: 1,
          created_at: '2026-11-14T00:00:00.000Z',
          updated_at: '2026-11-14T00:00:00.000Z',
        },
      ],
    } as never)
    vi.mocked(getTask).mockResolvedValue({
      id: 't1',
      name: '接入渠道',
      status: 'running',
      repo_group: 'pay',
      workflow_ref: 'dev',
      task_spec: { goal: '接入渠道', ac: ['能收单'] },
      executions: [],
      version: 1,
      created_at: '2026-11-14T00:00:00.000Z',
      updated_at: '2026-11-14T00:00:00.000Z',
    } as never)

    render(<Harness target={{ kind: 'task', cabinId: 'cabin-1', id: 't1' }} />)
    await pick()

    const header = await screen.findByTestId('cockpit-job-header')
    await waitFor(() => expect(header.textContent).toContain('接入渠道'))
    expect(header.textContent).toContain('接入渠道')
    for (const key of ['dialog', 'relay', 'run', 'changes', 'accept']) {
      expect(screen.getByTestId(`cockpit-tab-${key}`)).toBeInTheDocument()
    }
    // v21 七轮：首签「对话」= 任务 chat 记录；没有 source_chat_session_id
    // 给明确空态，不拿别的东西冒充对话。
    const dialog = await screen.findByTestId('cockpit-dialog')
    expect(dialog.textContent).toContain('任务对话')
    expect(dialog.textContent).toContain('没有关联的对话会话')

    fireEvent.click(screen.getByTestId('cockpit-tab-relay'))
    expect((await screen.findByTestId('cockpit-face-task-relay')).textContent)
      .toContain('没有作业账本')
  })
})
