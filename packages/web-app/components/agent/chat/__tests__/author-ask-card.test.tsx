// design 23 §2 · 就地作答：舱主会话里的作者提问卡。
//
// 钉住三件事：
//   ① 复用 AskUserQuestionCard（选项 / 其他 / 提交）渲染 activity.payload.questions；
//   ② 提交时把答案转发给作者线程（chatStream），并把选择写回卡片（recordCardDecision）；
//   ③ 已有 decision 的卡片只读（刷新/换设备不会又变回可点）。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AgentMessage } from '@/lib/agent/types'

const api = vi.hoisted(() => ({
  recordCardDecision: vi.fn(async () => ({ ok: true, activity: {} })),
  chatStream: vi.fn(() => ({
    reader: { read: async () => ({ done: true }) },
    abort: vi.fn(),
  })),
}))

vi.mock('@/lib/agent/api', () => ({
  recordCardDecision: api.recordCardDecision,
  chatStream: api.chatStream,
}))

vi.mock('@/lib/utils', () => ({
  cn: (...args: string[]) => args.filter(Boolean).join(' '),
}))

import { AuthorAskCard } from '../author-ask-card'

const QUESTIONS = {
  questions: [{
    question: '走哪个通道？',
    header: '通道',
    multiSelect: false,
    options: [
      { label: '短信', description: '最薄' },
      { label: '邮件', description: '有留痕' },
    ],
  }],
}

function makeMessage(decision?: { id: string; label?: string }): AgentMessage {
  return {
    id: 'card-1',
    session_id: 's-cabin',
    role: 'assistant',
    content: '',
    created_at: '2026-11-16T10:00:00.000Z',
    is_summary: false,
    is_compressed: false,
    is_edited: false,
    displayType: 'event',
    activity: {
      status: 'awaiting_input',
      ...(decision ? { decision } : {}),
      payload: {
        authorAsk: true,
        authorSessionId: 's-author',
        askMessageId: 'ask-1',
        taskId: 'task-1',
        taskName: '舱任务',
        questions: QUESTIONS,
      },
    },
  } as AgentMessage
}

beforeEach(() => {
  api.recordCardDecision.mockClear()
  api.chatStream.mockClear()
})

afterEach(() => vi.useRealTimers())

describe('AuthorAskCard', () => {
  it('渲染问题；提交后转发给作者线程（不切当前会话）并写回卡片', async () => {
    const user = userEvent.setup()
    render(<AuthorAskCard message={makeMessage()} />)

    expect(screen.getByText('舱任务的作者在问你')).toBeInTheDocument()
    expect(screen.getByText('走哪个通道？')).toBeInTheDocument()

    await user.click(screen.getByText('短信'))
    await user.click(screen.getByText('提交答案'))

    await waitFor(() => expect(api.chatStream).toHaveBeenCalledTimes(1))
    const [sessionId, content] = api.chatStream.mock.calls[0] as unknown as [string, string]
    expect(sessionId).toBe('s-author')
    expect(content).toContain('用户回答了以下问题')
    expect(content).toContain('走哪个通道？')
    expect(content).toContain('→ 短信')
    expect(api.recordCardDecision).toHaveBeenCalledWith('card-1', expect.objectContaining({
      actionId: 'answer_author_ask',
    }))
    await waitFor(() => expect(screen.getByText(/已回答 · 舱任务的作者继续推进/)).toBeInTheDocument())
  })

  it('已有 decision → 只读，不再渲染提交入口', () => {
    render(<AuthorAskCard message={makeMessage({ id: 'answer_author_ask', label: '已回答' })} />)
    expect(screen.getByText(/已回答 · 舱任务的作者继续推进/)).toBeInTheDocument()
    expect(screen.queryByText('提交答案')).not.toBeInTheDocument()
  })

  it('作者线程忙（转发被拒）→ 不谎报已回答，卡片保持可点并提示重试', async () => {
    vi.useFakeTimers()
    api.chatStream.mockImplementation(() => ({
      reader: { read: async () => { throw new Error('SSE connection failed: 409') } },
      abort: vi.fn(),
    }))
    render(<AuthorAskCard message={makeMessage()} />)
    fireEvent.click(screen.getByText('短信'))
    fireEvent.click(screen.getByText('提交答案'))
    await act(async () => {
      await vi.runAllTimersAsync()
    })
    await act(async () => { await Promise.resolve() })

    expect(api.recordCardDecision).not.toHaveBeenCalled()
    expect(screen.getByTestId('author-ask-failed')).toBeInTheDocument()
    expect(screen.queryByText(/已回答 · 舱任务的作者继续推进/)).not.toBeInTheDocument()
    vi.useRealTimers()
  })
})
