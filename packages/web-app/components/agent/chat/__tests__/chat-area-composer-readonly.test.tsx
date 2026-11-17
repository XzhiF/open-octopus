// design 25 §5.5：任务线程默认只读 —— composer 收成一条「只读 + 兜底开关」的条。
//
// 钉住：
//   ① composerHidden ⇒ 正常输入框不渲染，出现只读条；
//   ② 只读条上的「在此处回答（兜底）」可点，回调交回宿主（例外路径是显式的）；
//   ③ 不传 composerHidden 的宿主行为零变化（回归）。

import { render, screen, fireEvent } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ChatArea } from '../ChatArea'

const baseProps = {
  messages: [],
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

describe('ChatArea 只读 composer（任务线程兜底）', () => {
  it('composerHidden → 只读条 + 兜底开关，没有输入框', () => {
    const onEnable = vi.fn()
    const { container } = render(
      <ChatArea
        {...baseProps}
        composerHidden
        composerHiddenHint="汐音代你在与作者对话 · 你的决定都在主对话"
        composerEnableLabel="在此处回答（兜底）"
        onEnableComposer={onEnable}
      />,
    )
    expect(screen.getByTestId('composer-readonly-bar')).toBeInTheDocument()
    expect(screen.getByText(/汐音代你在与作者对话/)).toBeInTheDocument()
    expect(container.querySelector('[data-tui-composer]')).toBeNull()
    expect(container.querySelector('[data-composer-block]')).toBeNull()

    fireEvent.click(screen.getByTestId('composer-enable-fallback'))
    expect(onEnable).toHaveBeenCalledTimes(1)
  })

  it('未开启只读 → 正常 composer 仍在（回归）', () => {
    const { container } = render(<ChatArea {...baseProps} />)
    expect(screen.queryByTestId('composer-readonly-bar')).toBeNull()
    expect(container.querySelector('[data-tui-composer]')).toBeTruthy()
  })
})
