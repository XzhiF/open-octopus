// design 25 §2 / §5.5：代理发言（汐音 · 代你）在任务线程里必须可区分。
//
// 识别是格式契约（cabin-brief.ts 的 formatRelayMessage / formatDispatchMessage），
// 改格式必须同时改 provider 与这里。

import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { AgentMessage } from '@/lib/agent/types'
import { TuiMessage, proxyTurnOf } from '../TuiTranscript'

function userMessage(content: string): AgentMessage {
  return {
    id: 'm1',
    session_id: 's-doer',
    role: 'user',
    content,
    created_at: '2026-11-16T10:00:00.000Z',
    is_summary: false,
    is_compressed: false,
    is_edited: false,
  } as AgentMessage
}

describe('proxyTurnOf', () => {
  it('识别决策转达并抽出逐字行', () => {
    const content = [
      '[决策 · #1 · ask_7f3a] 短信',
      '用户回答了以下问题：短信',
      '',
      '决策：',
      '（逐字）短信',
    ].join('\n')
    expect(proxyTurnOf(content)).toEqual({ kind: 'decision', verbatim: '短信' })
  })

  it('识别派发 / 委派（意图编译）消息', () => {
    expect(proxyTurnOf('[汐音 · 代用户转达] 任务「支付回调」\n授权：...')).toEqual({ kind: 'brief' })
    expect(proxyTurnOf('[舱派发 · mandate=explicit] 任务「x」')).toEqual({ kind: 'brief' })
  })

  it('普通用户消息不误判（不靠语义猜）', () => {
    expect(proxyTurnOf('帮我看下这个 []')).toBeNull()
    expect(proxyTurnOf('[决策] 这是我自己打的字')).toBeNull()
  })

  it('主对话里人自己的决定（结构化用户消息）不是代理发言', () => {
    // 主会话的 [决策 · …] 没有「用户回答了以下问题」兼容行 —— 它属于人。
    const mine = '[决策 · #1 支付回调 · ask_7f3a] 短信\n（逐字）短信\n（补充）只做通道验证'
    expect(proxyTurnOf(mine)).toBeNull()
  })
})

describe('TuiMessage 代理发言样式', () => {
  it('决策转达渲染成琥珀脊线 + 「汐音 · 代你」标签', () => {
    const { container } = render(
      <TuiMessage message={userMessage(
        '[决策 · #1 · ask_7f3a] 短信\n用户回答了以下问题：短信\n（逐字）短信',
      )} />,
    )
    const node = container.querySelector('[data-tui-msg="proxy"]')
    expect(node).toBeTruthy()
    expect(node!.getAttribute('data-proxy-kind')).toBe('decision')
    expect(screen.getByText('汐音 · 代你')).toBeInTheDocument()
    expect(screen.getByText('决策已逐字转达')).toBeInTheDocument()
  })

  it('普通用户消息保持原样式', () => {
    const { container } = render(<TuiMessage message={userMessage('普通一句')} />)
    expect(container.querySelector('[data-tui-msg="user"]')).toBeTruthy()
    expect(container.querySelector('[data-tui-msg="proxy"]')).toBeNull()
  })

  it('主对话的决定消息是普通用户气泡（不是「代你」）', () => {
    const { container } = render(
      <TuiMessage message={userMessage(
        '[决策 · #1 支付回调 · ask_7f3a] 短信\n（逐字）短信',
      )} />,
    )
    expect(container.querySelector('[data-tui-msg="user"]')).toBeTruthy()
    expect(container.querySelector('[data-tui-msg="proxy"]')).toBeNull()
  })
})
