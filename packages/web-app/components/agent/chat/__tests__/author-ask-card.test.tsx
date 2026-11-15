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
  submitCabinDecision: vi.fn(async () => ({
    decision: { display: true },
    already: false,
    receipt: { handle: '#1', choice: '短信', line: '✓ 已记下：短信 · 汐音正在转达…' },
  })),
}))

vi.mock('@/lib/agent/api', () => ({
  recordCardDecision: api.recordCardDecision,
  chatStream: api.chatStream,
}))

vi.mock('@/lib/cabin-api', async () => {
  class CabinDecisionError extends Error {
    constructor(message: string, public status: number, public detail?: unknown) {
      super(message)
    }
  }
  return {
    submitCabinDecision: api.submitCabinDecision,
    CabinDecisionError,
  }
})

vi.mock('@/components/cabin/cabin-provider', () => ({
  useCabinOptional: () => null,
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

function envelopeMessage(): AgentMessage {
  const message = makeMessage()
  message.activity = {
    ...message.activity!,
    payload: {
      ...(message.activity!.payload as Record<string, unknown>),
      cabinId: 'c1',
      handle: '#1',
      subject: { kind: 'task', id: 'task-1' },
      decision: '失败回调用什么通道重试？',
      intent: '把支付回调加上重试，先别落库',
      options: [
        { label: '短信', impact: '只做通道验证，不落库' },
        { label: '邮件', impact: '多一张投递记录表' },
      ],
      recommendation: { label: '短信', reason: '最薄，先验证通道' },
      phase: { index: 1, round: 2 },
      blocking: true,
    },
  }
  return message
}

beforeEach(() => {
  api.recordCardDecision.mockClear()
  api.chatStream.mockClear()
  api.submitCabinDecision.mockClear()
  api.submitCabinDecision.mockResolvedValue({
    decision: { display: true },
    already: false,
    receipt: { handle: '#1', choice: '短信', line: '✓ 已记下：短信 · 汐音正在转达…' },
  })
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
    await waitFor(() => expect(screen.getByText(/✓ 已答 · 舱任务：短信/)).toBeInTheDocument())
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

  it('有舱绑定 → 走决策端点；提交即只读（不等转达），转发的 askId 来自卡片', async () => {
    const user = userEvent.setup()
    api.submitCabinDecision.mockClear()
    api.chatStream.mockClear()
    render(<AuthorAskCard message={envelopeMessage()} />)

    await user.click(screen.getAllByText('短信').at(-1)!)
    await user.click(screen.getByText('提交答案'))

    await waitFor(() => expect(api.submitCabinDecision).toHaveBeenCalledTimes(1))
    const [cabinId, body] = api.submitCabinDecision.mock.calls[0] as unknown as [string, Record<string, unknown>]
    expect(cabinId).toBe('c1')
    expect(body.askId).toBe('ask-1')
    expect(body.choice).toBe('短信')
    expect(body.source).toBe('card')
    // 直发路径不应被使用（决定由服务端转达）。
    expect(api.chatStream).not.toHaveBeenCalled()
    expect(await screen.findByText(/已记下：短信/)).toBeInTheDocument()
  })

  it('信封上下文：决策 / 原文 / 选项影响 / 作者建议 都可展开', () => {
    render(<AuthorAskCard message={envelopeMessage()} />)
    const envelope = screen.getByTestId('author-ask-envelope')
    expect(envelope.textContent).toContain('失败回调用什么通道重试？')
    expect(envelope.textContent).toContain('你的原始要求')
    expect(envelope.textContent).toContain('只做通道验证，不落库')
    expect(envelope.textContent).toContain('作者建议')
  })

  it('服务端拒绝（归属 / 选项不合法）→ 明确报错，不偷偷改投别处', async () => {
    const user = userEvent.setup()
    const ErrorCtor = (await import('@/lib/cabin-api')).CabinDecisionError as new (
      msg: string, status: number, detail?: unknown,
    ) => Error
    api.submitCabinDecision.mockRejectedValueOnce(new ErrorCtor('「电话」不在 #1 的可选范围内', 400, {
      choices: ['短信', '邮件'],
    }))
    api.chatStream.mockClear()
    render(<AuthorAskCard message={envelopeMessage()} />)
    await user.click(screen.getAllByText('短信').at(-1)!)
    await user.click(screen.getByText('提交答案'))

    expect(await screen.findByTestId('author-ask-failed')).toBeInTheDocument()
    expect(api.chatStream).not.toHaveBeenCalled()
  })
})
