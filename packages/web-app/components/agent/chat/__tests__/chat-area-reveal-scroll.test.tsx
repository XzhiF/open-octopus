// 全域座舱浮窗：transcript 在隐藏（display:none / 47px 收起）时 scrollHeight=0，
// 消息加载时贴底 effect 只落在顶部；开窗没有新消息，effect 不会重跑 ——
// 用户看到的是对话最开始。ResizeObserver 要在容器 0 → 有尺寸时重新贴底。

import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
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
    created_at: '2026-11-14T00:00:00.000Z',
    is_summary: false,
    is_compressed: false,
    is_edited: false,
  }
}

const messages = [
  message('m1', 'user', '第一轮提问'),
  message('m2', 'assistant', '第一轮回答'),
  message('m3', 'user', '最新一轮提问'),
  message('m4', 'assistant', '最新一轮回答'),
]

function scroller() {
  return screen.getByTestId('chat-transcript-scroll') as HTMLDivElement
}

function setSize(el: HTMLElement, scrollHeight: number, clientHeight: number) {
  Object.defineProperty(el, 'scrollHeight', { configurable: true, value: scrollHeight })
  Object.defineProperty(el, 'clientHeight', { configurable: true, value: clientHeight })
}

function fireResize() {
  ;(globalThis as Record<string, unknown> & { __fireResizeObservers?: () => void })
    .__fireResizeObservers?.()
}

describe('ChatArea transcript 重新可见时贴底', () => {
  beforeEach(() => {
    // jsdom 没有 scrollIntoView（ChatTimeline 定位当前轮会调用）。
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    })
  })

  it('容器从隐藏恢复（0 → 有尺寸）时滚到最新一条', () => {
    render(<ChatArea {...baseProps} messages={messages} />)
    const el = scroller()

    setSize(el, 1200, 400)
    el.scrollTop = 0 // 模拟隐藏期间贴底 effect 落在顶部
    fireResize()

    expect(el.scrollTop).toBe(1200)
  })

  it('用户正在回看历史时不抢滚动位置', () => {
    render(<ChatArea {...baseProps} messages={messages} />)
    const el = scroller()

    setSize(el, 1200, 400)
    el.scrollTop = 300 // 离底 500px：视为回看
    fireEvent.scroll(el)

    setSize(el, 1600, 400)
    fireResize()

    expect(el.scrollTop).toBe(300)
  })
})