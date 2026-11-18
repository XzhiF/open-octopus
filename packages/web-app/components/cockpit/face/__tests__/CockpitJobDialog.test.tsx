// v21 七轮 · 详情「对话」页签：任务 chat 记录 = 任务主会话的消息，
// 用通讯台同一套 TUI 转录（TuiMessage）渲染；没有主会话给明确空态。

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'

vi.mock('@/lib/server-config', () => ({ getServerUrl: () => 'http://localhost:3001' }))
vi.mock('@/lib/billing-currency', () => ({
  useBillingCurrency: () => ({ currency: 'CNY', rate: 7 }),
}))
vi.mock('@/hooks/useSessionLedger', () => ({ useSessionLedger: vi.fn() }))
vi.mock('@/lib/agent/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/agent/api')>()
  return { ...actual, getSession: vi.fn() }
})

import { getSession } from '@/lib/agent/api'
import { useSessionLedger } from '@/hooks/useSessionLedger'
import type { LLMCallData } from '@/lib/types'
import type { AgentMessage } from '@/lib/agent/types'
import { CockpitJobDialog } from '../CockpitJobDialog'

function message(over: Partial<AgentMessage> & { id: string; role: AgentMessage['role'] }): AgentMessage {
  return {
    session_id: 'sess-1',
    content: '',
    created_at: '2026-11-18T01:00:00.000Z',
    is_summary: false,
    is_compressed: false,
    is_edited: false,
    ...over,
  }
}

function sessionWith(items: AgentMessage[]) {
  return {
    id: 'sess-1',
    messages: { items, has_more: false, next_cursor: null, total: items.length },
  } as never
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(useSessionLedger).mockReturnValue({ aggregates: null, calls: [] })
})

function ledgerCall(over: Partial<LLMCallData> = {}): LLMCallData {
  return {
    id: 'c1',
    node_execution_id: '',
    execution_id: '',
    turn_index: 1,
    call_index: 0,
    duration_ms: 30_000,
    timestamp: Date.parse('2026-11-18T01:00:20.000Z'),
    model: 'claude-opus-5',
    input_tokens: 1000,
    output_tokens: 200,
    cache_read_tokens: 800,
    cache_creation_tokens: 100,
    cost_usd: 0.02,
    ...over,
  }
}

describe('CockpitJobDialog · 对话页签', () => {
  it('拉任务主会话，按 TUI 转录渲染（❯ 你 / ✳ 汐音），头部给条数与轮数', async () => {
    vi.mocked(getSession).mockResolvedValue(sessionWith([
      message({ id: 'm1', role: 'user', content: 'M2 的验收跑完叫我。' }),
      message({ id: 'm2', role: 'assistant', content: '收到，我盯到收口。' }),
      message({ id: 'm3', role: 'user', content: '好。' }),
    ]))

    render(<CockpitJobDialog sessionId="sess-1" />)

    await waitFor(() => expect(getSession).toHaveBeenCalledWith('sess-1', { limit: 200 }))
    expect(await screen.findByText('M2 的验收跑完叫我。')).toBeInTheDocument()
    expect(screen.getByText('收到，我盯到收口。')).toBeInTheDocument()

    const head = screen.getByTestId('cockpit-dialog').querySelector('.ck12-dcon-h')
    expect(head?.textContent).toContain('任务对话')
    // 3 条 · 2 轮提问（助理行不算提问）· 只读记录
    expect(head?.textContent).toContain('3 条')
    expect(head?.textContent).toContain('2 轮提问')
    expect(head?.textContent).toContain('只读记录')

    const log = screen.getByTestId('cockpit-dialog-log')
    expect(log.querySelector('[data-tui-msg="user"]')).not.toBeNull()
    expect(log.querySelector('[data-tui-msg="assistant"]')).not.toBeNull()
  })

  it('逐轮 meta 挂上 token 与费用（与通讯台同一账本口径）', async () => {
    vi.mocked(useSessionLedger).mockReturnValue({ aggregates: null, calls: [ledgerCall()] })
    vi.mocked(getSession).mockResolvedValue(sessionWith([
      message({ id: 'm1', role: 'user', content: 'M2 的验收跑完叫我。' }),
      message({
        id: 'm2',
        role: 'assistant',
        content: '收到，我盯到收口。',
        created_at: '2026-11-18T01:00:05.000Z',
        thinking: 'plan',
        timeline: [{ kind: 'thinking', text: 'plan' }],
        tool_calls: [],
      }),
    ]))

    render(<CockpitJobDialog sessionId="sess-1" />)

    const log = await screen.findByTestId('cockpit-dialog-log')
    await waitFor(() => expect(log.textContent).toContain('2.1K tok'))
    // 0.02 USD × 7（计费币种 CNY）
    expect(log.textContent).toContain('¥0.14')
    expect(log.querySelector('[data-tui-meta="closed"]')).not.toBeNull()
  })

  it('委托线程（user 行全是事件卡）也照常显示 tok/费用', async () => {
    vi.mocked(useSessionLedger).mockReturnValue({ aggregates: null, calls: [ledgerCall()] })
    vi.mocked(getSession).mockResolvedValue(sessionWith([
      message({
        id: 'm1',
        role: 'user',
        displayType: 'event',
        content: '[汐音 · 代用户转达] 任务「支付回调」',
      }),
      message({
        id: 'm2',
        role: 'assistant',
        content: '收到，先读舱需求。',
        created_at: '2026-11-18T01:00:05.000Z',
        thinking: 'plan',
        timeline: [{ kind: 'thinking', text: 'plan' }],
        tool_calls: [],
      }),
    ]))

    render(<CockpitJobDialog sessionId="sess-1" />)

    const log = await screen.findByTestId('cockpit-dialog-log')
    await waitFor(() => expect(log.textContent).toContain('2.1K tok'))
    expect(log.textContent).toContain('¥0.14')
  })

  it('事件卡不是提问：轮数只数人说的话', async () => {
    vi.mocked(getSession).mockResolvedValue(sessionWith([
      message({ id: 'm1', role: 'user', content: '开始吧' }),
      message({ id: 'm2', role: 'user', content: '任务开跑', displayType: 'event' }),
    ]))

    render(<CockpitJobDialog sessionId="sess-1" />)

    const head = (await screen.findByTestId('cockpit-dialog')).querySelector('.ck12-dcon-h')
    expect(head?.textContent).toContain('2 条')
    expect(head?.textContent).toContain('1 轮提问')
  })

  // 2026-11-19 用户：全舱「作战详情 → 对话」里没渲染出 AskUserQuestion。
  function askCall(id = 'call-ask') {
    return {
      id,
      name: 'AskUserQuestion',
      status: 'start',
      input: {
        questions: [{
          header: '任务范围',
          multiSelect: false,
          question: '本任务只交付规格冻结，还是把后续实现也纳入？',
          options: [
            { label: '单 phase：只冻结规格', description: '不写业务代码' },
            { label: '多 phase：规格 + 实现', description: '验收周期变长' },
          ],
        }],
      },
    }
  }

  it('未答的 AskUserQuestion 渲染成可勾选的卡片（不再只是正文）', async () => {
    vi.mocked(getSession).mockResolvedValue(sessionWith([
      message({ id: 'm1', role: 'user', content: '开始吧' }),
      message({
        id: 'm2',
        role: 'assistant',
        content: '等待你的选择。',
        created_at: '2026-11-18T01:00:05.000Z',
        tool_calls: [askCall()],
      }),
    ]))

    render(<CockpitJobDialog sessionId="sess-1" cabinId="c1" taskId="t1" />)

    const log = await screen.findByTestId('cockpit-dialog-log')
    await waitFor(() => expect(log.querySelector('[data-tui-ask="open"]')).not.toBeNull())
    expect(log.textContent).toContain('本任务只交付规格冻结，还是把后续实现也纳入？')
    expect(log.textContent).toContain('单 phase：只冻结规格')
  })

  it('后面已经有人回话 → 提问卡收成一行「✓ 已回答」', async () => {
    vi.mocked(getSession).mockResolvedValue(sessionWith([
      message({
        id: 'm2',
        role: 'assistant',
        content: '等待你的选择。',
        created_at: '2026-11-18T01:00:05.000Z',
        tool_calls: [askCall()],
      }),
      message({
        id: 'm3',
        role: 'user',
        content: '用户回答了以下问题：\n\n1. [任务范围] …\n   → 单 phase：只冻结规格',
        created_at: '2026-11-18T01:00:10.000Z',
      }),
    ]))

    render(<CockpitJobDialog sessionId="sess-1" cabinId="c1" taskId="t1" />)

    const log = await screen.findByTestId('cockpit-dialog-log')
    await waitFor(() => expect(log.querySelector('[data-tui-ask="answered"]')).not.toBeNull())
    expect(log.querySelector('[data-tui-ask="open"]')).toBeNull()
    expect(log.textContent).toContain('已回答')
  })

  it('没有舱上下文（旧宿主）不铺提问卡，转录保持只读', async () => {
    vi.mocked(getSession).mockResolvedValue(sessionWith([
      message({
        id: 'm2',
        role: 'assistant',
        content: '等待你的选择。',
        created_at: '2026-11-18T01:00:05.000Z',
        tool_calls: [askCall()],
      }),
    ]))

    render(<CockpitJobDialog sessionId="sess-1" />)

    const log = await screen.findByTestId('cockpit-dialog-log')
    await waitFor(() => expect(log.textContent).toContain('等待你的选择。'))
    expect(log.querySelector('[data-tui-ask]')).toBeNull()
  })

  it('没有主会话（workflow / subagent 作业）：明确空态，不发请求', async () => {
    render(<CockpitJobDialog sessionId={null} />)
    expect(screen.getByTestId('cockpit-dialog').textContent).toContain('没有关联的对话会话')
    expect(getSession).not.toHaveBeenCalled()
  })

  it('接口失败：给一行原因，不静默空着', async () => {
    vi.mocked(getSession).mockRejectedValue(new Error('boom'))
    render(<CockpitJobDialog sessionId="sess-1" />)
    expect(await screen.findByText('对话记录载入失败')).toBeInTheDocument()
  })
})
