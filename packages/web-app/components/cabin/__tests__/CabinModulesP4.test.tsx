import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import type { CabinView, CabinIteration } from '@octopus/shared'
import type { CabinUsagePayload } from '@/lib/cabin-api'
import type { KcFindingView } from '@/lib/knowledge/knowledge-center-api'

vi.mock('@/lib/server-config', () => ({ getServerUrl: () => 'http://localhost:3001' }))
vi.mock('@/hooks/use-cabin', () => ({ useCabin: vi.fn() }))
vi.mock('@/lib/billing-currency', () => ({ useBillingCurrency: () => ({ currency: 'CNY', rate: 7 }) }))
vi.mock('@/lib/cabin-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/cabin-api')>()
  return {
    ...actual,
    createCabinIteration: vi.fn(),
    patchCabinIteration: vi.fn(),
    deleteCabinIteration: vi.fn(),
    getCabinUsage: vi.fn(),
    getCabinFindings: vi.fn(),
    getCabinTrace: vi.fn(),
    listCabinJobs: vi.fn(),
    listCabinWorktrees: vi.fn(),
  }
})
vi.mock('@/lib/tasks-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/tasks-api')>()
  return { ...actual, listTasks: vi.fn(), getTask: vi.fn() }
})
vi.mock('@/lib/knowledge/knowledge-center-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/knowledge/knowledge-center-api')>()
  return { ...actual, searchKc: vi.fn(), getKcArticle: vi.fn() }
})
vi.mock('@/hooks/use-kc-findings', () => ({
  useKcFindings: (opts: { onSettled?: () => void } = {}) => ({
    findingStatus: {}, fixStates: {},
    adopt: vi.fn(() => opts.onSettled?.()),
    ignore: vi.fn(() => opts.onSettled?.()),
  }),
  viewToFindingCardData: (f: unknown) => f,
}))
vi.mock('@/components/knowledge-center/cards/finding-card', () => ({
  FindingCard: ({ event, ctx }: { event: { data: { id: string; title: string; status: string } }; ctx: { adoptFinding: (id: string) => void } }) => (
    <div data-testid={`finding-${event.data.id}`}>
      <span>{event.data.title}</span>
      <span data-testid={`finding-status-${event.data.id}`}>{event.data.status}</span>
      <button data-testid={`adopt-${event.data.id}`} onClick={() => ctx.adoptFinding(event.data.id)}>adopt</button>
    </div>
  ),
}))

import { useCabin } from '@/hooks/use-cabin'
import {
  createCabinIteration, patchCabinIteration, deleteCabinIteration,
  getCabinUsage, getCabinFindings, getCabinTrace, listCabinWorktrees,
} from '@/lib/cabin-api'
import { listTasks, getTask } from '@/lib/tasks-api'
import { searchKc } from '@/lib/knowledge/knowledge-center-api'
import { CabinProvider, useCabinContext } from '../cabin-provider'
import { CabinModulesLayer } from '../CabinModulesLayer'
import { CabinIterations } from '../modules/CabinIterations'
import { CabinUsage } from '../modules/CabinUsage'
import { CabinKnowledge } from '../modules/CabinKnowledge'
import { CabinQueue } from '../modules/CabinQueue'
import { CabinMissions } from '../modules/CabinMissions'
import { CabinOverview } from '../CabinOverview'

const mockUseCabin = vi.mocked(useCabin)

function makeView(overrides: Partial<CabinView> = {}): CabinView {
  return {
    cabin: {
      id: 'cabin-1', name: 'Aurora', path: '/tmp/a', workspace_id: 'ws-1', main_session_id: 'sess-1',
      requirements: '', status: 'active', mainline_strategy: 'clean-main', org: null,
      focused_job_id: null, version: 1, created_at: '', updated_at: '', last_active_at: null, archived_at: null,
    },
    attention: [],
    health: { running: 0, queued: 0, dormant: 0, workers: 0, max: 5 },
    iterations: [],
    open_findings: 0,
    ...overrides,
  }
}

function mockCabin(view: CabinView) {
  mockUseCabin.mockReturnValue({
    cabin: view.cabin as never,
    view,
    initState: null,
    loading: false,
    error: null,
    refresh: vi.fn().mockResolvedValue(undefined),
  })
}

function iter(id: string, code: string, over: Partial<CabinIteration> = {}): CabinIteration {
  return { id, cabin_id: 'cabin-1', code, name: `里程碑${code}`, sort_order: 0, status: 'pending', progress: 0, task_count: 0, ...over }
}

function makeUsage(over: Partial<CabinUsagePayload> = {}): CabinUsagePayload {
  const totals = { tokens: 400, cost: { usd: 1, complete: true }, cacheHitRate: null }
  const usage = { inputTokens: 200, outputTokens: 150, cacheReadTokens: 30, cacheCreationTokens: 20 }
  return {
    summary: { totalCalls: 4, usage, totals, modelBreakdown: {} },
    byJob: [
      { job_id: null, kind: 'chat', label: 'orchestrator 主对话', ref_id: null, totalCalls: 1, usage, totals: { tokens: 150, cost: { usd: 0.3, complete: true }, cacheHitRate: null } },
      { job_id: 'j1', kind: 'task', label: '接入渠道', ref_id: 't1', totalCalls: 2, usage, totals: { tokens: 200, cost: { usd: 0.5, complete: true }, cacheHitRate: null } },
    ],
    subagents: { count: 1, usage, tokens: 50, cost: { usd: 0.2, complete: true }, runs: [
      { id: 'r1', job_id: null, label: '调研', status: 'completed', usage, tokens: 50, cost: { usd: 0.2, complete: true } },
    ] },
    grand: { totalCalls: 4, usage, totals },
    timing: { duration_ms: 1000 },
    ...over,
  }
}

function finding(id: string, status: KcFindingView['status'] = 'open'): KcFindingView {
  return { id, kind: 'contradiction', severity: 'major', status, title: `口径矛盾${id}`, detail: {}, pages: [], rawRef: 'archives/x.md', source: 'compile', createdAt: '', updatedAt: '' }
}

function OpenProbe({ id }: { id: string }) {
  const { openModule } = useCabinContext()
  return <button data-testid="open-probe" onClick={() => openModule(id)}>open</button>
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getCabinTrace).mockResolvedValue([])
  vi.mocked(listCabinWorktrees).mockResolvedValue([])
  vi.mocked(listTasks).mockResolvedValue({ items: [] })
  vi.mocked(getCabinUsage).mockResolvedValue(makeUsage())
  vi.mocked(getCabinFindings).mockResolvedValue([])
})

describe('CabinIterations — CRUD（P4-1）', () => {
  it('新建：填代号+名称 → createCabinIteration；列表渲染里程碑线', async () => {
    mockCabin(makeView({ iterations: [iter('i1', 'M1', { status: 'active', progress: 50, task_count: 2 })] }))
    vi.mocked(createCabinIteration).mockResolvedValue(iter('i2', 'M2'))
    render(<CabinProvider cabinId="cabin-1"><CabinIterations /></CabinProvider>)
    await screen.findByTestId('cabin-iterations-body')
    expect(screen.getByTestId('cabin-iterations-body').textContent).toContain('里程碑M1')
    fireEvent.click(screen.getByTestId('iter-new'))
    fireEvent.change(screen.getByLabelText('迭代代号'), { target: { value: 'M2' } })
    fireEvent.change(screen.getByLabelText('迭代名称'), { target: { value: '对账' } })
    fireEvent.click(screen.getByTestId('iter-create-submit'))
    await waitFor(() => expect(createCabinIteration).toHaveBeenCalledWith('cabin-1', { code: 'M2', name: '对账', sort_order: 1 }))
  })

  it('计划态 select → patchCabinIteration；删除二次确认 → deleteCabinIteration', async () => {
    mockCabin(makeView({ iterations: [iter('i1', 'M1')] }))
    vi.mocked(patchCabinIteration).mockResolvedValue(iter('i1', 'M1', { status: 'active' }))
    vi.mocked(deleteCabinIteration).mockResolvedValue({ ok: true, unbound: 2 })
    render(<CabinProvider cabinId="cabin-1"><CabinIterations /></CabinProvider>)
    await screen.findByTestId('iter-status-M1')
    fireEvent.change(screen.getByTestId('iter-status-M1'), { target: { value: 'active' } })
    await waitFor(() => expect(patchCabinIteration).toHaveBeenCalledWith('cabin-1', 'i1', { status: 'active' }))
    fireEvent.click(screen.getByTestId('iter-delete-M1'))
    fireEvent.click(screen.getByTestId('iter-delete-confirm-M1'))
    await waitFor(() => expect(deleteCabinIteration).toHaveBeenCalledWith('cabin-1', 'i1'))
  })
})

describe('CabinUsage — 舱级消耗（P4-5 / C7）', () => {
  it('ledger 三列 + byJob 行 + 子代理单列 + grand 成本（防双算 note）', async () => {
    mockCabin(makeView())
    render(<CabinProvider cabinId="cabin-1"><CabinUsage /></CabinProvider>)
    await screen.findByTestId('cabin-usage-ledger')
    expect(screen.getByTestId('cabin-usage-grand-cost').textContent).toBe('¥7.00')
    const byJob = screen.getByTestId('cabin-usage-byjob')
    expect(byJob.textContent).toContain('orchestrator 主对话')
    expect(byJob.textContent).toContain('execution_id IS NULL')
    expect(byJob.textContent).toContain('接入渠道')
    expect(screen.getByTestId('cabin-usage-subagents').textContent).toContain('调研')
    expect(screen.getByTestId('cabin-usage-body').textContent).toContain('不与 llm_calls 盲加')
    expect(screen.getByTestId('usage-totals-grid')).toBeInTheDocument()
  })
})

describe('CabinKnowledge — S7 知识窗（G4 scoped findings + wiki）', () => {
  it('待裁决/已裁决分区渲染 FindingCard；采纳走全局通道', async () => {
    mockCabin(makeView({ open_findings: 1 }))
    vi.mocked(getCabinFindings).mockResolvedValue([finding('f1', 'open'), finding('f2', 'resolved')])
    render(<CabinProvider cabinId="cabin-1"><CabinKnowledge /></CabinProvider>)
    await screen.findByTestId('cabin-findings-open')
    expect(screen.getByTestId('finding-f1').textContent).toContain('口径矛盾f1')
    expect(screen.getByTestId('cabin-findings-settled').textContent).toContain('口径矛盾f2')
    expect(screen.getByTestId('finding-status-f2').textContent).toBe('resolved')
    fireEvent.click(screen.getByTestId('adopt-f1'))
    // 采纳复用全局 useKcFindings.adopt → onSettled 重拉舱 scoped 列表（二次调用）
    await waitFor(() => expect(getCabinFindings).toHaveBeenCalledTimes(2))
  })

  it('wiki tab：搜索 → searchKc，点结果内联读文章', async () => {
    mockCabin(makeView())
    vi.mocked(searchKc).mockResolvedValue({ results: [{ id: 'entity-pay', title: '支付渠道', domain: 'entities', path: 'entities/pay.md', snippet: '渠道口径' }] } as never)
    const { getKcArticle } = await import('@/lib/knowledge/knowledge-center-api')
    vi.mocked(getKcArticle).mockResolvedValue({ id: 'entity-pay', title: '支付渠道', domain: 'entities', summary: '摘要', body: '# 正文' } as never)
    render(<CabinProvider cabinId="cabin-1"><CabinKnowledge /></CabinProvider>)
    await screen.findByTestId('cabin-knowledge-tab-wiki')
    fireEvent.click(screen.getByTestId('cabin-knowledge-tab-wiki'))
    fireEvent.change(screen.getByTestId('cabin-wiki-search'), { target: { value: '支付' } })
    fireEvent.click(screen.getByText('搜索'))
    await screen.findByTestId('cabin-wiki-hits')
    expect(searchKc).toHaveBeenCalledWith('支付', 10)
    fireEvent.click(screen.getByText('支付渠道'))
    await screen.findByTestId('cabin-wiki-article')
    expect(getKcArticle).toHaveBeenCalledWith('entity-pay')
  })
})

describe('CabinQueue — blocked 态 + finding 深链路由（P4-3 / C4）', () => {
  it('blocked attention 渲染「受阻」；finding 深链 → 开知识窗而非任务', async () => {
    const view = makeView({
      attention: [
        { id: 'b1', job_id: null, stage: 'blocked', awaiting: 'person', title: '执行受阻', detail: '同一错误反复', task_id: 't1', repo: 'pay', wt: null, deep_link: null, priority: 0 },
        { id: 'f1', job_id: null, stage: 'adjudicate', awaiting: 'person', title: '口径矛盾', task_id: null, repo: null, wt: null, deep_link: 'finding:f1', priority: 0 },
      ],
    })
    mockCabin(view)
    const spy = vi.fn()
    window.addEventListener('octopus:open-task', spy)
    render(
      <CabinProvider cabinId="cabin-1">
        <CabinQueue />
        <CabinModulesLayer />
      </CabinProvider>,
    )
    await screen.findByTestId('cabin-queue-body')
    expect(screen.getByTestId('cabin-queue-body').textContent).toContain('受阻')
    fireEvent.click(screen.getByTestId('cabin-queue-route-f1'))
    expect(spy).not.toHaveBeenCalled()
    expect(await screen.findByTestId('cabin-knowledge-body')).toBeInTheDocument()
    window.removeEventListener('octopus:open-task', spy)
  })
})

describe('CabinMissions — 作战清单（P4 · 原型 taskPanel）', () => {
  it('ring 点阵 + ≤5 行 + 运行/需要你/完成汇总；折叠；点行开任务', async () => {
    const view = makeView({
      iterations: [iter('i1', 'M2', { status: 'active' })],
      attention: [{ id: 'a1', job_id: null, stage: 'review', awaiting: 'person', title: '待验收', task_id: 't2', repo: null, wt: null, deep_link: null, priority: 0 }],
    })
    mockCabin(view)
    const task = (id: string, status: string) => ({ id, name: `任务${id}`, status, repo_group: 'pay', workflow_ref: 'dev', task_spec: { goal: '', ac: [] }, version: 1, created_at: '', updated_at: '' })
    vi.mocked(listTasks).mockResolvedValue({ items: [task('t1', 'running'), task('t2', 'awaiting_review'), task('t3', 'done')] as never })
    vi.mocked(getTask).mockImplementation(async (id: string) => ({ id, executions: [] }) as never)
    const spy = vi.fn()
    window.addEventListener('octopus:open-task', spy)
    render(<CabinProvider cabinId="cabin-1"><CabinMissions /></CabinProvider>)
    await screen.findByTestId('cabin-missions-panel')
    expect(screen.getByTestId('cabin-missions-panel').textContent).toContain('MISSION · M2')
    expect(screen.getByTestId('cabin-missions-panel').textContent).toContain('1/3') // t3 done → 1/3
    expect(screen.getByTestId('cabin-missions-ring').children.length).toBe(3)
    expect(screen.getByTestId('cabin-missions-rows').querySelector('[data-mission-row="t1"]')).not.toBeNull()
    // done 任务不在作战行（只 running/awaiting_review/ready/draft）
    expect(screen.getByTestId('cabin-missions-rows').querySelector('[data-mission-row="t3"]')).toBeNull()
    fireEvent.click(screen.getByTestId('cabin-missions-rows').querySelector('[data-mission-row="t1"]')!)
    expect(spy).toHaveBeenCalledTimes(1)
    // 折叠隐藏 rows
    fireEvent.click(screen.getByTestId('cabin-missions-toggle'))
    expect(screen.queryByTestId('cabin-missions-rows')).toBeNull()
    window.removeEventListener('octopus:open-task', spy)
  })

  it('无进行中任务 → 空态 + 移出说明', async () => {
    mockCabin(makeView())
    render(<CabinProvider cabinId="cabin-1"><CabinMissions /></CabinProvider>)
    await screen.findByTestId('cabin-missions-body')
    expect(screen.getByTestId('cabin-missions-body').textContent).toContain('暂无进行中的作战任务')
    expect(screen.getByTestId('cabin-missions-body').textContent).toContain('完整看板见「任务」')
  })
})

describe('CabinOverview — 累计消耗 chip（P4-5 / C7）', () => {
  it('座舱 stat 成本 = grand 口径（CNY 派生），不再显 —', async () => {
    mockCabin(makeView())
    render(<CabinProvider cabinId="cabin-1"><CabinOverview /></CabinProvider>)
    await screen.findByTestId('cabin-stat-cost')
    await waitFor(() => expect(screen.getByTestId('cabin-stat-cost').textContent).toBe('¥7.00'))
  })
})
