// S5 命门：composer 被 portal 到全域底栏后，仍然是**同一个真 composer** ——
// 能输入、能 ⏎ 提交、流式中能排队 / steer、bridge.submit 走同一条管线，
// 并且 DOM 里永远只有一个 textarea（不能出现两份 composer）。

import { useEffect, useState, type ComponentProps, type MutableRefObject } from 'react'
import { render, fireEvent, screen, act } from '@testing-library/react'
import { describe, it, expect, afterEach, vi } from 'vitest'
import { ChatArea, type ChatComposerBridge } from '@/components/agent/chat/ChatArea'
import type { ToolCallRecord } from '@/lib/agent/types'
import { resetChatSlots, setChatSlot } from '../chat-slots'

const baseProps = {
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
}

type Props = ComponentProps<typeof ChatArea>

/** 底栏槽 + ChatArea 的真实组合：槽是宿主的 DOM（footer），composer portal 进去。 */
function SlotHarness({ bridgeRef, ...props }: Omit<Props, 'composerSlot'> & {
  bridgeRef?: MutableRefObject<ChatComposerBridge | null>
}) {
  const [slot, setSlot] = useState<HTMLDivElement | null>(null)
  return (
    <div>
      {/* 模拟 CockpitCommandBar 的 54px 槽（在 ChatArea 之外） */}
      <div data-testid="footer-slot" ref={setSlot} />
      <div data-testid="chat-area-host">
        <ChatArea {...props} composerSlot={slot} composerBridgeRef={bridgeRef} />
      </div>
    </div>
  )
}

/** 台头 attach 槽 + ChatArea 的组合（v22 十轮：星核挂载入口搬到标题栏）。 */
function AttachSlotHarness(props: Omit<Props, 'composerVariant'>) {
  const [slot, setSlot] = useState<HTMLSpanElement | null>(null)
  useEffect(() => setChatSlot('attach', slot), [slot])
  return (
    <div>
      <div data-testid="window-head">
        <span data-testid="attach-slot" ref={setSlot} />
      </div>
      <div data-testid="chat-area-host">
        <ChatArea {...props} composerVariant="cockpit" showComposerAttach />
      </div>
    </div>
  )
}

/** 独立窗自己的「对话索引」槽（v22 #5：窗头 ≡ N 轮）。 */
function IndexSlotHarness(props: Omit<Props, 'indexSlot' | 'inlineChrome'>) {
  const [slot, setSlot] = useState<HTMLSpanElement | null>(null)
  return (
    <div>
      <div data-testid="window-head">
        <span data-testid="index-slot" ref={setSlot} />
      </div>
      <div data-testid="chat-area-host">
        <ChatArea {...props} indexSlot={slot} inlineChrome composerVariant="cockpit" />
      </div>
    </div>
  )
}

/** 独立窗自己的「星核」槽（v22 #5：窗头 ✕ 右边，与主通讯台同位）。
 *  2026-11-23 用户：星核不能在输入行 ⏎ 左边。 */
function WindowAttachHarness(props: Omit<Props, 'attachSlot' | 'inlineChrome'>) {
  const [slot, setSlot] = useState<HTMLSpanElement | null>(null)
  return (
    <div>
      <div data-testid="window-head">
        <span data-testid="own-attach-slot" ref={setSlot} />
      </div>
      <div data-testid="chat-area-host">
        <ChatArea {...props} attachSlot={slot} inlineChrome composerVariant="cockpit" showComposerAttach />
      </div>
    </div>
  )
}

afterEach(() => resetChatSlots())

function typeAndEnter(scope: HTMLElement, text: string) {
  const ta = scope.querySelector('textarea')!
  fireEvent.change(ta, { target: { value: text } })
  fireEvent.keyDown(ta, { key: 'Enter' })
}

describe('ChatArea — composerSlot portal（全域座舱）', () => {
  it('composer 只渲染一份，落在槽里，输入 + ⏎ 仍触发同一个 onSend', () => {
    const onSend = vi.fn()
    const { container } = render(<SlotHarness {...baseProps} onSend={onSend} />)

    const slot = screen.getByTestId('footer-slot')
    const host = screen.getByTestId('chat-area-host')

    // 命门断言：DOM 级只有一个输入框，且在底栏槽里。
    expect(container.querySelectorAll('textarea')).toHaveLength(1)
    expect(slot.querySelectorAll('textarea')).toHaveLength(1)
    expect(host.querySelector('textarea')).toBeNull()

    typeAndEnter(slot, '从底栏发一条')
    expect(onSend).toHaveBeenCalledWith('从底栏发一条', undefined)
  })

  it('composerVariant="cockpit" 隐藏模型/上下文读数，但保留输入与发送', () => {
    const { container: cockpit } = render(
      <SlotHarness {...baseProps} composerVariant="cockpit" />,
    )
    expect(cockpit.textContent).not.toContain('pro')
    expect(cockpit.querySelector('textarea')).toBeTruthy()

    const { container: full } = render(<SlotHarness {...baseProps} composerVariant="full" />)
    // full 变体里 model 读数仍在 composer 控件条上。
    expect(full.textContent).toContain('pro')
  })

  it('bridge.submit 复用真管线：流式中无排队 → steer', () => {
    const onSteer = vi.fn()
    const bridgeRef: MutableRefObject<ChatComposerBridge | null> = { current: null }
    render(
      <SlotHarness
        {...baseProps}
        streaming
        onSteer={onSteer}
        bridgeRef={bridgeRef}
      />,
    )
    act(() => bridgeRef.current?.submit('换个方向'))
    expect(onSteer).toHaveBeenCalledWith('换个方向', undefined)
  })

  it('bridge.submit 在后台任务运行中 → 进队列，队列深度上报', () => {
    const onSend = vi.fn()
    const onSteer = vi.fn()
    const onQueueDepthChange = vi.fn()
    const bridgeRef: MutableRefObject<ChatComposerBridge | null> = { current: null }
    const props = {
      ...baseProps,
      streaming: true,
      onSend,
      onSteer,
      onQueueDepthChange,
      backgroundTasks: [{ id: 'bg-1', description: 'bash scripts/dev-up.sh' }],
    }
    const { container, rerender } = render(
      <SlotHarness {...props} bridgeRef={bridgeRef} />,
    )
    act(() => bridgeRef.current?.submit('起来了吗？'))
    expect(onSteer).not.toHaveBeenCalled()
    expect(container.querySelector('[data-tui-queue]')?.textContent).toContain('起来了吗？')
    expect(onQueueDepthChange).toHaveBeenCalledWith(1)

    // 回合收口 → done-flush 发队首，深度回到 0。
    rerender(<SlotHarness {...props} streaming={false} backgroundTasks={[]} bridgeRef={bridgeRef} />)
    expect(onSend).toHaveBeenCalledWith('起来了吗？', undefined)
    expect(onQueueDepthChange).toHaveBeenLastCalledWith(0)
  })

  it('没有槽时行为不变：composer 仍在 ChatArea 内部', () => {
    const { container } = render(<ChatArea {...baseProps} />)
    expect(container.querySelectorAll('textarea')).toHaveLength(1)
    expect(container.querySelector('[data-testid="footer-slot"]')).toBeNull()
  })

  it('星核挂载入口 portal 进台头槽，输入行不再有内联 ＋', () => {
    render(<AttachSlotHarness {...baseProps} />)
    const head = screen.getByTestId('window-head')
    const host = screen.getByTestId('chat-area-host')
    expect(head.querySelector('[data-testid="cockpit-attach"]')).toBeTruthy()
    expect(head.querySelector('[data-testid="composer-plus"]')).toBeNull()
    expect(host.querySelector('[data-tui-attach-inline]')).toBeNull()
  })

  // v22 #5：编队独立窗 —— 助手行头换成该线程 agent 的身份；星核不抢主台槽。
  it('assistantLabel：助手行头不是「汐音」，用传进来的身份', () => {
    const { container } = render(
      <ChatArea
        {...baseProps}
        composerVariant="cockpit"
        assistantLabel="执行者 · task-doer"
        messages={[{ id: 'm1', role: 'assistant', content: '收到', created_at: '2026-11-23T08:00:00Z' } as never]}
      />,
    )
    const tags = Array.from(container.querySelectorAll('.ck12-tui-tag')).map((el) => el.textContent)
    expect(tags).toContain('✦ 执行者 · task-doer')
    expect(tags).not.toContain('✦ 汐音')
  })

  it('inlineChrome：独立窗的星核进自己的窗头槽（左上），不留在输入行', () => {
    render(<WindowAttachHarness {...baseProps} />)
    const slot = screen.getByTestId('own-attach-slot')
    const host = screen.getByTestId('chat-area-host')
    expect(slot.querySelector('[data-testid="cockpit-attach"]')).toBeTruthy()
    expect(host.querySelector('[data-tui-attach-inline]')).toBeNull()
  })

  it('inlineChrome 且没有窗头槽时退回输入行（功能不丢）', () => {
    render(<AttachSlotHarness {...baseProps} inlineChrome />)
    const head = screen.getByTestId('window-head')
    const host = screen.getByTestId('chat-area-host')
    expect(head.querySelector('[data-testid="cockpit-attach"]')).toBeNull()
    expect(host.querySelector('[data-tui-attach-inline]')).toBeTruthy()
  })

  it('独立窗的「≡ N 轮」索引进自己的槽，不回落到通讯台', () => {
    render(
      <IndexSlotHarness
        {...baseProps}
        messages={[{ id: 'u1', role: 'user', content: '第一句', created_at: '2026-11-23T08:00:00Z' } as never]}
      />,
    )
    const slot = screen.getByTestId('index-slot')
    expect(slot.querySelector('[data-testid="chat-timeline-handle"]')).toBeTruthy()
    expect(screen.getByTestId('chat-area-host').querySelector('[data-testid="chat-timeline-handle"]')).toBeNull()
  })
})
