'use client'

// 作者提问卡（design 23 §2 · 就地作答）
//
// 任务作者在任务线程里 AskUserQuestion 时，server 把同一组问题追加成一张
// displayType:'event' 的卡片到**舱主会话**（activity.payload.authorAsk）。
// 用户不用切对话，就在汐音这条 chat 里把问题答完：
//
//   · 卡片复用 AskUserQuestionCard（选项 / 多选 / 其他 / 先讨论），所以格式与
//     任务线程里的问题卡逐字一致（答案正文 = 「用户回答了以下问题：…」）；
//   · 答案由这里**直接转发给作者线程**（后台消费 SSE，不切当前会话），作者
//     接着写 spec；主会话零 LLM；
//   · 选择写回卡片 metadata（recordCardDecision），刷新/换设备后卡片只读，
//     不会又变回可点。
//
// 已知边界（2026-11-16 并发修订）：作者线程可能正被别的信号唤醒而处在流式中，
// 服务端会以 409 拒绝这一轮。旧实现先标「已回答」再转发，答案会静默丢失；
// 现在改为「转发成功才落地」：忙则退避重试（2s / 5s），仍失败就保持可点并
// 明确提示「再点一次」。多条待答卡互不影响，各答各的。

import { useCallback, useState } from 'react'
import { toast } from 'sonner'
import { CheckCircle2, MessageSquare } from 'lucide-react'
import type { AgentMessage } from '@/lib/agent/types'
import type { ChatMessage } from '@/lib/types'
import { chatStream, recordCardDecision } from '@/lib/agent/api'
import { AskUserQuestionCard } from '@/components/workspace/chat/ask-user-question-card'
import { openTaskInChat } from '@/components/cabin/modules/ui'

interface AuthorAskPayload {
  authorAsk?: boolean
  authorSessionId?: string
  askMessageId?: string
  taskId?: string
  taskName?: string
  questions?: unknown
}

const RETRY_DELAYS = [2_000, 5_000]

/** 送进作者线程一轮；只等「已被受理」的信号（首块或被拒），不等整轮跑完。 */
function forwardOnce(authorSessionId: string, content: string): Promise<void> {
  const conn = chatStream(authorSessionId, content)
  return new Promise<void>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      // 4s 内既没被拒也没出首块：视为已受理，继续在后台读。
      void (async () => {
        try {
          for (;;) { const { done } = await conn.reader.read(); if (done) break }
        } catch { /* 受理后的读失败不影响送达 */ }
      })()
      resolve()
    }, 4_000)
    conn.reader.read().then(({ done }) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      void (async () => {
        try {
          if (done) return
          for (;;) { const { done: d } = await conn.reader.read(); if (d) break }
        } catch { /* 同上 */ }
      })()
      resolve()
    }).catch((err: unknown) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(err)
    })
  })
}

async function forwardWithRetry(authorSessionId: string, content: string): Promise<void> {
  let last: unknown = null
  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    try {
      await forwardOnce(authorSessionId, content)
      return
    } catch (err) {
      last = err
      const delay = RETRY_DELAYS[attempt]
      if (delay == null) break
      await new Promise((r) => setTimeout(r, delay))
    }
  }
  throw last instanceof Error ? last : new Error('回答发送失败')
}

export function AuthorAskCard({ message }: { message: AgentMessage }) {
  const activity = message.activity
  const payload = (activity?.payload ?? {}) as AuthorAskPayload
  const [answered, setAnswered] = useState(!!activity?.decision)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)

  const answer = useCallback(async (content: string) => {
    const authorSessionId = payload.authorSessionId
    if (!authorSessionId) {
      toast.error('缺少作者线程，暂时无法就地回答')
      return
    }
    setBusy(true)
    setFailed(false)
    try {
      // 先把答案送进作者线程；受理成功后才写「已回答」，避免静默丢答案。
      await forwardWithRetry(authorSessionId, content)
      void recordCardDecision(message.id, { actionId: 'answer_author_ask', label: '已回答' })
        .catch(() => {})
      setAnswered(true)
      window.dispatchEvent(new CustomEvent('octopus:author-ask-answered', {
        detail: { askMessageId: payload.askMessageId ?? message.id },
      }))
      toast.success('已回答 · 任务作者继续推进')
    } catch {
      setFailed(true)
      toast.error('作者线程正忙，答案没有送达 —— 请再点一次提交')
    } finally {
      setBusy(false)
    }
  }, [message.id, payload.authorSessionId, payload.askMessageId])

  const taskName = payload.taskName ?? '任务'
  const anchorId = `author-ask-${payload.askMessageId ?? message.id}`

  if (answered) {
    return (
      <div
        id={anchorId}
        data-author-task={payload.taskId ?? undefined}
        data-testid="author-ask-card"
        data-answered="true"
        className="mb-4 max-w-[90%] rounded-[14px] border-[2.5px] border-pop-bd bg-pop-green-soft px-4 py-3 text-sm text-pop-ink shadow-pop"
      >
        <div className="flex items-center gap-2">
          <CheckCircle2 className="size-4 shrink-0 text-pop-green" />
          <span>已回答 · {taskName}的作者继续推进</span>
        </div>
      </div>
    )
  }

  // 没有作者线程 / 问题体（旧数据）：给一条可点的退路，而不是一张死卡。
  const questions = payload.questions
  if (!payload.authorSessionId || !questions) {
    return (
      <div
        id={anchorId}
        data-author-task={payload.taskId ?? undefined}
        data-testid="author-ask-card"
        className="mb-4 max-w-[90%] rounded-[14px] border-[2.5px] border-pop-bd bg-pop-paper px-4 py-3 text-sm text-pop-ink shadow-pop"
      >
        <div className="mb-2 flex items-center gap-2 text-[11px] text-pop-dim">
          <MessageSquare className="size-3" />
          {taskName}的作者在问你
        </div>
        <div className="text-pop-ink/80">这张提问卡缺少转发信息，请去任务线程回答。</div>
        {payload.taskId && (
          <button
            type="button"
            className="mt-2 text-[11.5px] font-bold text-pop-cyan hover:underline"
            onClick={() => openTaskInChat(payload.taskId as string)}
          >
            去任务对话 →
          </button>
        )}
      </div>
    )
  }

  const synthetic: ChatMessage = {
    id: message.id,
    sessionId: message.session_id,
    role: 'assistant',
    displayType: 'ask_user_question',
    content: '',
    timestamp: message.created_at,
    toolCallId: `author-ask-${message.id}`,
    toolName: 'AskUserQuestion',
    toolInput: questions,
    toolStatus: 'done',
  }

  return (
    <div
      id={anchorId}
      data-author-task={payload.taskId ?? undefined}
      data-testid="author-ask-card"
      className="mb-2"
    >
      <div className="mb-1 flex items-center gap-2 text-[11px] text-pop-dim">
        <MessageSquare className="size-3" />
        {taskName}的作者在问你
      </div>
      <AskUserQuestionCard message={synthetic} onAnswer={answer} disabled={busy} hideChatAbout />
      {failed && (
        <div data-testid="author-ask-failed" className="mt-1 text-[11px] text-pop-red">
          答案没有送达：作者线程正在忙。请再点一次提交（会自动重试）。
        </div>
      )}
    </div>
  )
}
