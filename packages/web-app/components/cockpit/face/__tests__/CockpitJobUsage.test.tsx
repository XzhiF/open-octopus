// 详情 · 消耗 / 子代理（2026-11-25 用户）：任务账本按轮 + 子代理单列防双算；
// 子代理页签按会话归属分组（运行中置顶）。数据接口全 mock。

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import type { TaskUsagePayload } from '@/lib/tasks-api'
import type { SubagentRunSummary } from '@/lib/agent/api'

vi.mock('@/lib/server-config', () => ({ getServerUrl: () => 'http://localhost:3001' }))
vi.mock('@/lib/billing-currency', () => ({
  useBillingCurrency: () => ({ currency: 'CNY', rate: 7 }),
}))
vi.mock('@/lib/tasks-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/tasks-api')>()
  return { ...actual, getTaskUsage: vi.fn(), getSessionUsage: vi.fn() }
})
vi.mock('@/lib/agent/debug-api', () => ({
  listSessionDebugTurns: vi.fn(async () => ({ session_id: 's-1', total: 0, turns: [] })),
  getSessionDebugTurn: vi.fn(),
}))
vi.mock('@/lib/agent/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/agent/api')>()
  return {
    ...actual,
    listSessionSubagents: vi.fn(async () => ({ runs: [] })),
    getSessionRunning: vi.fn(async () => ({ background_tasks: [] })),
    listSessionBackgroundRuns: vi.fn(async () => ({ runs: [] })),
    getSessionSubagent: vi.fn(),
  }
})

import { getTaskUsage } from '@/lib/tasks-api'
import {
  getSessionRunning,
  listSessionBackgroundRuns,
  listSessionSubagents,
} from '@/lib/agent/api'
import { CockpitJobUsage } from '../CockpitJobUsage'
import { CockpitJobAgents } from '../CockpitJobAgents'

const usage = (over: Partial<TaskUsagePayload> = {}): TaskUsagePayload => ({
  task_id: 't1',
  summary: {
    totalCalls: 12,
    usage: { inputTokens: 1000, outputTokens: 2000, cacheReadTokens: 3000, cacheCreationTokens: 500 },
    totals: { tokens: 6500, cost: { usd: 0.42, complete: true }, cacheHitRate: 0.75 },
    modelBreakdown: {
      'qwen3.7-plus': { calls: 12, inputTokens: 1000, outputTokens: 2000, cacheReadTokens: 3000, cacheCreationTokens: 500, costUsd: 0.42 },
    },
  },
  breakdown: [
    {
      kind: 'chat',
      label: '主对话',
      totalCalls: 2,
      usage: { inputTokens: 100, outputTokens: 200, cacheReadTokens: 0, cacheCreationTokens: 0 },
      totals: { tokens: 300, cost: { usd: 0.01, complete: true }, cacheHitRate: null },
    },
    {
      kind: 'execution',
      label: 'R1 · 接入渠道',
      phase_index: 0,
      round_index: 1,
      duration_ms: 60_000,
      totalCalls: 10,
      usage: { inputTokens: 900, outputTokens: 1800, cacheReadTokens: 3000, cacheCreationTokens: 500 },
      totals: { tokens: 6200, cost: { usd: 0.41, complete: true }, cacheHitRate: 0.75 },
    },
  ],
  timing: { count: 1, duration_ms: 60_000, agent_duration_ms: 60_000 },
  ...over,
})

function run(over: Partial<SubagentRunSummary> = {}): SubagentRunSummary {
  return {
    id: 'sa-1',
    session_id: 's-1',
    parent_tool_use_id: null,
    agent_type: 'Explore',
    description: '返回字段语义比对',
    prompt: null,
    status: 'completed',
    started_at: '2026-11-25T09:40:00.000Z',
    ended_at: '2026-11-25T09:42:00.000Z',
    summary: null,
    model: 'qwen3.7-plus',
    input_tokens: 1000,
    output_tokens: 500,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    tool_uses: 3,
    duration_ms: 120_000,
    step_count: 4,
    cost_usd: 0.02,
    cost_complete: 1,
    ...over,
  }
}

beforeEach(() => {
  vi.mocked(getTaskUsage).mockResolvedValue(usage())
  vi.mocked(listSessionSubagents).mockResolvedValue({ runs: [] })
  vi.mocked(getSessionRunning).mockClear()
  vi.mocked(listSessionBackgroundRuns).mockClear()
})

describe('CockpitJobUsage — 任务账本', () => {
  it('按轮列任务周期（主对话 + 执行轮），按模型，子代理单列并注明防双算', async () => {
    vi.mocked(listSessionSubagents).mockResolvedValue({ runs: [run()] })
    render(<CockpitJobUsage taskId="t1" sessionId="s-1" what="任务" />)

    await screen.findByTestId('cockpit-job-usage')
    expect(screen.getAllByText('6.5K').length).toBeGreaterThan(0)
    // 按轮：主对话 + 执行轮（标签与副文都会出现「主对话」，取存在即可）
    expect(screen.getAllByText('主对话').length).toBeGreaterThan(0)
    expect(screen.getByText('R1 · 接入渠道')).toBeInTheDocument()
    // 按模型
    expect(screen.getByText('qwen3.7-plus')).toBeInTheDocument()
    // 子代理单列：标题 + 行 + 防双算脚注
    expect(screen.getByText(/子代理 · 单列/)).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText('返回字段语义比对 · Explore · 已完成')).toBeInTheDocument())
    expect(screen.getByText(/防双算/)).toBeInTheDocument()
  })

  it('没有任务也没有会话 → 明确空态（不猜账本）', () => {
    render(<CockpitJobUsage taskId={null} sessionId={null} what="作业" />)
    expect(screen.getByTestId('cockpit-job-usage-empty')).toBeInTheDocument()
  })
})

describe('CockpitJobAgents — 按会话归属的子代理', () => {
  it('运行中置顶 + 已结束留档，计数进汇总条', async () => {
    vi.mocked(listSessionSubagents).mockResolvedValue({
      runs: [run({ id: 'sa-done', description: '已完成比对', status: 'completed' })],
    })
    render(<CockpitJobAgents sessionId="s-1" what="任务" />)

    await screen.findByTestId('cockpit-job-agents')
    // 汇总条 / 分组标题都会出现「运行中」「已结束」读数。
    expect(screen.getAllByText('运行中').length).toBeGreaterThan(0)
    expect(screen.getAllByText('已结束').length).toBeGreaterThan(0)
    expect(screen.getByText('已完成比对')).toBeInTheDocument()
    expect(screen.getByText('子代理')).toBeInTheDocument()
  })

  it('只列子代理：只有后台作业时是空态，不拉后台接口', async () => {
    // 后台作业（run_in_background 的 Bash）不进「子代理」页签 —— 2026-11-25 用户。
    vi.mocked(getSessionRunning).mockResolvedValue({
      running: true,
      partial: false,
      background_tasks: [{ id: 'bg-1', description: 'sleep 60 等构建', taskType: 'bash' }],
    })
    vi.mocked(listSessionBackgroundRuns).mockResolvedValue({
      runs: [{
        id: 'r1', session_id: 's-1', task_id: 'bg-1', run_id: null,
        description: 'sleep 60 等构建', task_type: 'bash', status: 'running',
        summary: null, output_file: null,
        started_at: '2026-11-25T09:40:00.000Z', ended_at: null,
        created_at: '2026-11-25T09:40:00.000Z', updated_at: '2026-11-25T09:40:00.000Z',
      }],
    })
    render(<CockpitJobAgents sessionId="s-1" what="任务" />)

    expect(await screen.findByTestId('cockpit-job-agents-empty')).toBeInTheDocument()
    expect(screen.queryByText('sleep 60 等构建')).not.toBeInTheDocument()
    expect(screen.queryByText(/后台/)).not.toBeInTheDocument()
    expect(getSessionRunning).not.toHaveBeenCalled()
    expect(listSessionBackgroundRuns).not.toHaveBeenCalled()
  })

  it('没有会话 → 空态；会话没有子代理 → 引导派一个', async () => {
    const noSession = render(<CockpitJobAgents sessionId={null} what="任务" />)
    expect(noSession.container.textContent).toContain('还没有会话')
    noSession.unmount()

    render(<CockpitJobAgents sessionId="s-1" what="任务" />)
    expect(await screen.findByTestId('cockpit-job-agents-empty')).toBeInTheDocument()
  })
})
