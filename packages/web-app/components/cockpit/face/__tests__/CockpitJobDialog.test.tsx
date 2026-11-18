// v21 七轮 · 详情「对话」页签：任务 chat 记录 = 任务主会话的消息，
// 用通讯台同一套 TUI 转录（TuiMessage）渲染；没有主会话给明确空态。

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'

vi.mock('@/lib/server-config', () => ({ getServerUrl: () => 'http://localhost:3001' }))
vi.mock('@/lib/agent/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/agent/api')>()
  return { ...actual, getSession: vi.fn() }
})

import { getSession } from '@/lib/agent/api'
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
})

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
