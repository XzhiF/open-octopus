// 事项投递在 composer 上的三个可见标识（2026-11-24 用户）：
//   seed   → 预填文案 + 输入框上方「☑ 事项 ×N」挂件；
//   发送   → onSend 带上 meta { via:'items', itemIds }；
//   忙时   → TUI 队列携带 meta，出队时一起交给服务端（不丢来源）。

import type { ComponentProps, MutableRefObject } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChatArea, type ChatComposerBridge } from '@/components/agent/chat/ChatArea'
import type { ToolCallRecord } from '@/lib/agent/types'

type Props = ComponentProps<typeof ChatArea>

function baseProps(overrides: Partial<Props> = {}): Props {
  return {
    messages: [],
    streaming: false,
    streamContent: '',
    streamThinking: '',
    isThinking: false,
    toolCalls: [] as ToolCallRecord[],
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
    composerVariant: 'cockpit',
    ...overrides,
  }
}

afterEach(() => cleanup())

describe('ChatArea · 事项投递', () => {
  it('seed 预填输入框并挂「☑ 事项」挂件；发送带 meta', () => {
    const bridgeRef = { current: null } as MutableRefObject<ChatComposerBridge | null>
    const props = baseProps({ composerBridgeRef: bridgeRef })
    render(<ChatArea {...props} />)

    act(() => {
      bridgeRef.current?.seed('处理这几条事项：\n- #IT-1 时间列太窄', {
        via: 'items',
        itemIds: ['ci-1'],
        labels: ['#IT-1'],
      })
    })

    const textarea = screen.getByRole('textbox')
    expect(textarea).toHaveValue('处理这几条事项：\n- #IT-1 时间列太窄')
    const chip = screen.getByTestId('composer-items-chip')
    expect(chip).toHaveTextContent('事项 ×1')
    expect(chip).toHaveTextContent('#IT-1')

    fireEvent.keyDown(textarea, { key: 'Enter' })
    expect(props.onSend).toHaveBeenCalledTimes(1)
    const [text, opts] = (props.onSend as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(text).toContain('#IT-1')
    expect(opts).toEqual({ meta: { via: 'items', itemIds: ['ci-1'] } })
    // 发出后挂件消失
    expect(screen.queryByTestId('composer-items-chip')).toBeNull()
  })

  it('直接 submit 带 meta（空闲 + 忙时排队）', () => {
    const bridgeRef = { current: null } as MutableRefObject<ChatComposerBridge | null>
    const idle = baseProps({ composerBridgeRef: bridgeRef })
    const { rerender } = render(<ChatArea {...idle} />)

    act(() => {
      bridgeRef.current?.submit('处理这几条事项：\n- #IT-2', { via: 'items', itemIds: ['ci-2'] })
    })
    expect(idle.onSend).toHaveBeenCalledWith(
      '处理这几条事项：\n- #IT-2',
      { meta: { via: 'items', itemIds: ['ci-2'] } },
    )

    // 流式中：不直接发，进 TUI 队列（带 meta）
    const busy = baseProps({ composerBridgeRef: bridgeRef, streaming: true })
    rerender(<ChatArea {...busy} />)
    act(() => {
      bridgeRef.current?.submit('处理这几条事项：\n- #IT-3', { via: 'items', itemIds: ['ci-3'] })
    })
    expect(busy.onSend).not.toHaveBeenCalled()
    expect(screen.getByText(/queued/)).toBeInTheDocument()

    // 本轮收口 → 队首出队，meta 一起发出
    const after = baseProps({ composerBridgeRef: bridgeRef, streaming: false })
    rerender(<ChatArea {...after} />)
    expect(after.onSend).toHaveBeenCalledWith(
      '处理这几条事项：\n- #IT-3',
      { meta: { via: 'items', itemIds: ['ci-3'] } },
    )
  })
})
