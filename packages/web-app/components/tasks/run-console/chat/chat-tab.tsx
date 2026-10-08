// packages/web-app/components/tasks/run-console/chat/chat-tab.tsx
//
// 票 07 —— 统一壳「💬 对话」页签本体。三形态同一组件按任务态换语义（spec：
// 三种形态全走 S1 一口）：
//   quick-edit（待验收默认页）—— 小改直接说：POST /api/tasks/:id/chat（SSE，帧形
//     与 ws-chat 同构，复用 applyChunkToMessages/parseSSEStream 单源），回复里的
//     Edit/Write 落工具卡（⚙ 编辑 <file> +a −b [查看 diff]），尾帧 quick_edit_commit
//     计数上抛给壳 →「≡ 变更」💬chat 徽标 + ×N chip（03 契约 rowDecor/toolbarExtra）。
//     大改劝退是 persona（模型）的事，UI 只认回复落词：带「↩ 打回 · 派 task-fix
//     （已带指令草稿）」按钮 → 点击把该条回复原文交回 05 打回框单 textarea。
//   takeover（票 08 在此组件上扩展）—— 同通道换口吻（欢迎语/placeholder）。
//   fixing（修复轮追加指令）—— 不读 doer 会话（两本账不串台）；消息 = ⚑ 追加干预，
//     走 06 的暂停→注入通道（回调由壳接线 resumeTask(id, intervention)）；头部
//     明示「⚙ task-fix 执行中」。
//
// ADR-0025 会话两面性：这里只说「做」面 —— 端点/读取全部 task 级或 doer 会话，
// 不触碰 source_chat/task-author。

"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import type { ChatMessage } from "@/lib/types"
import { getTaskChatBinding, getDoerChatHistory } from "@/lib/tasks-api"
import { getServerUrl } from "@/lib/server-config"
import { applyChunkToMessages, parseSSEStream } from "@/components/workspace/chat/apply-chunk"
import { INTERVENTION_MAX, isOverLimit, interventionLineText, type InterventionRow } from "../intervention"
import {
  type ChatForm, chatCopy, classifyToolCall, detectEscalationReply, buildRejectPrefill,
  deriveQuickEditFiles, describeFrameError, type ChatEditsView,
} from "./chat-model"

/** quick_edit_commit 尾帧载荷（票01 契约：repo/branch/commit/message 逐仓一枚）。 */
export interface QuickEditCommitInfo { repo: string; branch: string; commit: string; message: string }

export interface TaskChatTabProps {
  taskId: string
  form: ChatForm
  /** quick-edit/takeover：快改视图（commit 数 + 文件）变化时上抛（壳喂 FilesTab）。 */
  onEditsChange?: (v: ChatEditsView) => void
  /** quick_edit_commit 尾帧到达 —— 壳据此 bump「≡ 变更」节拍（新 commit 立现）。 */
  onQuickEditCommit?: (c: QuickEditCommitInfo) => void
  /** 「查看 diff」→ 壳切「≡ 变更」页并揭示该行（03 rowDecor 之外的跳链）。 */
  onJumpToDiff?: (file: string) => void
  /** 劝退打回：把回复原文（指令草稿）交给壳 → AcceptanceSurface.openReject 预填。 */
  onRejectDraft?: (draft: string) => void
  /** fixing 形态：既有 ⚑ 行（壳从 agent-events 抽取，与日志页签同源）。 */
  interventions?: readonly InterventionRow[]
  /** fixing 形态：发消息 = 追加干预（壳接线 06 暂停→注入通道）。 */
  onInterventionSend?: (text: string) => Promise<void>
}

const BUBBLE = "max-w-[85%] whitespace-pre-wrap break-words rounded-[14px] border-[1.5px] border-pop-bd px-3 py-2 font-mono text-[11.5px] leading-relaxed shadow-pop-sm"

export function TaskChatTab({
  taskId, form, onEditsChange, onQuickEditCommit, onJumpToDiff, onRejectDraft, interventions, onInterventionSend,
}: TaskChatTabProps) {
  const copy = chatCopy(form)
  const isFixing = form === "fixing"

  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [bindingOk, setBindingOk] = useState(false)
  const [unavailable, setUnavailable] = useState<string | null>(null)
  const [streaming, setStreaming] = useState(false)
  const [draft, setDraft] = useState("")
  // quick_edit_commit 尾帧计数走 state（与 messages 同一效应发布视图 —— 用 ref
  // 会在流回调里读到过期闭包，徽标与 ×N 说谎）。
  const [commitCount, setCommitCount] = useState(0)
  const logRef = useRef<HTMLDivElement | null>(null)
  // fixing 形态的本地回执行（server ⚑ 行刷新后由 props 接续；先落版面不为谎言 ——
  // 「已发送」的真相是「已提交给注入通道」）。
  const [localIv, setLocalIv] = useState<InterventionRow[]>([])

  // ── doer 会话懒建 + 历史回放（quick-edit / takeover）──────────────────
  useEffect(() => {
    if (isFixing) return
    let cancelled = false
    setBindingOk(false); setUnavailable(null); setMessages([]); setCommitCount(0)
    getTaskChatBinding(taskId)
      .then((b) => {
        if (cancelled) return
        setBindingOk(true)
        return getDoerChatHistory(b.workspace_id, b.session_id)
          .then((msgs) => { if (!cancelled) setMessages(msgs) })
          .catch(() => { /* 历史读不到不拦对话 —— 会话本体已就绪 */ })
      })
      .catch((e: unknown) => {
        if (cancelled) return
        setUnavailable(e instanceof Error ? e.message : String(e))
      })
    return () => { cancelled = true }
  }, [taskId, isFixing])

  // 快改视图上抛（文件=工具卡单源 derive；commits=本会话 quick_edit_commit 尾帧数）。
  useEffect(() => {
    if (isFixing) return
    onEditsChange?.({ commits: commitCount, files: deriveQuickEditFiles(messages) })
  }, [isFixing, commitCount, messages, onEditsChange])

  // 跟脚：新消息滚到底（原型 scrollChat）。
  useEffect(() => { const el = logRef.current; if (el) el.scrollTop = el.scrollHeight }, [messages, streaming, localIv])

  const send = useCallback(async () => {
    const text = draft.trim()
    if (!text || streaming) return
    if (isFixing) {
      setStreaming(true)
      try {
        await onInterventionSend?.(text)
        setLocalIv((prev) => [...prev, { nodeId: "", nodeName: "task-fix", text, at: new Date().toISOString() }])
        setDraft("")
      } catch (e: unknown) {
        toast.error(e instanceof Error ? e.message : "追加指令注入失败")
      } finally {
        setStreaming(false)
      }
      return
    }
    const userMsg: ChatMessage = {
      id: `user-${Date.now()}`, sessionId: "", role: "user", displayType: "user",
      content: text, timestamp: new Date().toISOString(),
    }
    setMessages((prev) => [...prev, userMsg])
    setDraft("")
    setStreaming(true)
    try {
      const res = await fetch(`${getServerUrl()}/api/tasks/${taskId}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: text }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}) ) as { error?: string }
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      const reader = res.body?.getReader()
      if (!reader) throw new Error("无法读取响应流")
      await parseSSEStream(reader, (frame) => {
        const type = frame.type as string | undefined
        if (type === "quick_edit_commit") {
          setCommitCount((c) => c + 1)
          onQuickEditCommit?.({
            repo: String(frame.repo ?? ""), branch: String(frame.branch ?? ""),
            commit: String(frame.commit ?? ""), message: String(frame.message ?? ""),
          })
          return
        }
        if (type === "error") { toast.error(describeFrameError(frame)); return }
        setMessages((prev) => applyChunkToMessages(prev, frame))
      })
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "发送失败")
    } finally {
      setStreaming(false)
    }
  }, [draft, streaming, isFixing, onInterventionSend, onQuickEditCommit, taskId])

  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send() }
  }, [send])

  // ── fixing：⚑ 历史 + 本地回执 ─────────────────────────────────────────
  if (isFixing) {
    const rows = [...(interventions ?? []), ...localIv]
    const over = isOverLimit(draft)
    return (
      <div className="flex min-h-0 flex-1 flex-col" data-testid="task-chat-tab" data-chat-form="fixing">
        <div
          className="shrink-0 border-b-[1.5px] border-pop-bd bg-pop-cyan-soft px-4 py-2 font-mono text-[11px] font-black text-pop-cyan"
          data-testid="fixing-banner"
        >
          ⚙ task-fix 执行中 —— {copy.hint}
        </div>
        <div ref={logRef} className="min-h-0 flex-1 space-y-2 overflow-y-auto p-4" data-testid="fixing-intervention-log">
          <div className={`${BUBBLE} self-start bg-pop-paper text-pop-ink`}>
            <div className="mb-1 text-[9.5px] font-black text-pop-purple">task-doer · 修复轮</div>
            {copy.welcome}
          </div>
          {rows.map((r, i) => (
            <div key={`${r.at}-${i}`} data-testid="fixing-intervention-line"
              className="self-start truncate rounded-lg border-[1.5px] border-pop-pink/50 bg-pop-pink-soft px-2 py-1 font-mono text-[11px] text-pop-pink"
              title={interventionLineText(r)}
            >
              {interventionLineText(r)}
            </div>
          ))}
        </div>
        <div className="flex shrink-0 items-end gap-2 border-t-[1.5px] border-pop-bd bg-pop-idle p-2.5">
          <textarea
            data-testid="fixing-input"
            className="min-h-[52px] flex-1 resize-none rounded-[11px] border-[1.5px] border-pop-bd bg-pop-inset px-2.5 py-2 font-mono text-[11px] text-pop-ink outline-none focus:border-pop-cyan"
            placeholder={copy.placeholder}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            disabled={streaming}
          />
          <div className="flex flex-col items-end gap-1">
            {over && <span className="font-mono text-[9.5px] font-black text-pop-red">≤{INTERVENTION_MAX} 字（服务端 400 同额）</span>}
            <button
              data-testid="fixing-send"
              onClick={() => void send()}
              disabled={streaming || !draft.trim() || over}
              className="rounded-[11px] border-[1.5px] border-pop-cyan bg-pop-cyan px-3 py-1.5 font-mono text-[11px] font-black text-pop-bg disabled:opacity-50"
            >
              {streaming ? "注入中…" : "⚑ 注入追加指令 ↵"}
            </button>
          </div>
        </div>
      </div>
    )
  }

  // ── quick-edit / takeover：doer 整屏对话 ──────────────────────────────
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="task-chat-tab" data-chat-form={form}>
      <div className="flex shrink-0 items-center gap-2 border-b-[1.5px] border-pop-bd px-4 py-2 font-mono">
        <span className="text-[11.5px] font-black text-pop-ink">{copy.header}</span>
        <span className="text-[9.5px] text-pop-dim">{copy.hint}</span>
      </div>
      {unavailable && (
        <div className="mx-4 mt-3 rounded-[10px] border-[1.5px] border-pop-bd bg-pop-amber-soft px-3 py-2 font-mono text-[10.5px] font-black text-pop-amber" data-testid="chat-unavailable">
          {unavailable}
        </div>
      )}
      <div ref={logRef} className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto p-4" data-testid="chat-log">
        {messages.length === 0 && !unavailable && (
          <div className={`${BUBBLE} self-start bg-pop-paper text-pop-ink`}>
            <div className="mb-1 text-[9.5px] font-black text-pop-purple">task-doer ✎</div>
            {copy.welcome}
          </div>
        )}
        {messages.map((m) => {
          if (m.displayType === "user") {
            return <div key={m.id} data-testid="chat-msg-user" className={`${BUBBLE} self-end bg-pop-yellow font-bold text-pop-bg`}>{m.content}</div>
          }
          if (m.displayType === "thinking") return null
          if (m.displayType === "tool_call") {
            const card = classifyToolCall(m.toolName, m.toolInput)
            if (!card) return null
            if (card.kind === "question") {
              return (
                <div key={m.id} className={`${BUBBLE} self-start bg-pop-paper text-pop-ink`} data-testid="chat-msg-question">
                  <div className="mb-1 text-[9.5px] font-black text-pop-purple">task-doer ✎ 提问</div>
                  {card.text}
                </div>
              )
            }
            const base = card.file.split("/").pop() ?? card.file
            return (
              <div key={m.id} data-testid="chat-tool-card"
                className="self-start rounded-[11px] border-[1.5px] border-pop-purple/40 bg-pop-purple-soft px-2.5 py-1.5 font-mono text-[10px] text-pop-purple"
              >
                ⚙ {card.verb} <b className="text-pop-ink">{base}</b>
                {card.adds != null && <span className="ml-1.5 text-pop-green">+{card.adds}</span>}
                {card.dels != null && <span className="ml-1 text-pop-red">−{card.dels}</span>}
                {m.toolStatus === "running" && <span className="ml-1.5 text-pop-dim">…</span>}
                {onJumpToDiff && (
                  <button
                    data-testid="chat-tool-diff"
                    onClick={() => onJumpToDiff(card.file)}
                    className="ml-2 text-pop-cyan underline underline-offset-2"
                  >
                    查看 diff
                  </button>
                )}
              </div>
            )
          }
          if (m.displayType === "text" && m.content) {
            const escalation = form === "quick-edit" && detectEscalationReply(m.content)
            return (
              <div key={m.id} data-testid="chat-msg-ai" className={`${BUBBLE} self-start bg-pop-paper text-pop-ink`}>
                <div className="mb-1 text-[9.5px] font-black text-pop-purple">task-doer ✎</div>
                {m.content}
                {escalation && (
                  <div>
                    <button
                      data-testid="chat-reject-draft"
                      onClick={() => onRejectDraft?.(buildRejectPrefill(m.content))}
                      className="mt-2 rounded-[10px] border-[1.5px] border-pop-pink/55 bg-pop-pink-soft px-2.5 py-1 font-mono text-[10.5px] font-black text-pop-pink hover:bg-pop-pink hover:text-pop-bg"
                    >
                      ↩ 打回 · 派 task-fix（已带指令草稿）
                    </button>
                  </div>
                )}
              </div>
            )
          }
          return null
        })}
        {streaming && !messages.some((m) => m.displayType === "text") && (
          <div className="self-start font-mono text-[10.5px] text-pop-dim" data-testid="chat-typing">
            ◍ ◍ ◍ <i className="pop-blink not-italic">正在改…</i>
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-end gap-2 border-t-[1.5px] border-pop-bd bg-pop-idle p-2.5">
        <textarea
          data-testid="chat-input"
          className="min-h-[52px] flex-1 resize-none rounded-[11px] border-[1.5px] border-pop-bd bg-pop-inset px-2.5 py-2 font-mono text-[11px] text-pop-ink outline-none focus:border-pop-cyan"
          placeholder={copy.placeholder}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={streaming || !bindingOk || unavailable !== null}
        />
        <button
          data-testid="chat-send"
          onClick={() => void send()}
          disabled={streaming || !draft.trim() || !bindingOk || unavailable !== null}
          className="rounded-[11px] border-[1.5px] border-pop-cyan bg-pop-cyan px-3 py-1.5 font-mono text-[11px] font-black text-pop-bg disabled:opacity-50"
        >
          {streaming ? "◍ 正在改…" : "发送 ↵"}
        </button>
      </div>
    </div>
  )
}
