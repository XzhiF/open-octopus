// 2026-10-31 消耗窗「总耗时」：卡片本身 + 窗口接线（明细时长列 / 合计行 ⏱）。
// 口径见 UsageTimingCard 顶部注释：总耗时 = 实跑段之和，智能体 = agent 工时。
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { LlmUsageSummary } from '@octopus/shared'
import type { TaskUsagePart, TaskUsagePayload } from '@/lib/tasks-api'

vi.mock('@/lib/billing-currency', () => ({
  useBillingCurrency: () => ({ currency: 'USD', rate: 1 }),
}))

const { getUsageMock } = vi.hoisted(() => ({ getUsageMock: vi.fn() }))
vi.mock('@/lib/tasks-api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/tasks-api')>('@/lib/tasks-api')
  return { ...actual, getTaskUsage: getUsageMock }
})

import { UsageTimingCard } from '../usage-timing-card'
import { UsageWindow } from '../usage-window'

const MIN = 60_000

function usage(inputTokens: number, usd: number): LlmUsageSummary {
  const u = { inputTokens, outputTokens: 10, cacheReadTokens: 0, cacheCreationTokens: 0 }
  const tokens = inputTokens + 10
  return {
    totalCalls: 2,
    usage: u,
    totals: { tokens, cost: { usd, complete: true }, cacheHitRate: 0 },
  }
}

function part(over: Partial<TaskUsagePart> & Pick<TaskUsagePart, 'label'>): TaskUsagePart {
  return {
    kind: 'execution',
    execution_id: over.label,
    phase_index: 1,
    round_index: 1,
    ...usage(1000, 0.1),
    duration_ms: 30 * MIN,
    ...over,
  } as TaskUsagePart
}

describe('耗时卡', () => {
  it('总耗时 / 智能体 / 编排等待 + 按轮条', () => {
    render(
      <UsageTimingCard
        timing={{ count: 2, duration_ms: 90 * MIN, agent_duration_ms: 60 * MIN }}
        rounds={[
          part({ label: 'P1 · R1', duration_ms: 60 * MIN }),
          part({ label: 'P1 · R2', round_index: 2, duration_ms: 30 * MIN }),
        ]}
      />,
    )
    expect(screen.getByTestId('usage-timing-total').textContent).toBe('1h 30m')
    expect(screen.getByTestId('usage-timing-agent-pct').textContent).toContain('67%')
    expect(screen.getAllByText(/编排 \/ 等待/).length).toBeGreaterThan(0)
    expect(screen.getByTestId('usage-timing-rounds').children).toHaveLength(2)
    expect(screen.getByText(/最长 P1 · R1/)).toBeTruthy()
  })

  it('并行叠加（工时 > 墙钟）时报倍数，不硬凑「编排/等待」', () => {
    render(
      <UsageTimingCard
        timing={{ count: 1, duration_ms: 60 * MIN, agent_duration_ms: 90 * MIN }}
        rounds={[part({ label: 'P1 · R1', duration_ms: 60 * MIN })]}
      />,
    )
    expect(screen.getByTestId('usage-timing-agent-pct').textContent).toContain('×1.5')
    expect(screen.queryByText(/编排 \/ 等待/)).toBeNull()
  })

  it('一轮都没跑（duration=0）时整卡不渲染', () => {
    const { container } = render(
      <UsageTimingCard timing={{ count: 0, duration_ms: 0, agent_duration_ms: 0 }} rounds={[]} />,
    )
    expect(container.firstChild).toBeNull()
  })
})

describe('消耗窗接线', () => {
  it('耗时卡在标题下、明细行带时长、合计行带 ⏱、主对话显 —', async () => {
    const payload: TaskUsagePayload = {
      task_id: 't1',
      summary: { ...usage(2000, 0.2), modelBreakdown: {} },
      breakdown: [
        { kind: 'chat', label: '主对话', session_id: 's1', ...usage(128_400, 0.6) },
        part({ label: 'P1 · R1', duration_ms: 62 * MIN, agent_duration_ms: 48 * MIN }),
      ],
      timing: { count: 1, duration_ms: 62 * MIN, agent_duration_ms: 48 * MIN },
    }
    getUsageMock.mockResolvedValue(payload)

    render(<UsageWindow taskId="t1" />)

    expect(await screen.findByTestId('usage-timing')).toBeTruthy()
    const cells = screen.getAllByTestId('usage-part-duration').map((node) => node.textContent)
    expect(cells).toEqual(['—', '1h 2m']) // 主对话没有起止事实；轮次在明细行
    expect(screen.getByText(/⏱ 1h 2m/)).toBeTruthy() // 合计行
  })
})
