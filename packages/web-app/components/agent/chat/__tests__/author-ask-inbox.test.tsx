// design 23 §2 续 · 决策队列（2026-11-16 并发口径 → design 25 §5.3）
//
// 钉住：
//   ① 并发多个作业的提问 → 逐条列出，带 handle（#N / DN），可挑选；
//   ② 同屏最多 3 条展开，其余折成「+N 条待处理」；
//   ③ 焦点条常驻「正在回答谁」；键盘 1/2/3 + ↵ 通过 askId 定向到当前卡；
//   ④ 已答的卡不出现；答完焦点自动落到下一条。

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import type { AgentMessage } from '@/lib/agent/types'
import { AuthorAskInbox, pendingAuthorAsks } from '../author-ask-inbox'

function askMessage(
  id: string,
  taskId: string,
  taskName: string,
  question: string,
  answered = false,
  handle = '',
): AgentMessage {
  return {
    id,
    session_id: 's-cabin',
    role: 'user',
    content: '',
    created_at: '2026-11-16T10:00:00.000Z',
    is_summary: false,
    is_compressed: false,
    is_edited: false,
    displayType: 'event',
    activity: {
      status: 'awaiting_input',
      ...(answered ? { decision: { id: 'answer_author_ask', label: '已回答' } } : {}),
      payload: {
        authorAsk: true,
        authorSessionId: `s-${taskId}`,
        askMessageId: id,
        taskId,
        taskName,
        ...(handle ? { handle } : {}),
        questions: { questions: [{ question, header: 'q', multiSelect: false, options: [] }] },
      },
    },
  } as AgentMessage
}

describe('AuthorAskInbox', () => {
  it('并发两条 → 都列出（带 handle）；点一行发 open-ask 事件', () => {
    const onOpen = vi.fn()
    window.addEventListener('octopus:open-ask', onOpen)
    render(<AuthorAskInbox messages={[
      askMessage('ask-a', 't1', '任务A', 'A 的范围？', false, '#1'),
      askMessage('ask-b', 't2', '任务B', 'B 的验收？', false, '#2'),
    ]} />)

    expect(screen.getByTestId('author-ask-inbox')).toBeInTheDocument()
    expect(screen.getByText(/2 个作业在等你/)).toBeInTheDocument()
    expect(screen.getAllByTestId('author-ask-inbox-row')).toHaveLength(2)
    const rows = screen.getAllByTestId('author-ask-inbox-row')
    expect(rows[0].textContent).toContain('#1')
    expect(rows[1].textContent).toContain('#2')

    fireEvent.click(screen.getByText('B 的验收？'))
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect((onOpen.mock.calls[0][0] as CustomEvent).detail).toEqual({ askMessageId: 'ask-b' })
    window.removeEventListener('octopus:open-ask', onOpen)
  })

  it('同屏最多 3 条：其余折成「+N 条待处理」', () => {
    const messages = ['A', 'B', 'C', 'D', 'E'].map((n, i) =>
      askMessage(`ask-${n}`, `t${i}`, `任务${n}`, `${n} 的问题？`, false, `#${i + 1}`))
    render(<AuthorAskInbox messages={messages} />)
    expect(screen.getAllByTestId('author-ask-inbox-row')).toHaveLength(3)
    expect(screen.getByText('+2 条待处理')).toBeInTheDocument()
  })

  it('焦点条：屏幕上有且只有一处写着「正在回答哪一条」', () => {
    const messages = [
      askMessage('ask-a', 't1', '任务A', 'A 的范围？', false, '#1'),
      askMessage('ask-b', 't2', '任务B', 'B 的验收？', false, '#2'),
    ]
    render(<AuthorAskInbox messages={messages} />)
    const bar = screen.getByTestId('decision-focus-bar')
    expect(bar.textContent).toContain('#1')
    expect(bar.textContent).toContain('正在回答 任务A')
    // 点第二行 → 焦点切过去（显式操作，不是靠滚动位置）。
    fireEvent.click(screen.getByText('B 的验收？'))
    expect(screen.getByTestId('decision-focus-bar').textContent).toContain('正在回答 任务B')
  })

  it('键盘 1/2/3 + ↵ 只发给当前 ask（票据定向，不靠屏幕位置猜）', () => {
    const keys: Array<{ askId: string; key: string }> = []
    const onKey = (e: Event) => {
      const d = (e as CustomEvent<{ askId: string; key: string }>).detail
      keys.push({ askId: d.askId, key: d.key })
    }
    window.addEventListener('octopus:ask-key', onKey)
    render(<AuthorAskInbox messages={[
      askMessage('ask-a', 't1', '任务A', 'A 的范围？', false, '#1'),
      askMessage('ask-b', 't2', '任务B', 'B 的验收？', false, '#2'),
    ]} />)
    fireEvent.click(screen.getByText('B 的验收？'))
    fireEvent.keyDown(window, { key: '2' })
    fireEvent.keyDown(window, { key: 'Enter' })
    expect(keys).toEqual([
      { askId: 'ask-b', key: '2' },
      { askId: 'ask-b', key: 'Enter' },
    ])
    window.removeEventListener('octopus:ask-key', onKey)
  })

  it('输入框里打数字不算键盘选择', () => {
    const keys: string[] = []
    const onKey = (e: Event) => keys.push((e as CustomEvent<{ key: string }>).detail.key)
    window.addEventListener('octopus:ask-key', onKey)
    render(<div>
      <input data-testid="probe" />
      <AuthorAskInbox messages={[askMessage('ask-a', 't1', '任务A', 'A 的范围？', false, '#1')]} />
    </div>)
    fireEvent.keyDown(screen.getByTestId('probe'), { key: '1' })
    expect(keys).toHaveLength(0)
    window.removeEventListener('octopus:ask-key', onKey)
  })

  it('已答的卡不出现；全部答完则不渲染', () => {
    const { container } = render(<AuthorAskInbox messages={[
      askMessage('ask-a', 't1', '任务A', 'A 的范围？', true),
    ]} />)
    expect(container.querySelector('[data-testid="author-ask-inbox"]')).toBeNull()
    expect(pendingAuthorAsks([askMessage('ask-a', 't1', '任务A', 'A', true)])).toHaveLength(0)
  })

  it('octopus:author-ask-answered → 立即消项，焦点落到下一条', async () => {
    render(<AuthorAskInbox messages={[
      askMessage('ask-a', 't1', '任务A', 'A 的范围？', false, '#1'),
      askMessage('ask-b', 't2', '任务B', 'B 的验收？', false, '#2'),
    ]} />)
    expect(screen.getByTestId('author-ask-inbox')).toBeInTheDocument()
    window.dispatchEvent(new CustomEvent('octopus:author-ask-answered', {
      detail: { askMessageId: 'ask-a' },
    }))
    await waitFor(() => expect(screen.queryByText('A 的范围？')).toBeNull())
    expect(screen.getByTestId('decision-focus-bar').textContent).toContain('正在回答 任务B')
  })
})
