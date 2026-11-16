'use client'

// 提问作答的提交管线（design 26 §3.5 / §5.1）—— 从 AuthorAskCard 抽出，
// 主 chat 的卡片与问答窗共用同一套语义：
//   · 有决策票据 → POST /api/cabins/:id/decisions（票据 askId 唯一权威）；
//   · 成功立刻给回执，不等汐音转达；
//   · 409 已答 = 幂等命中；400 = 明确拒绝（不偷偷转发）；
//   · 旧服务端 404/503：卡片（threadFallback=true）直发作者线程；
//     问答窗（threadFallback=false）提示「去任务线程回答」，不偷发。

import { useCallback, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { chatStream, recordCardDecision } from '@/lib/agent/api'
import { CabinDecisionError, submitCabinDecision } from '@/lib/cabin-api'

const RETRY_DELAYS = [2_000, 5_000]

/** 送进作者线程一轮；只等「已被受理」的信号（首块或被拒），不等整轮跑完。 */
function forwardOnce(authorSessionId: string, content: string): Promise<void> {
  const conn = chatStream(authorSessionId, content)
  return new Promise<void>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
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

/** 从「用户回答了以下问题」正文里取第一个 → 后的选择（逐字）与其余补充。 */
export function parseAnsweredChoice(content: string): { choice: string; note?: string } {
  const lines = content.split('\n')
  const arrows = lines
    .map((line) => /^\s*→\s*(.+)$/.exec(line)?.[1]?.trim())
    .filter((v): v is string => !!v)
  const choice = arrows[0] ?? content.trim()
  const note = arrows.length > 1 ? arrows.slice(1).join('；') : undefined
  return { choice, ...(note ? { note } : {}) }
}

export interface AskSubmitOptions {
  cabinId: string | null
  askId: string
  authorSessionId?: string
  handle?: string
  /** 旧路径回执文案用（`✓ 已答 · #1 任务名：选择`）。 */
  taskName?: string
  /** 只在 subject.kind === 'task' 时带（与既有卡一致）。 */
  taskId?: string
  /** 可用选项 label：用于判定 source card / composer。 */
  optionLabels?: string[]
  /** 舱主会话镜像卡 message.id（旧路径 recordCardDecision 的锚点）。 */
  messageId?: string
  /** true（默认）：旧服务端 / 不可达时直发作者线程。 */
  threadFallback?: boolean
}

export interface AskSubmitOutcome {
  ok: boolean
  already?: boolean
  receipt?: string
  choice?: string
  /** 需要人去任务线程回答（无票据且不允许透明直发）。 */
  needsThread?: boolean
  error?: string
}

export function useAskSubmit(options: AskSubmitOptions) {
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)

  const {
    cabinId, askId, authorSessionId, handle, taskId, messageId, threadFallback = true, taskName,
  } = options
  const optionLabels = useMemo(() => options.optionLabels ?? [], [options.optionLabels])

  const announce = useCallback((choice: string) => {
    window.dispatchEvent(new CustomEvent('octopus:author-ask-answered', {
      detail: { askMessageId: askId, ...(handle ? { handle } : {}), choice },
    }))
  }, [askId, handle])

  const submit = useCallback(async (content: string): Promise<AskSubmitOutcome> => {
    setBusy(true)
    setFailed(null)
    const { choice, note } = parseAnsweredChoice(content)
    // Other / 自由文本不是选项选择：走 composer 语义（服务端放宽逐字命中）。
    const isOption = optionLabels.some((label) => label === choice)
    try {
      if (cabinId) {
        try {
          const res = await submitCabinDecision(cabinId, {
            askId,
            choice,
            ...(note ? { note } : {}),
            source: isOption ? 'card' : 'composer',
            focusAtSubmit: askId,
            ...(taskId ? { taskId } : {}),
          })
          toast.success(res.already ? res.receipt.line : '已记下，汐音正在转达')
          announce(choice)
          return { ok: true, already: res.already, receipt: res.receipt.line, choice }
        } catch (err) {
          // 服务端明确拒绝（归属 / 选项 / 已过期）：不要把答案偷偷发到别处。
          if (err instanceof CabinDecisionError && err.status !== 404 && err.status !== 503) {
            if (err.status === 409 && /已经答过|已答/.test(err.message)) {
              const receipt = `已经答过（${err.message}）`
              announce(choice)
              return { ok: true, already: true, receipt, choice }
            }
            setFailed(err.message)
            toast.error(err.message)
            return { ok: false, error: err.message, choice }
          }
          // 旧服务端 / 网络不可达：落到兼容路径（窗不允许直发时提示去线程）。
          if (!threadFallback || !authorSessionId) {
            const error = '这个提问还不在决策端点上 —— 请去任务线程回答'
            setFailed(error)
            return { ok: false, needsThread: true, error, choice }
          }
        }
      } else if (!threadFallback || !authorSessionId) {
        const error = '缺少作者线程，暂时无法就地回答'
        setFailed(error)
        toast.error(error)
        return { ok: false, needsThread: true, error, choice }
      }

      // 兼容路径：直发作者线程（只给主 chat 里那张卡用；问答窗默认不走）。
      if (!authorSessionId) {
        const error = '缺少作者线程，暂时无法就地回答'
        setFailed(error)
        toast.error(error)
        return { ok: false, needsThread: true, error, choice }
      }
      await forwardWithRetry(authorSessionId, content)
      if (messageId) {
        void recordCardDecision(messageId, { actionId: 'answer_author_ask', label: '已回答' })
          .catch(() => {})
      }
      const receipt = `✓ 已答 · ${handle ? `${handle} ` : ''}${taskName ?? '任务'}：${choice}（已直接转达）`
      announce(choice)
      toast.success('已回答 · 任务作者继续推进')
      return { ok: true, receipt, choice }
    } catch {
      const error = '作者线程正忙，答案没有送达 —— 请再点一次提交'
      setFailed(error)
      toast.error(error)
      return { ok: false, error, choice }
    } finally {
      setBusy(false)
    }
  }, [announce, askId, authorSessionId, cabinId, handle, messageId, optionLabels, taskId, taskName, threadFallback])

  return { submit, busy, failed, setFailed }
}
