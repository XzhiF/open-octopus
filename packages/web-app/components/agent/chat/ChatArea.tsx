'use client'

import { useState, useRef, useEffect, useMemo, type ReactNode } from 'react'
import { Send, Square, MessageSquare, ChevronUp, ChevronDown } from 'lucide-react'
import type { AgentMessage, ToolCallRecord, ContextUsageData } from '@/lib/agent/types'
import type { StreamTimelineItem } from '@/hooks/useAgentChat'
import { AutoResizeTextarea } from '@/components/ui/auto-resize-textarea'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { formatTokenCount } from '@/lib/format'
import { ChatBubble } from './ChatBubble'
import { tuiEscapeGuard } from '@/lib/tui-escape'
import { TuiLive, TuiMessage } from './TuiTranscript'
import { ToolCallCard } from './ToolCallCard'
import { QuestionCard } from '@/components/workspace/chat/question-card'
import type { ChatMessage } from '@/lib/types'
import { StreamingIndicator } from './StreamingIndicator'
import { DangerConfirmCard } from './DangerConfirmCard'
import { EvolutionConfirmCard } from './EvolutionConfirmCard'
import { AgentEmptyState } from '../shared/AgentEmptyState'
import { ReviewCard } from '../knowledge/cards/ReviewCard'
import { MentionAutocomplete, parseMention } from './MentionAutocomplete'
import { SlashCommandAutocomplete, type SlashCommand } from './SlashCommandAutocomplete'

/** 状态色带皮肤:一态一糖果(静态 class 字面量,Tailwind JIT)。 */
const RIBBON_THEME: Record<'running' | 'waiting' | 'done' | 'error', {
  band: string; dot: string; text: string; sub: string
}> = {
  running: { band: 'bg-pop-purple-soft text-pop-purple', dot: 'bg-pop-purple', text: '⚡ 生成中', sub: '关闭弹窗不会中断' },
  waiting: { band: 'bg-pop-amber-soft text-pop-amber', dot: 'bg-pop-amber', text: '❓ 等待你的输入', sub: '回答上方问题即继续' },
  done: { band: 'bg-pop-green-soft text-pop-green', dot: 'bg-pop-green', text: '✓ 就绪', sub: '随时发送下一条' },
  error: { band: 'bg-pop-pink-soft text-pop-red', dot: 'bg-pop-red', text: '✕ 本轮出错', sub: '重新发送即可重试' },
}

interface ChatAreaProps {
  messages: AgentMessage[]
  streaming: boolean
  streamContent: string
  streamThinking: string
  isThinking: boolean
  toolCalls: ToolCallRecord[]
  /** Arrival-ordered thinking/text/tool timeline (useAgentChat). When passed,
   *  streaming renders interleaved (thinking as in-flow cards); when omitted,
   *  the legacy fixed-order layout (thinking top / tools / text) is used. */
  streamTimeline?: StreamTimelineItem[]
  pendingConfirm: {
    event_id: string
    type: 'dangerous_command' | 'evolution_major'
    operation: string
    detail: string
  } | null
  error: string | null
  statusMessage: string
  onSend: (message: string, opts?: { delegate_to?: string }) => void
  onStop: () => void
  onConfirm: (eventId: string, decision: 'accept' | 'reject') => void
  hasSession: boolean
  /** Current clone name for self-reference detection in @@mention */
  currentCloneName?: string | null
  /** Source badge for delegation responses */
  streamSource?: string | null
  /** Custom empty state title (default: "开始你的第一个对话") */
  emptyStateTitle?: string
  /** Custom empty state description (default: agent description) */
  emptyStateDescription?: string
  /** Hide empty state entirely (input stays at bottom) */
  hideEmptyState?: boolean
  reviewItems?: Array<{
    id: string
    type: 'rule'
    content: string
    source: string
    sourceLabel: string
    targetFile: string
    scope: string
    conflicts: Array<{ existingRule: string; conflictType: string }> | null
    confidence: number
  }>
  onReviewAction?: (id: string, action: 'approve' | 'reject' | 'defer' | 'edit') => void
  /** Available slash commands (from locked skill groups). When provided,
   *  typing `/` in the input opens an autocomplete dropdown. */
  commands?: SlashCommand[]
  /** Context window usage breakdown (from SDK getContextUsage). */
  contextUsage?: ContextUsageData | null
  /** Current model name (e.g. 'pro', 'pro-max', 'se'). */
  currentModel?: string
  /** Callback when user switches model. */
  onModelChange?: (model: string) => void
  /** 输入行左端的动作槽（草稿工作台把「专家咨询」小贴纸挂这里，替代独立辅助条）。 */
  composerLeading?: ReactNode
  /** 非流式时的输入框 placeholder（草稿工作台把「/ 调用技能」计数提示收编于此）。 */
  composerPlaceholder?: string
  /** TUI（claude-code 终端皮肤）变体 —— 任务草稿工作台专用（2026-09-24 改版）：
   *  等宽 transcript（❯/✳ 前缀 + ◌ 过程折叠）、⇧⏎ 排队 dock（≤3，done 即 flush）、
   *  busy 时输入不锁死（⏎=打断接管 / esc=打断 / esc·点击=队列退回）。 */
  tui?: boolean
  /** 打断接管（tui）：stop → 等服务端停 → 重发（useAgentChat.steer）。 */
  onSteer?: (message: string) => void
  /** steer 在途（stop→重发谷）：期间 done-flush 让闸，防接管消息被队首抢发。 */
  steerActiveRef?: React.MutableRefObject<boolean>
}

/** ⇧⏎ 排队上限（原型 chat-tui.html 拍板）。 */
const TUI_QUEUE_MAX = 3
const TUI_SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

export function ChatArea({
  messages, streaming, streamContent, streamThinking, isThinking, toolCalls, streamTimeline, pendingConfirm,
  error, statusMessage, onSend, onStop, onConfirm, hasSession, currentCloneName, streamSource,
  reviewItems, onReviewAction,
  emptyStateTitle, emptyStateDescription, hideEmptyState,
  commands, contextUsage, currentModel, onModelChange,
  composerLeading, composerPlaceholder,
  tui, onSteer, steerActiveRef,
}: ChatAreaProps) {
  const [input, setInput] = useState('')
  const [slashOpen, setSlashOpen] = useState(false)
  const [contextExpanded, setContextExpanded] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const unansweredAsk = useMemo(() => findUnansweredAsk(messages), [messages])

  // 🎪 状态色带（Memphis）：running/waiting/done/error 一眼可辨 —— 从既有
  // props 派生，无新数据链路。aborted 不单列（气泡内已有「中断」印记）。
  const hasAssistant = useMemo(() => messages.some((m) => m.role === 'assistant'), [messages])
  const chatState: 'running' | 'waiting' | 'done' | 'error' | 'idle' =
    streaming ? 'running'
      : error ? 'error'
        : (unansweredAsk || pendingConfirm) ? 'waiting'
          : hasAssistant ? 'done' : 'idle'

  // 「✓ 就绪」只作为**回合完成的闪现**存在:running→done 亮 5s 自动收;
  // 打开旧会话(直接以 done 进场)或不显示 —— 就绪是瞬时反馈,不是常驻横幅。
  const prevStateRef = useRef(chatState)
  const [doneFlash, setDoneFlash] = useState(false)
  useEffect(() => {
    const prev = prevStateRef.current
    prevStateRef.current = chatState
    if (chatState === 'done') {
      if (prev !== 'running') return
      setDoneFlash(true)
      const t = setTimeout(() => setDoneFlash(false), 5000)
      return () => clearTimeout(t)
    }
    setDoneFlash(false)
  }, [chatState])

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
    // streamTimeline / streamThinking in deps: thinking deltas (not just text)
    // should follow-scroll, in both timeline and legacy layouts.
  }, [messages, streamContent, toolCalls, streamTimeline, streamThinking])

  const handleSend = () => {
    if (!input.trim() || streaming) return
    const text = input.trim()

    // Parse @@mention
    const mention = parseMention(text)
    if (mention) {
      // Self-reference check
      if (mention.delegate_to === currentCloneName) {
        // Self-reference: send as normal message
        onSend(text)
      } else {
        // Delegation: send clean message with delegate_to
        onSend(mention.cleanMessage, { delegate_to: mention.delegate_to })
      }
    } else {
      onSend(text)
    }
    setInput('')
  }

  const handleMentionSelect = (cloneName: string) => {
    // Replace @@partial with @@clone-name
    setInput(prev => prev.replace(/@@[a-z0-9-]*$/, `@@${cloneName} `))
  }

  const handleSlashSelect = (commandName: string) => {
    // Replace entire input with /command (user continues typing the prompt)
    setInput(`/${commandName} `)
  }

  // ── TUI 排队 / steer（2026-09-24 草稿工作台改版，仅 tui 变体生效）──────
  // 语义（原型 chat-tui.html 拍板）：⇧⏎=排队（≤3，SDK done 立即 flush 队首）；
  // 有排队时 ⏎=继续加入排队；无排队 busy ⏎=打断接管（steer）；有排队 esc=队尾
  // 退回输入框（点击同效），无排队 esc=打断。
  const [queue, setQueueState] = useState<string[]>([])
  const queueRef = useRef<string[]>([])
  const setQueue = (next: string[]) => { queueRef.current = next; setQueueState(next) }
  const [queueHint, setQueueHint] = useState<string | null>(null)
  const dockRef = useRef<HTMLDivElement>(null)
  const turnStartedAtRef = useRef(0)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    if (!tui || !streaming) return
    const t = setInterval(() => setTick((v) => v + 1), 110)
    return () => clearInterval(t)
  }, [tui, streaming])
  void tick // busy 行（braille spinner + 计时）靠 tick 驱动重渲染

  const wasStreamingRef = useRef(streaming)
  useEffect(() => {
    const was = wasStreamingRef.current
    wasStreamingRef.current = streaming
    if (!tui) return
    if (!was && streaming) turnStartedAtRef.current = Date.now()
    // SDK done → 立即发队首（steer 在途的 false 谷不让发）
    if (was && !streaming && queueRef.current.length > 0 && !steerActiveRef?.current) {
      const [head, ...rest] = queueRef.current
      setQueue(rest)
      onSend(head)
    }
  }, [streaming, tui, onSend])

  const focusDockInput = () => {
    dockRef.current?.querySelector<HTMLTextAreaElement>('textarea')?.focus()
  }
  const pushQueue = (text: string) => {
    if (queueRef.current.length >= TUI_QUEUE_MAX) {
      setQueueHint(`队列已满（${TUI_QUEUE_MAX}）`)
      setTimeout(() => setQueueHint(null), 1400)
      return
    }
    setQueue([...queueRef.current, text])
  }
  const recallQueue = (i: number) => {
    const back = queueRef.current[i]
    setQueue(queueRef.current.filter((_, j) => j !== i))
    setInput((prev) => (prev.trim() ? `${back} ${prev}` : back))
    focusDockInput()
  }
  const handleTuiKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (slashOpen) return // 自动补全下拉打开时 Enter 归下拉
    const text = input.trim()
    if (e.key === 'Enter') {
      e.preventDefault()
      if (!text) return
      if (e.shiftKey) {
        setInput('')
        if (streaming) pushQueue(text)
        else handleSend()
        return
      }
      if (queue.length > 0) { setInput(''); pushQueue(text); return }
      if (streaming) {
        setInput('')
        if (onSteer) onSteer(text)
        else onStop()
        return
      }
      handleSend()
    } else if (e.key === 'Escape') {
      // 有排队 → 队尾退回输入框；无排队 busy → 打断；否则放行（弹窗 Esc 关闭）。
      if (queue.length > 0) { e.preventDefault(); e.stopPropagation(); recallQueue(queue.length - 1) }
      else if (streaming) { e.preventDefault(); e.stopPropagation(); onStop() }
    }
  }
  // Escape 仲裁：排队/生成中由本组件消费 Esc（Radix 捕获相早于 React，须先置位
  // 让宿主弹窗 preventDefault 放行），否则照常关窗。
  useEffect(() => {
    tuiEscapeGuard.active = !!tui && (queue.length > 0 || streaming)
    return () => { if (tui) tuiEscapeGuard.active = false }
  }, [tui, queue, streaming])

  const busyElapsed = streaming ? Math.max(0, (Date.now() - turnStartedAtRef.current) / 1000) : 0
  const busyPhase = toolCalls.some((tc) => tc.status === 'start' || tc.status === 'running' || tc.status === 'pending')
    ? 'exec' : 'thinking'
  const spinGlyph = TUI_SPIN[Math.floor(busyElapsed * 10) % TUI_SPIN.length]

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Content area */}
      {!hasSession ? (
        hideEmptyState ? (
          <div className="flex-1" />
        ) : (
          <AgentEmptyState
            icon={MessageSquare}
            title={emptyStateTitle ?? "开始你的第一个对话"}
            description={emptyStateDescription ?? "Agent 可以理解你的意图，自动编排工作流、管理记忆和分身。试试发送一条指令吧。"}
          />
        )
      ) : (
        <div ref={scrollRef} className="flex-1 overflow-y-auto">
          <div className={tui ? 'mx-auto max-w-4xl px-5 py-4 space-y-1.5 text-[12.5px] leading-relaxed' : 'max-w-3xl mx-auto px-4 py-4 space-y-2.5'}>
            {Array.from(new Map(messages.map(m => [m.id, m])).values()).map((msg) => (
              tui ? <TuiMessage key={msg.id} message={msg} /> : <ChatBubble key={msg.id} message={msg} />
            ))}

            {/* Streaming: interleaved timeline (2026-08-19 UX fix) — thinking /
                tool / text segments in ARRIVAL order. Thinking shows as
                in-flow cards (like tool calls) instead of one pinned top
                block; when the stream completes, the final ChatBubble merges
                thinking into its collapsible meta. TUI: same arrival order,
                terminal lines (◌ thinking / ▸ tool / ✳ text▊). */}
            {streaming && streamTimeline && streamTimeline.length > 0 && (tui ? (
              <TuiLive items={streamTimeline} toolCalls={toolCalls} />
            ) : (
              <>
                {streamTimeline.map((item) => {
                  if (item.kind === 'thinking') {
                    return <StreamingThinkingCard key={item.id} text={item.text} active={item.active} />
                  }
                  if (item.kind === 'tool') {
                    const tc = toolCalls.find((t) => t.id === item.id)
                    if (!tc) return null
                    // AskUserQuestion (2026-08-19): render the workspace
                    // QuestionCard (reused) — the answer is sent as the next
                    // user message, which resumes the provider session.
                    if (tc.name === 'AskUserQuestion') {
                      return (
                        <QuestionCard
                          key={item.id}
                          message={{ toolInput: tc.input } as ChatMessage}
                          onAnswer={(content) => onSend(content)}
                          disabled={streaming}
                        />
                      )
                    }
                    return <ToolCallCard key={item.id} toolCall={tc} />
                  }
                  return (
                    <div key={item.id}>
                      {streamSource && (
                        <div className="flex items-center gap-1.5 mb-1">
                          <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-4 bg-agent-primary/10 text-agent-primary border-agent-primary/20">
                            {streamSource}
                          </Badge>
                        </div>
                      )}
                      <ChatBubble
                        message={{
                          id: item.id,
                          session_id: '',
                          role: 'assistant',
                          content: item.text,
                          created_at: new Date().toISOString(),
                          is_summary: false,
                          is_compressed: false,
                          is_edited: false,
                        }}
                      />
                    </div>
                  )
                })}
              </>
            ))}

            {/* Legacy fixed-order layout for consumers without streamTimeline */}

            {/* Streaming: thinking first */}
            {streaming && !streamTimeline && !tui && streamThinking && (
              <div className="border-l-2 border-agent-divider pl-3 py-1">
                <div className="flex items-center gap-1 text-xs text-muted-foreground mb-1">
                  <span className="animate-pulse">💭</span> 思考中{isThinking ? '...' : ' (完成)'}
                </div>
                <AutoFollowPre text={streamThinking} />
              </div>
            )}

            {/* Streaming: tool calls second */}
            {streaming && !streamTimeline && !tui && toolCalls.length > 0 && (
              <div className="space-y-2">
                {Array.from(new Map(toolCalls.map(tc => [tc.id, tc])).values()).map((tc) => (
                  tc.name === 'AskUserQuestion' ? (
                    <QuestionCard
                      key={tc.id}
                      message={{ toolInput: tc.input } as ChatMessage}
                      onAnswer={(content) => onSend(content)}
                      disabled={streaming}
                    />
                  ) : (
                    <ToolCallCard key={tc.id} toolCall={tc} />
                  )
                ))}
              </div>
            )}

            {/* Streaming: text response last */}
            {streaming && !streamTimeline && !tui && streamContent && (
              <div>
                {streamSource && (
                  <div className="flex items-center gap-1.5 mb-1">
                    <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-4 bg-agent-primary/10 text-agent-primary border-agent-primary/20">
                      {streamSource}
                    </Badge>
                  </div>
                )}
                <ChatBubble
                  message={{
                    id: 'streaming',
                    session_id: '',
                    role: 'assistant',
                    content: streamContent,
                    created_at: new Date().toISOString(),
                    is_summary: false,
                    is_compressed: false,
                    is_edited: false,
                  }}
                />
              </div>
            )}

            {/* Status message */}
            {streaming && statusMessage && (
              <div className="text-xs text-muted-foreground italic">{statusMessage}</div>
            )}

            {/* Streaming indicator — only when no thinking and no content yet */}
            {streaming && !streamContent && !streamThinking && (
              <StreamingIndicator />
            )}

            {/* AskUserQuestion 回合后卡片（2026-09-09）：流式期间的 QuestionCard
                disabled 且 done 即随 timeline 卸载 —— 回合结束（provider 以
                deny 让模型停下等回答）后这里是唯一可点入口。答案走 onSend
                成为下一条 user 消息，clone 会话 resume 续流；用户一旦发言，
                findUnansweredAsk 反向扫描先见 user → 卡片自动消失。
                也覆盖重开弹窗/刷新后的恢复：持久化行 metadata.tool_calls。 */}
            {!streaming && unansweredAsk && (
              <QuestionCard
                key={unansweredAsk.key}
                message={{ toolInput: unansweredAsk.input } as ChatMessage}
                onAnswer={(content) => onSend(content)}
              />
            )}

            {/* Confirm cards */}
            {pendingConfirm && pendingConfirm.type === 'dangerous_command' && (
              <DangerConfirmCard
                eventId={pendingConfirm.event_id}
                operation={pendingConfirm.operation}
                detail={pendingConfirm.detail}
                onConfirm={(decision) => onConfirm(pendingConfirm.event_id, decision)}
              />
            )}
            {pendingConfirm && pendingConfirm.type === 'evolution_major' && (
              <EvolutionConfirmCard
                eventId={pendingConfirm.event_id}
                detail={pendingConfirm.detail}
                onConfirm={(decision) => onConfirm(pendingConfirm.event_id, decision)}
              />
            )}

            {/* Knowledge cards: review items */}
            {reviewItems && reviewItems.length > 0 && onReviewAction && (
              <div className="space-y-2">
                {reviewItems.map((item) => (
                  <ReviewCard
                    key={item.id}
                    item={item}
                    onAction={onReviewAction}
                  />
                ))}
              </div>
            )}

            {/* Error */}
            {error && (
              <div className="rounded-xl border-2 border-pop-bd bg-pop-pink-soft p-3 text-sm font-bold text-pop-red shadow-pop-sm">
                {error}
              </div>
            )}
          </div>
        </div>
      )}

      {/* 🎪 状态色带 — composer 上方的贴纸 pill(derived from props,无新链路);
          done 态仅在回合刚完成时闪现(见 doneFlash),不再常驻。 */}
      {hasSession && !tui && chatState !== 'idle' && !(chatState === 'done' && !doneFlash) && (
        <div
          data-chat-state={chatState}
          className={cn(
            'mx-4 mt-2 flex shrink-0 items-center gap-2 rounded-full border-2 border-pop-bd px-3 py-1 text-xs font-black shadow-pop-sm',
            RIBBON_THEME[chatState].band,
          )}
        >
          <span className={cn(
            'size-[9px] shrink-0 rounded-[3px] border-[1.5px] border-pop-bd',
            RIBBON_THEME[chatState].dot,
            chatState === 'running' && 'pop-pulse',
          )} />
          {RIBBON_THEME[chatState].text}
          <span className="truncate font-medium opacity-70">{RIBBON_THEME[chatState].sub}</span>
        </div>
      )}

      {/* Input area — always visible。TUI 变体（草稿工作台）：排队 dock + ❯ 单行
          输入（busy 不锁死）+ 提示行 + 下方控件条（专家咨询│model│ctx）。 */}
      {tui ? (
        <div ref={dockRef} className="shrink-0 border-t border-pop-bd bg-pop-bg px-4 pb-3 pt-2" data-tui-dock>
          <div className="relative mx-auto max-w-4xl">
            <MentionAutocomplete
              inputValue={input}
              onSelect={handleMentionSelect}
              textareaRef={null}
              currentCloneName={currentCloneName}
            />
            {commands && commands.length > 0 && (
              <SlashCommandAutocomplete
                inputValue={input}
                commands={commands}
                onSelect={handleSlashSelect}
                onOpenChange={setSlashOpen}
              />
            )}
            {queue.length > 0 && (
              <div className="mb-1.5 space-y-0.5" data-tui-queue>
                {queue.map((q, i) => (
                  <button
                    key={`${i}:${q.slice(0, 12)}`}
                    type="button"
                    onClick={() => recallQueue(i)}
                    title="点击退回输入框"
                    data-tui-queue-item={i}
                    className="flex w-full items-center gap-2 rounded px-1 text-left text-[11px] text-pop-dim transition-colors hover:text-pop-amber"
                  >
                    <span className="w-[72px] shrink-0 text-pop-pink">⧗ queued</span>
                    <span className="shrink-0 text-pop-pink">{i + 1}/{TUI_QUEUE_MAX}</span>
                    <span className="min-w-0 flex-1 truncate">{q}</span>
                    <span className="ml-auto shrink-0 text-[10px]">esc/点击 → 退回输入框</span>
                  </button>
                ))}
              </div>
            )}
            <div
              data-composer-block
              className="rounded-lg border border-pop-bd bg-pop-paper px-2.5 py-1.5 transition-colors focus-within:border-pop-pink"
            >
              <div className="flex items-start gap-2">
                <span aria-hidden className="shrink-0 font-bold leading-6 text-pop-pink">❯</span>
                {/* maxRows=11（≈220px 才内滚）：不写 CSS max-height —— 会钳住
                    scrollHeight 导致几行就不再长高（原型 v2 实测 bug）。 */}
                <AutoResizeTextarea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleTuiKeyDown}
                  maxRows={11}
                  disabled={!!pendingConfirm}
                  placeholder={
                    queue.length > 0
                      ? '继续输入 —— ⏎/⇧⏎ 都会加入排队'
                      : streaming
                        ? '输入新指令 —— ⏎ 打断接管 · ⇧⏎ 不打断排队'
                        : composerPlaceholder ?? '问 task-author…　⏎ 发送 · ⇧⏎ 排队'
                  }
                  className="min-h-6 flex-1 rounded-none border-0 bg-transparent px-0 py-1.5 text-[12.5px] text-pop-ink shadow-none placeholder:text-pop-dim focus-visible:ring-0"
                />
                <span className="shrink-0 pt-1">
                  {streaming ? (
                    <button
                      type="button"
                      onClick={onStop}
                      title="停止（esc 同效）"
                      data-tui-stop
                      className="grid size-6 place-items-center rounded-md border border-pop-bd text-[10px] text-pop-red transition-colors hover:border-pop-red"
                    >
                      ■
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={handleSend}
                      disabled={!input.trim()}
                      title="发送（⏎ 同效）"
                      data-tui-send
                      className="grid size-6 place-items-center rounded-md border border-pop-bd bg-pop-pink text-[10px] font-bold text-[#151413] transition-opacity disabled:opacity-40"
                    >
                      ⏎
                    </button>
                  )}
                </span>
              </div>
              <div className="mt-0.5 flex items-center gap-2 px-6 text-[10.5px] text-pop-dim">
                {queueHint ? (
                  <span className="text-pop-red" data-tui-hint>{queueHint}</span>
                ) : queue.length > 0 ? (
                  <span data-tui-hint>⏎ 继续排队 · ⇧⏎ 排队 · esc 退回输入框 <span className="opacity-70">队列 {queue.length}/{TUI_QUEUE_MAX} · done 即发</span></span>
                ) : streaming ? (
                  <span data-tui-hint>⏎ 打断并接管 · ⇧⏎ 不打断，排队 · esc 打断</span>
                ) : (
                  <span data-tui-hint>⏎ 发送 · ⇧⏎ 排队 · ⇧⏎⇧⏎ 连排</span>
                )}
                {streaming && (
                  <span className="ml-auto shrink-0 text-pop-amber" data-tui-busy>
                    <span className="text-pop-pink">{spinGlyph}</span> {busyPhase} {busyElapsed.toFixed(1)}s {/* fmt-ok: 终端 busy 行秒数，非全站计时器 */}
                  </span>
                )}
              </div>
            </div>
            {/* 控件条：专家咨询 / model 保留在输入框下方（v3 原型拍板） */}
            <div className="mt-1.5 flex items-center gap-2 border-t border-pop-bd pt-1.5 text-[11px] text-pop-dim" data-tui-ctrlbar>
              {composerLeading && (
                <>
                  <span className="flex shrink-0 items-center gap-1.5" data-composer-leading>{composerLeading}</span>
                  <span aria-hidden className="text-pop-bd">│</span>
                </>
              )}
              {currentModel && (
                <span className="flex shrink-0 items-center gap-1">
                  <span>model</span>
                  {onModelChange ? (
                    <select
                      value={currentModel}
                      onChange={(e) => onModelChange(e.target.value)}
                      data-tui-model-select
                      className="cursor-pointer appearance-none border-0 bg-transparent p-0 text-pop-green outline-none"
                    >
                      <option value="pro-max">pro-max</option>
                      <option value="pro">pro</option>
                      <option value="se">se</option>
                    </select>
                  ) : (
                    <span className="text-pop-green">{currentModel}</span>
                  )}
                  <span aria-hidden className="text-pop-dim">▾</span>
                </span>
              )}
              {contextUsage && (
                <button
                  type="button"
                  onClick={() => setContextExpanded((v) => !v)}
                  className="ml-auto shrink-0 transition-colors hover:text-pop-ink"
                  data-tui-ctx
                >
                  {'ctx '}{/* fmt-ok: 终端角标百分比 */}{contextUsage.percentage.toFixed(0)}%{contextExpanded ? ' ▴' : ' ▾'}
                </button>
              )}
            </div>
            {contextExpanded && contextUsage && (
              <div className="mt-1.5 rounded-md border border-border/50 bg-muted/30 px-2.5 py-1.5 text-[10px]">
                {contextUsage.categories.map((cat) => (
                  <div key={cat.name} className="flex items-center justify-between py-0.5">
                    <div className="flex items-center gap-1.5">
                      <span className="size-2 rounded-sm" style={{ backgroundColor: cat.color }} />
                      <span className="text-muted-foreground">{cat.name}</span>
                    </div>
                    <span className="font-mono">{formatTokenCount(cat.tokens)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      ) : (
      <div className="border-t-[2.5px] border-pop-bd bg-pop-paper p-3">
        <div className="max-w-3xl mx-auto relative">
          {/* @@mention autocomplete */}
          <MentionAutocomplete
            inputValue={input}
            onSelect={handleMentionSelect}
            textareaRef={null}
            currentCloneName={currentCloneName}
          />
          {/* /slash-command autocomplete */}
          {commands && commands.length > 0 && (
            <SlashCommandAutocomplete
              inputValue={input}
              commands={commands}
              onSelect={handleSlashSelect}
              onOpenChange={setSlashOpen}
            />
          )}

          {/* 方案 2（2026-09-12 拍板）：输入 + 工具 = 一个整体贴纸块。
              上格打字；框内虚线底行左侧挂工具 chip（composerLeading 槽 = 专家
              咨询…），右侧发送/停止。模型选择与上下文计数从框外状态行搬进底行。 */}
          <div
            data-composer-block
            className={cn(
              'overflow-hidden rounded-[16px] border-2 border-pop-bd shadow-pop-sm',
              chatState === 'waiting' ? 'bg-pop-amber-soft' : 'bg-pop-bg',
            )}
          >
            <AutoResizeTextarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  // Don't send when an autocomplete dropdown is open — let it
                  // handle Enter for selection.
                  if (!slashOpen) handleSend()
                }
              }}
              placeholder={streaming ? 'Agent 正在回复中...' : composerPlaceholder ?? '输入消息，/ 调用技能，@@ 委托分身，Enter 发送'}
              disabled={streaming || !!pendingConfirm}
              className="min-h-[40px] max-h-[200px] rounded-none border-0 bg-transparent px-3.5 pb-1 pt-2.5 text-[12.5px] text-pop-ink shadow-none focus-visible:ring-0"
            />
            <div
              data-composer-toolbar
              className="flex items-center gap-2 border-t-[1.5px] border-dashed border-pop-bd/25 px-2.5 py-1.5"
            >
              {composerLeading && (
                <div className="flex shrink-0 items-center gap-1.5" data-composer-leading>{composerLeading}</div>
              )}
              {/* Context usage */}
              {contextUsage && (
                <button
                  onClick={() => setContextExpanded(!contextExpanded)}
                  className="flex shrink-0 items-center gap-1 text-[10px] text-muted-foreground transition-colors hover:text-foreground"
                  title="Context window usage"
                >
                  <span>📋</span>
                  <span>{formatTokenCount(contextUsage.totalTokens)} / {formatTokenCount(contextUsage.maxTokens)}</span>
                  <span className="opacity-60">({contextUsage.percentage.toFixed(1)}%) {/* fmt-ok: percentage 量纲未经 server 核实（providers wire），待查后收编 */}</span>
                  {contextExpanded ? <ChevronDown className="size-2.5" /> : <ChevronUp className="size-2.5" />}
                </button>
              )}
              {/* Model selector */}
              {currentModel && onModelChange && (
                <div className="flex shrink-0 items-center gap-1 text-[10px] text-muted-foreground">
                  <span>🧠</span>
                  <select
                    value={currentModel}
                    onChange={(e) => onModelChange(e.target.value)}
                    className="appearance-none cursor-pointer border-none bg-transparent p-0 text-[10px] text-muted-foreground hover:text-foreground focus:outline-none"
                  >
                    <option value="pro-max">pro-max</option>
                    <option value="pro">pro</option>
                    <option value="se">se</option>
                  </select>
                </div>
              )}
              {currentModel && !onModelChange && (
                <div className="flex shrink-0 items-center gap-1 text-[10px] text-muted-foreground">
                  <span>🧠</span>
                  <span>{currentModel}</span>
                </div>
              )}
              <span className="ml-auto flex shrink-0 items-center">
                {streaming ? (
                  <Button
                    onClick={onStop}
                    variant="outline"
                    size="icon"
                    className="h-8 w-8 rounded-xl border-2 border-pop-bd bg-pop-paper text-pop-red shadow-pop-sm pop-press hover:bg-pop-pink-soft"
                  >
                    <Square className="h-3.5 w-3.5" />
                  </Button>
                ) : (
                  <Button
                    onClick={handleSend}
                    disabled={!input.trim()}
                    size="icon"
                    className="h-8 w-8 rounded-xl border-2 border-pop-bd bg-pop-green text-white shadow-pop-sm pop-press hover:bg-pop-green/90"
                  >
                    <Send className="h-3.5 w-3.5" />
                  </Button>
                )}
              </span>
            </div>
          </div>

          {/* ── Context breakdown panel (expanded) ── */}
          {contextExpanded && contextUsage && (
            <div className="mt-1.5 rounded-md border border-border/50 bg-muted/30 px-2.5 py-1.5 text-[10px]">
              {contextUsage.categories.map((cat) => (
                <div key={cat.name} className="flex items-center justify-between py-0.5">
                  <div className="flex items-center gap-1.5">
                    <span className="size-2 rounded-sm" style={{ backgroundColor: cat.color }} />
                    <span className="text-muted-foreground">{cat.name}</span>
                  </div>
                  <span className="font-mono">{formatTokenCount(cat.tokens)}</span>
                </div>
              ))}
              {contextUsage.memoryFiles && contextUsage.memoryFiles.length > 0 && (
                <div className="mt-1 pt-1 border-t border-border/30">
                  <div className="text-muted-foreground mb-0.5">Memory files ({contextUsage.memoryFiles.length})</div>
                  {contextUsage.memoryFiles.map((f) => (
                    <div key={f.path} className="flex items-center justify-between py-0.5 pl-2">
                      <span className="truncate text-muted-foreground/70 max-w-[200px]">{f.path}</span>
                      <span className="font-mono shrink-0 ml-2">{formatTokenCount(f.tokens)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      )}
    </div>
  )
}

/** One thinking segment of the streaming timeline — rendered as an in-flow
 *  card (same visual family as ToolCallCard) at its arrival position. `active`
 *  = this segment is still receiving deltas (💭 pulses). Completed segments
 *  stay visible until the stream ends; the final bubble then merges all
 *  thinking into its collapsed "思考过程" meta. */
function StreamingThinkingCard({ text, active }: { text: string; active: boolean }) {
  return (
    <div className="rounded-xl border-2 border-pop-bd bg-pop-purple-soft px-3 py-2 shadow-pop-sm">
      <div className="flex items-center gap-1 text-xs font-black text-pop-purple mb-1">
        <span className={active ? 'pop-pulse' : undefined}>💭</span>
        {active ? '思考中...' : '思考'}
      </div>
      {text && <AutoFollowPre text={text} />}
    </div>
  )
}

/** Bounded <pre> for streaming thinking: as text grows past max-h, its own
 *  scrollbar follows the bottom (2026-08-19 bugfix — "出现思考中时不会自动拉
 *  到最下"). The outer chat scroll follows via ChatArea's scroll effect; this
 *  handles the inner capped region. */
function AutoFollowPre({ text }: { text: string }) {
  const ref = useRef<HTMLPreElement>(null)
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight
  }, [text])
  return (
    <pre ref={ref} className="text-xs text-muted-foreground whitespace-pre-wrap font-mono max-h-40 overflow-y-auto">
      {text}
    </pre>
  )
}


/** AskUserQuestion 恢复判据（纯函数，单测覆盖）：从尾部反向找「未回答的
 *  问题」—— 遇 user 消息即停（用户已作答 = 问题被消费）。input 缺失时回退
 *  result 自带的 {questions}（interactionSession 上线前的旧回显行同样能恢复
 *  成可点卡片）；解析不出非空 questions 数组 → 视为无问题。 */
export function findUnansweredAsk(
  messages: AgentMessage[],
): { key: string; input: unknown } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role === 'user') return null
    if (m.role !== 'assistant' || !m.tool_calls?.length) continue
    const ask = m.tool_calls.find((tc) => tc.name === 'AskUserQuestion')
    if (!ask) continue
    let raw: unknown = ask.input ?? ask.result
    if (typeof raw === 'string') {
      try { raw = JSON.parse(raw) } catch { raw = null }
    }
    const qs = (raw as { questions?: unknown } | null)?.questions
    return Array.isArray(qs) && qs.length > 0 ? { key: `${m.id}:${ask.id}`, input: raw } : null
  }
  return null
}
