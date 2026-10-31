// 2026-10-31 消耗窗通用化：会话账本窗（用量卡 / 对话+工作流耗时 / 工作流列表 / 口径 ⓘ）。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import type { SessionUsagePayload } from '@/lib/tasks-api'

vi.mock('@/lib/billing-currency', () => ({
  useBillingCurrency: () => ({ currency: 'CNY', rate: 7 }),
}))

const { getSessionUsageMock } = vi.hoisted(() => ({ getSessionUsageMock: vi.fn() }))
vi.mock('@/lib/tasks-api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/tasks-api')>('@/lib/tasks-api')
  return { ...actual, getSessionUsage: getSessionUsageMock }
})

import { SessionUsageWindow } from '../session-usage-window'

const MIN = 60_000

const payload: SessionUsagePayload = {
  session_id: 's1',
  summary: {
    totalCalls: 109,
    usage: {
      inputTokens: 1_064_051,
      outputTokens: 139_054,
      cacheReadTokens: 15_002_752,
      cacheCreationTokens: 0,
    },
    totals: { tokens: 16_205_857, cost: { usd: 0.525, complete: true }, cacheHitRate: 0.934 },
    modelBreakdown: {},
  },
  timing: {
    conversation_ms: 481_274,
    workflow_ms: 973_985,
    duration_ms: 1_455_259,
    agent_duration_ms: 1_548_946,
  },
  workflows: [
    {
      task_id: 't1',
      name: '数据脱敏工具类开发',
      status: 'done',
      duration_ms: 973_985,
      tokens: 7_211_349,
      total_calls: 89,
      cost: { usd: 0.2401, complete: true },
    },
  ],
}

beforeEach(() => {
  getSessionUsageMock.mockReset()
})

describe('SessionUsageWindow', () => {
  it('用量卡读数 + 耗时卡（对话 + 工作流）+ 工作流列表 + 口径 ⓘ', async () => {
    getSessionUsageMock.mockResolvedValue(payload)
    render(<SessionUsageWindow sessionId="s1" />)

    expect(await screen.findByTestId('session-usage-card')).toBeTruthy()
    expect(screen.getByTestId('session-usage-tokens').textContent).toBe('16.2M')
    expect(screen.getByText(/109 次请求 · cache 93.4%/)).toBeTruthy()

    expect(screen.getByTestId('session-usage-total').textContent).toBe('24m 15s')
    expect(screen.getByTestId('session-usage-agent-ratio').textContent).toBe('×1.1')
    const timingText = screen.getByTestId('session-usage-timing').textContent ?? ''
    expect(timingText).toContain('工作流 1 个')
    expect(timingText).toContain('对话 8m 1s')

    expect(screen.getByTestId('session-usage-workflows')).toBeTruthy()
    expect(screen.getAllByText('数据脱敏工具类开发').length).toBeGreaterThan(0)
    expect(screen.getByText('已完成')).toBeTruthy()
    expect(screen.getAllByText('16m 14s').length).toBeGreaterThan(0)
    expect(screen.getByTestId('session-usage-caliber')).toBeTruthy()
  })

  it('点工作流行 → 打开对应任务', async () => {
    getSessionUsageMock.mockResolvedValue(payload)
    const onOpenTask = vi.fn()
    render(<SessionUsageWindow sessionId="s1" onOpenTask={onOpenTask} />)

    fireEvent.click(await screen.findByTestId('session-usage-workflow'))
    expect(onOpenTask).toHaveBeenCalledWith('t1')
  })

  it('多重工作流各有色条与图例', async () => {
    getSessionUsageMock.mockResolvedValue({
      ...payload,
      workflows: [
        payload.workflows[0],
        {
          task_id: 't2',
          name: 'ES 风格短语匹配查询',
          status: 'running',
          duration_ms: 372_000,
          tokens: 100,
          total_calls: 3,
          cost: { usd: 0.1, complete: true },
        },
      ],
      timing: { ...payload.timing, workflow_ms: 973_985 + 372_000, duration_ms: 481_274 + 973_985 + 372_000 },
    } as SessionUsagePayload)
    render(<SessionUsageWindow sessionId="s1" />)

    expect(await screen.findByTestId('session-usage-bar')).toBeTruthy()
    expect(screen.getAllByTestId('session-usage-workflow')).toHaveLength(2)
    expect(screen.getByText('运行中')).toBeTruthy()
  })

  it('空会话 → 一句空态，不铺假 0', async () => {
    getSessionUsageMock.mockResolvedValue({
      session_id: 's2',
      summary: {
        totalCalls: 0,
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
        totals: { tokens: 0, cost: { usd: null, complete: true }, cacheHitRate: null },
        modelBreakdown: {},
      },
      timing: { conversation_ms: 0, workflow_ms: 0, duration_ms: 0, agent_duration_ms: 0 },
      workflows: [],
    })
    render(<SessionUsageWindow sessionId="s2" />)
    expect(await screen.findByText('本会话还没有产生用量。')).toBeTruthy()
    expect(screen.queryByTestId('session-usage-card')).toBeNull()
  })
})
