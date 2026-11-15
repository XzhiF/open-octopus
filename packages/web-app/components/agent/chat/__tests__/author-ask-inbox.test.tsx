// design 23 §2 续 · 待回答收件箱（2026-11-16 并发口径）
//
// 钉住：
//   ① 并发多个任务的作者提问 → 收件箱逐条列出，可挑选；
//   ② 已答（activity.decision）的卡不出现；
//   ③ 点一行发 octopus:open-ask，让转录里的对应卡片滚进视野。

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import type { AgentMessage } from '@/lib/agent/types'
import { AuthorAskInbox, pendingAuthorAsks } from '../author-ask-inbox'

function askMessage(id: string, taskId: string, taskName: string, question: string, answered = false): AgentMessage {
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
        questions: { questions: [{ question, header: 'q', multiSelect: false, options: [] }] },
      },
    },
  } as AgentMessage
}

describe('AuthorAskInbox', () => {
  it('并发两条 → 都列出；点一行发 open-ask 事件', () => {
    const onOpen = vi.fn()
    window.addEventListener('octopus:open-ask', onOpen)
    render(<AuthorAskInbox messages={[
      askMessage('ask-a', 't1', '任务A', 'A 的范围？'),
      askMessage('ask-b', 't2', '任务B', 'B 的验收？'),
    ]} />)

    expect(screen.getByTestId('author-ask-inbox')).toBeInTheDocument()
    expect(screen.getByText('2 个任务在等你回答 · 选一条处理')).toBeInTheDocument()
    expect(screen.getAllByTestId('author-ask-inbox-row')).toHaveLength(2)

    fireEvent.click(screen.getByText('A 的范围？'))
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect((onOpen.mock.calls[0][0] as CustomEvent).detail).toEqual({ askMessageId: 'ask-a' })
    window.removeEventListener('octopus:open-ask', onOpen)
  })

  it('已答的卡不出现；全部答完则不渲染', () => {
    const { container } = render(<AuthorAskInbox messages={[
      askMessage('ask-a', 't1', '任务A', 'A 的范围？', true),
    ]} />)
    expect(container.querySelector('[data-testid="author-ask-inbox"]')).toBeNull()
    expect(pendingAuthorAsks([askMessage('ask-a', 't1', '任务A', 'A', true)])).toHaveLength(0)
  })

  it('octopus:author-ask-answered → 立即消项', async () => {
    render(<AuthorAskInbox messages={[askMessage('ask-a', 't1', '任务A', 'A 的范围？')]} />)
    expect(screen.getByTestId('author-ask-inbox')).toBeInTheDocument()
    window.dispatchEvent(new CustomEvent('octopus:author-ask-answered', {
      detail: { askMessageId: 'ask-a' },
    }))
    await waitFor(() => expect(screen.queryByTestId('author-ask-inbox')).toBeNull())
  })
})
