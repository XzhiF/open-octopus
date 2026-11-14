// 全域「对话索引」的形态（2026-11-14 用户口径）：
//   1. compact 档不在正文区渲染任何东西 —— 索引 portal 到浮窗标题栏的槽里；
//   2. 点开才出面板，最新一轮在上，编号仍是原始轮次；
//   3. 点条目跳轮；Esc / 点外面收起；
//   4. classic / 桌面（非 compact）仍是右侧短杠轨，逐字不变。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { ChatTimeline } from '../chat-timeline'

const items = [
  { id: 't1', text: '先把需求落盘' },
  { id: 't2', text: '五个仓库先摸一遍' },
  { id: 't3', text: '拆 M1 迭代' },
]

let host: HTMLDivElement

beforeEach(() => {
  // jsdom 没有 scrollIntoView：ChatTimeline 的跟随/聚焦会调它。
  Element.prototype.scrollIntoView = vi.fn()
  host = document.createElement('div')
  document.body.appendChild(host)
})

afterEach(() => {
  cleanup()
  host.remove()
})

describe('ChatTimeline compact（全域标题栏索引）', () => {
  it('原位不渲染，把手挂到标题栏槽；点开是最新在上的编号列表', () => {
    const { container } = render(
      <ChatTimeline items={items} activeId="t3" onJump={vi.fn()} compact portalHost={host} />,
    )
    expect(container).toBeEmptyDOMElement()

    const trigger = host.querySelector<HTMLButtonElement>('[data-testid="chat-timeline-handle"]')
    expect(trigger).not.toBeNull()
    expect(trigger?.textContent).toContain('3轮')
    expect(trigger?.getAttribute('aria-expanded')).toBe('false')

    fireEvent.click(trigger!)
    expect(trigger?.getAttribute('aria-expanded')).toBe('true')
    const list = screen.getByTestId('chat-timeline-list')
    const labels = [...list.querySelectorAll('[data-timeline-id]')].map((node) => node.textContent)
    expect(labels).toEqual(['03拆 M1 迭代', '02五个仓库先摸一遍', '01先把需求落盘'])
  })

  it('点条目跳轮并收起；Esc 也能收', () => {
    const onJump = vi.fn()
    render(<ChatTimeline items={items} activeId="t3" onJump={onJump} compact portalHost={host} />)
    const trigger = host.querySelector<HTMLButtonElement>('[data-testid="chat-timeline-handle"]')!
    fireEvent.click(trigger)
    fireEvent.click(screen.getByTitle('五个仓库先摸一遍'))
    expect(onJump).toHaveBeenCalledWith('t2')
    expect(screen.queryByTestId('chat-timeline-panel')).toBeNull()

    fireEvent.click(trigger)
    expect(screen.getByTestId('chat-timeline-panel')).not.toBeNull()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByTestId('chat-timeline-panel')).toBeNull()
  })

  it('没有标题栏槽时不回退成正文悬浮把手', () => {
    const { container } = render(
      <ChatTimeline items={items} activeId="t3" onJump={vi.fn()} compact portalHost={null} />,
    )
    expect(container).toBeEmptyDOMElement()
    expect(screen.queryByTestId('chat-timeline-handle')).toBeNull()
  })

  it('classic（非 compact）仍是右侧短杠轨，没有标题栏把手', () => {
    render(<ChatTimeline items={items} activeId="t3" onJump={vi.fn()} />)
    expect(screen.getByTestId('chat-timeline')).not.toBeNull()
    expect(screen.queryByTestId('chat-timeline-handle')).toBeNull()
    expect(host.childElementCount).toBe(0)
  })
})