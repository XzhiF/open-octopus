// 右栏「更多 → 日志」面板（v22 十五轮 · 2026-11-21 用户）：
//   · 指令时间线倒序 + 今天/昨天分组；
//   · 每条只有 prompt + TUI 摘要行（✦ 汐音 · 已完成 · 耗时 · 步数 · 工具 ·
//     思考 · token · 费用 · 时间）；
//   · 顶部一条紧凑统计 + 关键词搜索（命中高亮 / n / total / 空态）。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { AgentMessage } from '@/lib/agent/types'
import type { LLMCallData } from '@/lib/types'
import { CockpitStateProvider } from '../../state/CockpitStateProvider'
import { CockpitLayerStack } from '../../state/CockpitLayerStack'
import { CockpitLogPanel } from '../CockpitLogPanel'

const api = vi.hoisted(() => ({
  getSession: vi.fn(),
}))

const ledger = vi.hoisted(() => ({
  fetchSessionLLMCalls: vi.fn(),
}))

vi.mock('@/lib/agent/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/agent/api')>()
  return { ...actual, ...api }
})

vi.mock('@/lib/observability-api', () => ({
  fetchSessionLLMCalls: ledger.fetchSessionLLMCalls,
}))

vi.mock('@/components/cabin/cabin-provider', () => ({
  useCabinOptional: () => ({
    cabinId: 'c1',
    cabin: { name: '舱一', main_session_id: 'sess-main', cwd_git: false },
  }),
}))

vi.mock('@/lib/billing-currency', () => ({
  useBillingCurrency: () => ({ currency: 'USD', rate: 1 }),
}))

function msg(over: Partial<AgentMessage> & Pick<AgentMessage, 'id' | 'role' | 'content'>): AgentMessage {
  return {
    session_id: 'sess-main',
    created_at: '2026-11-21T09:31:00',
    is_summary: false,
    is_compressed: false,
    is_edited: false,
    ...over,
  }
}

function call(over: Partial<LLMCallData> & Pick<LLMCallData, 'id' | 'message_id' | 'timestamp'>): LLMCallData {
  return {
    node_execution_id: 'n',
    execution_id: 'e',
    turn_index: 0,
    call_index: 0,
    duration_ms: 30_000,
    input_tokens: 1000,
    output_tokens: 200,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    cost_usd: 0.02,
    ...over,
  }
}

const MESSAGES: AgentMessage[] = [
  msg({ id: 'u1', role: 'user', content: 'M1 退款链路修一下，跑完告诉我。' }),
  msg({
    id: 'a1',
    role: 'assistant',
    content: '修好了。',
    created_at: '2026-11-21T09:31:30',
    timeline: [
      { kind: 'thinking', text: '先看 replay' },
      { kind: 'tool', id: 't1' },
      { kind: 'text', text: '修好了。' },
    ],
    tool_calls: [{ id: 't1', name: 'Bash', input: {}, status: 'success' }],
  }),
  msg({ id: 'ev', role: 'user', content: '[任务提问 · 待回答]', displayType: 'event', created_at: '2026-11-21T09:32:00' }),
  msg({ id: 'u2', role: 'user', content: '限流先压测，别急着上配置。', created_at: '2026-11-21T09:35:00' }),
  msg({
    id: 'a2',
    role: 'assistant',
    content: '被截断了',
    created_at: '2026-11-21T09:36:00',
    interrupted: true,
    tool_calls: [{ id: 't2', name: 'Bash', input: {}, status: 'success' }],
  }),
]

const CALLS: LLMCallData[] = [
  call({ id: 'c1', message_id: 'a1', timestamp: Date.parse('2026-11-21T09:31:40') }),
  call({
    id: 'c2',
    message_id: 'a2',
    timestamp: Date.parse('2026-11-21T09:36:10'),
    duration_ms: 10_000,
    input_tokens: 500,
    output_tokens: 100,
    cost_usd: 0.01,
  }),
]

function ui() {
  return (
    <CockpitStateProvider entryCabinId="c1">
      <CockpitLayerStack>
        <CockpitLogPanel />
      </CockpitLayerStack>
    </CockpitStateProvider>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  api.getSession.mockResolvedValue({
    messages: { items: MESSAGES, has_more: false, next_cursor: null, total: MESSAGES.length },
  })
  ledger.fetchSessionLLMCalls.mockResolvedValue({
    data: CALLS,
    aggregates: {
      totalCalls: 2,
      usage: { inputTokens: 1500, outputTokens: 300, cacheReadTokens: 0, cacheCreationTokens: 0 },
      totals: { tokens: 1800, cost: { usd: 0.03, complete: true }, cacheHitRate: null },
      modelBreakdown: {},
    },
  })
})

describe('CockpitLogPanel', () => {
  it('倒序时间线：每条只有 prompt + TUI 摘要行；事件卡不算指令', async () => {
    const { container } = render(ui())

    const rows = await waitFor(() => {
      const list = screen.getByTestId('cockpit-log-list')
      const found = [...list.querySelectorAll<HTMLElement>('[data-testid^="cockpit-log-row-"]')]
      expect(found).toHaveLength(2)
      return found
    })

    // 最新在前：u2 → u1。
    expect(rows[0]).toHaveAttribute('data-testid', 'cockpit-log-row-u2')
    expect(rows[1]).toHaveAttribute('data-testid', 'cockpit-log-row-u1')

    // 第一条：中断轮。
    expect(rows[0]).toHaveTextContent('限流先压测')
    expect(rows[0]).toHaveTextContent('✦ 汐音')
    expect(rows[0]).toHaveTextContent('已中断')
    expect(rows[0]).toHaveTextContent('10s')
    expect(rows[0]).toHaveTextContent('1 步')
    expect(rows[0]).toHaveTextContent('工具 1')
    expect(rows[0]).toHaveTextContent('600 tok')
    expect(rows[0]).toHaveTextContent('09:35')

    // 第二条：已完成，过程计数与通讯台 TUI 同口径。
    expect(rows[1]).toHaveTextContent('已完成')
    expect(rows[1]).toHaveTextContent('30s')
    expect(rows[1]).toHaveTextContent('3 步')
    expect(rows[1]).toHaveTextContent('工具 1')
    expect(rows[1]).toHaveTextContent('思考 1')
    expect(rows[1]).toHaveTextContent('1.2K tok')
    expect(rows[1]).toHaveTextContent('$0.0200')
    expect(rows[1]).toHaveTextContent('09:31')

    // 过程明细不回放：没有 thinking / tool 正文。
    expect(container).not.toHaveTextContent('先看 replay')
    // 事件卡混在消息里，但不出行。
    expect(screen.queryByTestId('cockpit-log-row-ev')).toBeNull()
  })

  it('顶部统计：指令轮数 / 总 token / 最长耗时 / 总费用', async () => {
    render(ui())
    const stats = await screen.findByTestId('cockpit-log-stats')
    expect(stats).toHaveTextContent('指令')
    expect(stats).toHaveTextContent('2轮')
    expect(stats).toHaveTextContent('总 TOKEN')
    expect(stats).toHaveTextContent('1.8K')
    expect(stats).toHaveTextContent('最长耗时')
    expect(stats).toHaveTextContent('30s')
    expect(stats).toHaveTextContent('总费用')
    expect(stats).toHaveTextContent('$0.0300')
  })

  it('关键词搜索：命中高亮、n / total、清空恢复', async () => {
    render(ui())
    await screen.findByTestId('cockpit-log-row-u1')

    const input = screen.getByTestId('cockpit-log-search')
    fireEvent.change(input, { target: { value: '压测' } })

    expect(screen.getByTestId('cockpit-log-count')).toHaveTextContent('1 / 2')
    expect(screen.queryByTestId('cockpit-log-row-u1')).toBeNull()
    const row = screen.getByTestId('cockpit-log-row-u2')
    expect(row).toHaveTextContent('压测')
    expect(row.querySelector('mark.ck12-log-hit')?.textContent).toBe('压测')

    fireEvent.click(screen.getByLabelText('清空搜索'))
    await waitFor(() => expect(screen.getByTestId('cockpit-log-count')).toHaveTextContent('2 条'))
    expect(screen.getByTestId('cockpit-log-row-u1')).toBeInTheDocument()
  })

  it('无命中：空态说明；不是空白面板', async () => {
    render(ui())
    await screen.findByTestId('cockpit-log-row-u1')
    fireEvent.change(screen.getByTestId('cockpit-log-search'), { target: { value: 'zzz' } })
    expect(screen.getByTestId('cockpit-log-empty')).toHaveTextContent('没有匹配的指令')
    expect(screen.getByTestId('cockpit-log-count')).toHaveTextContent('0 / 2')
  })

  it('主会话还没有我发出的指令：给出空态，不铺空列表', async () => {
    api.getSession.mockResolvedValue({ messages: { items: [], has_more: false, next_cursor: null, total: 0 } })
    render(ui())
    expect(await screen.findByTestId('cockpit-log-empty')).toHaveTextContent('本会话还没有我发出的指令')
  })
})
