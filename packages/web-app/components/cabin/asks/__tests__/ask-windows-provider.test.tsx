// 问答窗集合（design 26 §5.5）：打开 / 置顶去重 / 乐观已答 / 别处答过。
import { describe, it, expect } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import type { CabinAttentionItem } from '@octopus/shared'
import { AskWindowsProvider, useAskWindows } from '../ask-windows-provider'

function attn(id: string, over: Partial<CabinAttentionItem> = {}): CabinAttentionItem {
  return {
    id: `ask-${id}`,
    job_id: null,
    stage: 'answer',
    awaiting: 'person',
    title: `任务 ${id} · 待回答`,
    question: '问？',
    task_id: null,
    repo: null,
    wt: null,
    deep_link: `ask:${id}`,
    priority: 1,
    ask: { ask_id: id, message_id: `m-${id}` },
    ...over,
  }
}

function Harness() {
  const { asks, windows, open, close, markAnswered, focus } = useAskWindows()
  return (
    <div>
      <span data-testid="asks">{asks.map((a) => a.askId).join(',')}</span>
      <span data-testid="windows">
        {windows.map((w) => `${w.askId}:${w.answered ? 'A' : ''}${w.external ? 'X' : ''}`).join(',')}
      </span>
      <span data-testid="flash">{windows.map((w) => w.flash).join(',')}</span>
      <button type="button" onClick={() => open('a1')}>open-a1</button>
      <button type="button" onClick={() => open('a2')}>open-a2</button>
      <button type="button" onClick={() => focus('a1')}>focus-a1</button>
      <button type="button" onClick={() => close('a1')}>close-a1</button>
      <button type="button" onClick={() => markAnswered('a1')}>mark-a1</button>
    </div>
  )
}

function renderWith(attention: CabinAttentionItem[]) {
  return render(
    <AskWindowsProvider attention={attention}>
      <Harness />
    </AskWindowsProvider>,
  )
}

describe('AskWindowsProvider', () => {
  it('把 attention 过滤成「等你答」，未打开时没有窗', () => {
    renderWith([attn('a1'), attn('a2'), attn('x', { stage: 'review' })])
    expect(screen.getByTestId('asks').textContent).toBe('a1,a2')
    expect(screen.getByTestId('windows').textContent).toBe('')
  })

  it('同一 askId 再点只置顶，不新建第二扇', () => {
    renderWith([attn('a1')])
    fireEvent.click(screen.getByText('open-a1'))
    fireEvent.click(screen.getByText('open-a1'))
    expect(screen.getByTestId('windows').textContent).toBe('a1:')
  })

  it('乐观已答：行立即消失，窗保留并标记 answered', () => {
    renderWith([attn('a1'), attn('a2')])
    fireEvent.click(screen.getByText('open-a1'))
    fireEvent.click(screen.getByText('mark-a1'))
    expect(screen.getByTestId('asks').textContent).toBe('a2')
    expect(screen.getByTestId('windows').textContent).toBe('a1:A')
  })

  it('别处答掉（attention 项消失）：窗保留并标记 external', () => {
    const { rerender } = renderWith([attn('a1'), attn('a2')])
    fireEvent.click(screen.getByText('open-a1'))
    rerender(
      <AskWindowsProvider attention={[attn('a2')]}>
        <Harness />
      </AskWindowsProvider>,
    )
    expect(screen.getByTestId('asks').textContent).toBe('a2')
    expect(screen.getByTestId('windows').textContent).toBe('a1:X')
  })

  it('主 chat 卡答掉（author-ask-answered 事件）→ 编队行同步消项', () => {
    renderWith([attn('a1'), attn('a2')])
    act(() => {
      window.dispatchEvent(new CustomEvent('octopus:author-ask-answered', {
        detail: { askMessageId: 'a1' },
      }))
    })
    expect(screen.getByTestId('asks').textContent).toBe('a2')
  })

  it('窗内点击 focus 只置顶，不重播闪烁；重开编队行才闪', () => {
    renderWith([attn('a1')])
    fireEvent.click(screen.getByText('open-a1'))
    const afterOpen = Number(screen.getByTestId('flash').textContent)
    fireEvent.click(screen.getByText('focus-a1'))
    expect(Number(screen.getByTestId('flash').textContent)).toBe(afterOpen)
    fireEvent.click(screen.getByText('open-a1'))
    expect(Number(screen.getByTestId('flash').textContent)).toBe(afterOpen + 1)
  })

  it('关闭窗后从行重开：仍是一扇，位置由层重算', () => {
    renderWith([attn('a1')])
    fireEvent.click(screen.getByText('open-a1'))
    fireEvent.click(screen.getByText('close-a1'))
    expect(screen.getByTestId('windows').textContent).toBe('')
    fireEvent.click(screen.getByText('open-a1'))
    expect(screen.getByTestId('windows').textContent).toBe('a1:')
  })
})
