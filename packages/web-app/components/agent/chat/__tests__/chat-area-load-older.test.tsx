// 2026-11-20 用户 #11：长会话转录分页。ChatArea 侧锁三条：
//   1. has_more 时转录顶部出现「加载更早的消息」；
//   2. 滚到顶自动请求一次（同一波不重复发）；
//   3. 加载中显示「加载更早的消息…」；没有更早时不渲染提示。
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ChatArea } from '../ChatArea'
import type { AgentMessage } from '@/lib/agent/types'

const baseProps = {
  streaming: false,
  streamContent: '',
  streamThinking: '',
  isThinking: false,
  toolCalls: [],
  pendingConfirm: null,
  error: null,
  statusMessage: '',
  onSend: vi.fn(),
  onStop: vi.fn(),
  onConfirm: vi.fn(),
  hasSession: true,
  currentModel: 'pro',
  onModelChange: vi.fn(),
  tui: true,
}

function message(id: string, role: 'user' | 'assistant', content: string): AgentMessage {
  return {
    id,
    session_id: 's-1',
    role,
    content,
    created_at: '2026-11-20T00:00:00.000Z',
    is_summary: false,
    is_compressed: false,
    is_edited: false,
  }
}

const messages = [
  message('m1', 'user', '第一轮提问'),
  message('m2', 'assistant', '第一轮回答'),
]

function scroller() {
  return screen.getByTestId('chat-transcript-scroll') as HTMLDivElement
}

describe('ChatArea — 上翻加载更早的消息', () => {
  it('has_more 时顶部出现加载提示', () => {
    render(<ChatArea {...baseProps} messages={messages} hasMoreMessages onLoadOlder={vi.fn()} />)
    expect(screen.getByTestId('chat-load-older').textContent).toContain('加载更早的消息')
  })

  it('滚到顶触发一次，同一波不重复请求', () => {
    const onLoadOlder = vi.fn()
    render(<ChatArea {...baseProps} messages={messages} hasMoreMessages onLoadOlder={onLoadOlder} />)
    const el = scroller()
    Object.defineProperty(el, 'scrollHeight', { configurable: true, value: 1200 })
    Object.defineProperty(el, 'clientHeight', { configurable: true, value: 400 })

    el.scrollTop = 0
    fireEvent.scroll(el)
    expect(onLoadOlder).toHaveBeenCalledTimes(1)

    fireEvent.scroll(el)
    expect(onLoadOlder).toHaveBeenCalledTimes(1)
  })

  it('加载中显示等待文案', () => {
    render(
      <ChatArea
        {...baseProps}
        messages={messages}
        hasMoreMessages
        loadingOlderMessages
        onLoadOlder={vi.fn()}
      />,
    )
    expect(screen.getByTestId('chat-load-older').textContent).toContain('加载更早的消息…')
  })

  it('没有更早的消息时不渲染提示', () => {
    render(<ChatArea {...baseProps} messages={messages} onLoadOlder={vi.fn()} />)
    expect(screen.queryByTestId('chat-load-older')).toBeNull()
  })
})
