// 用户 #19：作战舱（cockpit 变体）生成中，「中断」按钮变形、没居中。
// 根因是按钮里的「■」用了字形：等宽字体里它的墨迹不在字身中心，再叠
// font-weight:800 的合成加粗，方块被拉歪。方块改为元素画（grid 居中），
// 这里钉住「不再回退成字形」。

import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent, screen } from '@testing-library/react'
import { ChatArea } from '../ChatArea'
import type { ToolCallRecord } from '@/lib/agent/types'

const baseProps = {
  messages: [],
  streaming: true,
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
  composerVariant: 'cockpit' as const,
}

describe('ChatArea — 作战舱中断键', () => {
  it('生成中：方块是元素、按钮没有字形文本，点按触发 onStop', () => {
    const onStop = vi.fn()
    const { container } = render(<ChatArea {...baseProps} onStop={onStop} />)
    const button = container.querySelector('[data-tui-stop]')
    expect(button).not.toBeNull()
    // 不再渲染「■」字形 —— 按钮自己不带文本。
    expect(button!.textContent).toBe('')
    const glyph = button!.querySelector('[data-tui-stop-glyph]')
    expect(glyph).not.toBeNull()
    expect(button!.getAttribute('aria-label')).toBe('停止生成')

    fireEvent.click(button!)
    expect(onStop).toHaveBeenCalledTimes(1)
  })

  it('空闲（不流式）时不渲染中断键', () => {
    const { container } = render(<ChatArea {...baseProps} streaming={false} />)
    expect(container.querySelector('[data-tui-stop]')).toBeNull()
  })
})

describe('ChatArea — 有后台作业时停止整轮先确认（2026-11-24 用户 #3）', () => {
  const bgTasks = [
    { id: 'bg-1', description: 'pnpm dev', taskType: 'local_bash' },
    { id: 'bg-2', description: 'vitest run', taskType: 'local_bash' },
  ]

  it('角标 = 运行中的后台作业数；点一次只出确认层，不直接停', () => {
    const onStop = vi.fn()
    const { container, getByTestId, queryByTestId } = render(
      <ChatArea {...baseProps} onStop={onStop} backgroundTasks={bgTasks} />,
    )
    expect(getByTestId('cockpit-stop-count')).toHaveTextContent('2')

    fireEvent.click(container.querySelector('[data-tui-stop]')!)
    expect(onStop).not.toHaveBeenCalled()
    expect(getByTestId('cockpit-stop-confirm')).toHaveTextContent('停止整轮')

    fireEvent.click(getByTestId('cockpit-stop-all'))
    expect(onStop).toHaveBeenCalledTimes(1)
    expect(queryByTestId('cockpit-stop-confirm')).toBeNull()
  })

  it('「继续跑着」收起确认层，不打断这一轮', () => {
    const onStop = vi.fn()
    const { container, getByTestId, queryByTestId } = render(
      <ChatArea {...baseProps} onStop={onStop} backgroundTasks={bgTasks} />,
    )
    fireEvent.click(container.querySelector('[data-tui-stop]')!)
    fireEvent.click(screen.getByText('继续跑着'))
    expect(onStop).not.toHaveBeenCalled()
    expect(queryByTestId('cockpit-stop-confirm')).toBeNull()
  })

  it('没有后台作业：点红方块直接停，不出确认层', () => {
    const onStop = vi.fn()
    const { container, queryByTestId } = render(
      <ChatArea {...baseProps} onStop={onStop} />,
    )
    fireEvent.click(container.querySelector('[data-tui-stop]')!)
    expect(onStop).toHaveBeenCalledTimes(1)
    expect(queryByTestId('cockpit-stop-confirm')).toBeNull()
  })
})
