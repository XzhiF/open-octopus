'use client'

import { useState, useRef, useEffect, useMemo, Fragment, type ReactNode } from 'react'
import { Send, Square, MessageSquare, Sparkles, Users, X } from 'lucide-react'
import type { AgentMessage, ToolCallRecord, ContextUsageData } from '@/lib/agent/types'
import type { LlmUsageAggregates } from '@octopus/shared'
import type { StreamTimelineItem } from '@/hooks/useAgentChat'
import { AutoResizeTextarea } from '@/components/ui/auto-resize-textarea'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { formatTokenCount } from '@/lib/format'
import { ChatBubble } from './ChatBubble'
import { SessionCostChip } from './session-cost-chip'
import { TaskCostChip } from './task-cost-chip'
import type { TaskUsagePayload } from '@/lib/tasks-api'
import { TuiLive, TuiMessage } from './TuiTranscript'
import { ToolCallCard } from './ToolCallCard'
import { QuestionCard } from '@/components/workspace/chat/question-card'
import type { ChatMessage } from '@/lib/types'
import { StreamingIndicator } from './StreamingIndicator'
import { DangerConfirmCard } from './DangerConfirmCard'
import { EvolutionConfirmCard } from './EvolutionConfirmCard'
import { ChatTimeline, type ChatTimelineItem } from './chat-timeline'
import { AgentEmptyState } from '../shared/AgentEmptyState'
import { ReviewCard } from '../knowledge/cards/ReviewCard'
import { MentionAutocomplete } from './MentionAutocomplete'
import type { ChatSubagentRef } from '@/hooks/useAgentChat'
import { SlashCommandAutocomplete, type SlashCommand } from './SlashCommandAutocomplete'
import { ComposerModelPopover } from './composer-model-popover'
import { ComposerAttachPopover, type ComposerExpertRef, type ComposerSkillRef, type ComposerIdentityControls } from './composer-attach-popover'
import { ComposerIdentityPicker } from './composer-identity-picker'
import type { ComposerContext, ComposerEffort, ModelPreset } from '@/lib/agent/composer-settings'

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
  onSend: (message: string, opts?: { subagents?: ChatSubagentRef[] }) => void
  onStop: () => void
  onConfirm: (eventId: string, decision: 'accept' | 'reject') => void
  hasSession: boolean
  /** Current clone name for self-reference detection in @@mention */
  currentCloneName?: string | null
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
  /** Available slash commands (内置命令 + 技能命令). When provided,
   *  typing `/` in the input opens an autocomplete dropdown. */
  commands?: SlashCommand[]
  /** Context window usage breakdown (from SDK getContextUsage). */
  contextUsage?: ContextUsageData | null
  /** 本会话账本用量（v49 token 角标）；null = 无账本/未取到 → 角标不渲染。 */
  sessionUsage?: LlmUsageAggregates | null
  /** 2026-10-28 task-thread: task-lifecycle ledger. When supplied (even null,
   *  = loading) the composer shows the TASK chip instead of the session chip. */
  taskUsage?: TaskUsagePayload | null
  /** Current model name (e.g. 'pro', 'pro-max', 'se'). */
  currentModel?: string
  /** Callback when user switches model. */
  onModelChange?: (model: string) => void
  /** Composer status slots: always render ctx/token, with `ctx --%` / `tok --`
   *  placeholders until the first usage arrives (conversation home uses this). */
  showUsagePlaceholders?: boolean
  /** TUI composer: enable the `+ 挂载` menu (installed SKILLs + system clones). */
  showComposerAttach?: boolean
  /** Composer 模型设置：思考强度 / 最大上下文（Claude SDK effort + [1m] 变体）。 */
  effort?: ComposerEffort
  onEffortChange?: (effort: ComposerEffort) => void
  maxContext?: ComposerContext
  onMaxContextChange?: (context: ComposerContext) => void
  /** 各模型自己的 effort/context preset（弹层列表里展示）。 */
  modelPresets?: Record<string, ModelPreset>
  /** 输入行左端的动作槽（草稿工作台把「专家咨询」小贴纸挂这里，替代独立辅助条）。 */
  composerLeading?: ReactNode
  /** 非流式时的输入框 placeholder（草稿工作台把「/ 调用技能」计数提示收编于此）。 */
  composerPlaceholder?: string
  /** 空会话（无消息、非流式）时把 composer 垂直居中，像一张空白工作台。 */
  heroEmpty?: boolean
  /** hero 态输入框下方的第二行（工作区选择等）；身份 chip 由 ChatArea 自绘。 */
  composerHeroFooter?: ReactNode
  /** 会话长期身份（v59 分身）：＋ 按钮展示当前身份，面板里可委派 / 切换。 */
  identity?: ComposerIdentityControls
  /** 当前工作区（只读）：＋ 面板置顶它自带的 SKILL（<workspace>/.claude/skills）。 */
  workspaceContext?: { id: string; label: string } | null
  /** TUI（claude-code 终端皮肤）变体 —— 任务草稿工作台 / 对话首页共用（2026-09-24 改版）：
   *  等宽 transcript（❯/✳ 前缀 + ◌ 过程折叠）、⇧⏎ 排队 dock（≤3，done 即 flush）、
   *  busy 时输入不锁死（⏎=打断接管 / esc=打断 / esc·点击=队列退回）。 */
  tui?: boolean
  /** 打断接管（tui）：stop → 等服务端停 → 重发（useAgentChat.steer）。 */
  onSteer?: (message: string, opts?: { subagents?: ChatSubagentRef[] }) => void
  /** steer 在途（stop→重发谷）：期间 done-flush 让闸，防接管消息被队首抢发。 */
  steerActiveRef?: React.MutableRefObject<boolean>
  /** stream-resume 尾随轮（服务端仍在生成，本地无 SSE 所有权）：此期间
   *  Esc 不被「打断」消费、照常关窗（关闭不丢失，停止走按钮）。 */
  resumeTailing?: boolean
  /** 知识中心票12：每条消息之后插入的结构化节点（卡片流与消息交错；宿主负责从
   *  消息正文剥除卡片块并回填渲染件）。缺省 = 既有消费方零变化。 */
  messageExtras?: (message: AgentMessage) => ReactNode
  /** 知识中心票12：transcript 末尾（流式区之前）的结构化节点——异步任务卡等
   *  不锚定具体消息的 Lane B 沉淀态。缺省 = 零变化。 */
  transcriptTail?: ReactNode
  /** 知识中心票12：卡片钮「对策展人说」等动作预进取号器文本（值变化即灌入输入框）。 */
  composerSeed?: string
  /** 右列有工作区作业坞（lg+）：用户输入历史让开该列，避免重叠。 */
  timelineClearDock?: boolean
}

/** ⇧⏎ 排队上限（原型 chat-tui.html 拍板）。 */
const TUI_QUEUE_MAX = 3
const TUI_SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

/** TUI 队列项：消息文本 + 发送时选中的专家（SKILL 已编码进 /命令前缀）。 */
interface QueuedComposerMessage {
  text: string
  expert: ComposerExpertRef | null
}

export function ChatArea({
  messages, streaming, streamContent, streamThinking, isThinking, toolCalls, streamTimeline, pendingConfirm,
  error, statusMessage, onSend, onStop, onConfirm, hasSession, currentCloneName,
  reviewItems, onReviewAction,
  emptyStateTitle, emptyStateDescription, hideEmptyState,
  commands, contextUsage, sessionUsage, taskUsage, currentModel, onModelChange,
  showUsagePlaceholders, showComposerAttach,
  effort, onEffortChange, maxContext, onMaxContextChange, modelPresets,
  composerLeading, composerPlaceholder, heroEmpty, composerHeroFooter, identity, workspaceContext,
  tui, onSteer, steerActiveRef, resumeTailing,
  messageExtras, transcriptTail, composerSeed, timelineClearDock,
}: ChatAreaProps) {
  const [input, setInput] = useState('')
  const [slashOpen, setSlashOpen] = useState(false)
  const [mentionOpen, setMentionOpen] = useState(false)
  const [contextExpanded, setContextExpanded] = useState(false)
  const [attachedSkill, setAttachedSkill] = useState<ComposerSkillRef | null>(null)
  const [attachedExpert, setAttachedExpert] = useState<ComposerExpertRef | null>(null)
  // ＋ 面板的开合提到 ChatArea：hero 态的身份 chip 也要能打开同一个面板。
  const [attachOpen, setAttachOpen] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  // 票12（/knowledge）：卡片动作预进取号器文本 —— 值变化即灌入输入框；
  // 既有消费方不传此 prop，行为零变化。
  useEffect(() => {
    if (composerSeed) setInput(composerSeed)
  }, [composerSeed])
  // 贴底跟随（原型 v4.3 拍板）：离底 >40px 视为用户在回看，流式不再强制拉底；
  // 滚回底部 40px 内自动恢复跟随。发送自己消息时重置为跟随。
  const stickBottomRef = useRef(true)
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
    if (scrollRef.current && stickBottomRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
    // streamTimeline / streamThinking in deps: thinking deltas (not just text)
    // should follow-scroll, in both timeline and legacy layouts.
  }, [messages, streamContent, toolCalls, streamTimeline, streamThinking])

  // 「+ 挂载」的选中项只消费一次：SKILL → `/name` 前缀（显式 / 或 @@ 开头时让位）；
  // 分身 → 本轮子代理会诊（subagents）。返回 expert 供 TUI 队列退回时恢复 chip。
  const takeComposerAttachments = (raw: string) => {
    const text = attachedSkill && !raw.startsWith('/') && !raw.startsWith('@@')
      ? `/${attachedSkill.name} ${raw}`
      : raw
    const opts = attachedExpert
      ? { subagents: [{ id: attachedExpert.name, label: attachedExpert.displayName }] }
      : undefined
    const expert = attachedExpert
    setAttachedSkill(null)
    setAttachedExpert(null)
    return { text, opts, expert }
  }

  const handleSend = () => {
    if (!input.trim() || streaming) return
    const raw = input.trim()
    const { text, opts } = takeComposerAttachments(raw)
    // `@分身` mentions stay in the text — the server parses them and consults
    // the clone as a one-turn subagent (no delegation, no stripping).
    onSend(text, opts)
    setInput('')
    stickBottomRef.current = true
  }

  const handleMentionSelect = (cloneName: string) => {
    // Replace @/@@partial with @@clone-name (slug; server-parsed)
    setInput(prev => prev.replace(/(^|\s)@(@?)[^\s@]*$/, `$1@@${cloneName} `))
  }

  const handleSlashSelect = (commandName: string) => {
    // Replace entire input with /command (user continues typing the prompt)
    setInput(`/${commandName} `)
  }

  // 模型切换 = 缓存命名空间切换（pro-max→opus / pro→sonnet / se→haiku 为不同
  // 底层模型）：会话已有历史时，切一次就是整段 prefill。提示一次，不阻断。
  const handleModelChange = (next: string) => {
    if (next !== currentModel && messages.length > 0) {
      toast.message('切换模型将重建会话缓存', {
        description: '同一会话的缓存按模型隔离：历史会在下一轮重新计算一次。',
      })
    }
    onModelChange?.(next)
  }

  // ── TUI 排队 / steer（2026-09-24 草稿工作台改版，仅 tui 变体生效）──────
  // 语义（原型 chat-tui.html 拍板）：⇧⏎=排队（≤3，SDK done 立即 flush 队首）；
  // 有排队时 ⏎=继续加入排队；无排队 busy ⏎=打断接管（steer）；有排队 esc=队尾
  // 退回输入框（点击同效），无排队 esc=打断。
  const [queue, setQueueState] = useState<QueuedComposerMessage[]>([])
  const queueRef = useRef<QueuedComposerMessage[]>([])
  const setQueue = (next: QueuedComposerMessage[]) => { queueRef.current = next; setQueueState(next) }
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
      onSend(head.text, head.expert
        ? { subagents: [{ id: head.expert.name, label: head.expert.displayName }] }
        : undefined)
    }
  }, [streaming, tui, onSend, steerActiveRef])

  const focusDockInput = () => {
    dockRef.current?.querySelector<HTMLTextAreaElement>('textarea')?.focus()
  }
  const pushQueue = (text: string, expert: ComposerExpertRef | null) => {
    if (queueRef.current.length >= TUI_QUEUE_MAX) {
      setQueueHint(`队列已满（${TUI_QUEUE_MAX}）`)
      setTimeout(() => setQueueHint(null), 1400)
      return
    }
    setQueue([...queueRef.current, { text, expert }])
  }
  const recallQueue = (i: number) => {
    const back = queueRef.current[i]
    setQueue(queueRef.current.filter((_, j) => j !== i))
    setInput((prev) => (prev.trim() ? `${back.text} ${prev}` : back.text))
    if (back.expert) setAttachedExpert(back.expert)
    focusDockInput()
  }
  const handleTuiKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Alt+⏎ = 换行不发送。浏览器对 alt+enter 没有默认换行行为；优先用原生
    // insertText（保住游标 + 触发受控 onChange，避免手动 rAF 复位与连打竞态），
    // 不支持时回退到 setState 插入。（下拉开着也要能换行，故在 slashOpen 门之前。）
    if (e.key === 'Enter' && e.altKey) {
      e.preventDefault()
      const ta = e.currentTarget
      const s = ta.selectionStart
      const en = ta.selectionEnd
      ta.setSelectionRange(s, en)
      const ok = document.execCommand ? document.execCommand('insertText', false, '\n') : false
      if (!ok) {
        setInput((prev) => prev.slice(0, s) + '\n' + prev.slice(en))
        requestAnimationFrame(() => { ta.selectionStart = ta.selectionEnd = s + 1 })
      }
      return
    }
    if (slashOpen) return // 自动补全下拉打开时 Enter 归下拉
    if (mentionOpen) return // @分身 下拉打开时 Enter 归下拉
    const text = input.trim()
    if (e.key === 'Enter') {
      e.preventDefault()
      if (!text) return
      if (e.shiftKey) {
        setInput('')
        if (streaming) {
          const take = takeComposerAttachments(text)
          pushQueue(take.text, take.expert)
        } else {
          handleSend()
        }
        return
      }
      if (queue.length > 0) {
        setInput('')
        const take = takeComposerAttachments(text)
        pushQueue(take.text, take.expert)
        return
      }
      if (streaming) {
        setInput('')
        const take = takeComposerAttachments(text)
        if (onSteer) onSteer(take.text, take.opts)
        else onStop()
        return
      }
      handleSend()
    } else if (e.key === 'Escape') {
      // 有排队 → 队尾退回输入框；无排队 busy（本地流）→ 打断；
      // resume 尾量 / 空闲 → 放行给宿主弹窗（任务窗 Esc 不关窗，见 task-modal）。
      if (queue.length > 0) { e.preventDefault(); e.stopPropagation(); recallQueue(queue.length - 1) }
      else if (streaming && !resumeTailing) { e.preventDefault(); e.stopPropagation(); onStop() }
    }
  }

  const busyElapsed = streaming ? Math.max(0, (Date.now() - turnStartedAtRef.current) / 1000) : 0
  const busyPhase = toolCalls.some((tc) => tc.status === 'start' || tc.status === 'running' || tc.status === 'pending')
    ? 'exec' : 'thinking'
  const spinGlyph = TUI_SPIN[Math.floor(busyElapsed * 10) % TUI_SPIN.length]
  const contextUsageTitle = contextUsage
    ? `上下文占用 · ${formatTokenCount(contextUsage.totalTokens)} / ${formatTokenCount(contextUsage.maxTokens)} · ${contextUsage.percentage.toFixed(1)}%${contextUsage.estimated ? '（估算：据最后一轮 token 账本推算，下一轮对话后校准）' : ''}` // fmt-ok: percentage 量纲为 0–100（SDK context_usage），非 0–1 比率
    : ''

  // ── 用户输入历史（右侧时间线）────────────────────────────────────────
  // 折叠态 = 每轮一条短横；悬停展开截断的提示词列表；点击滚动到该轮。
  const userTurns = useMemo<ChatTimelineItem[]>(
    () =>
      messages
        .filter((m) => m.role === 'user' && m.content.trim())
        .map((m) => ({ id: m.id, text: m.content.trim() })),
    [messages],
  )
  const [activeTurnId, setActiveTurnId] = useState<string | null>(null)
  useEffect(() => {
    const el = scrollRef.current
    if (!el || userTurns.length === 0) {
      setActiveTurnId(null)
      return
    }
    let raf = 0
    const compute = () => {
      raf = 0
      // 贴底 = 正在看最新一轮（长回答下上一轮提示词早已滚出视野）。
      if (el.scrollHeight - el.scrollTop - el.clientHeight < 40) {
        setActiveTurnId(userTurns[userTurns.length - 1].id)
        return
      }
      const top = el.getBoundingClientRect().top
      let current = userTurns[0].id
      for (const turn of userTurns) {
        const node = el.querySelector<HTMLElement>(`[data-message-id="${turn.id}"]`)
        if (!node) continue
        if (node.getBoundingClientRect().top - top <= 32) current = turn.id
        else break
      }
      setActiveTurnId(current)
    }
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(compute)
    }
    compute()
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      el.removeEventListener('scroll', onScroll)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [userTurns])

  const jumpToTurn = (id: string) => {
    const node = scrollRef.current?.querySelector<HTMLElement>(`[data-message-id="${id}"]`)
    if (!node) return
    // Jumping away from the bottom ends follow-mode; scrolling back re-arms it
    // (the scroll handler above re-sticks within 40px of the bottom).
    stickBottomRef.current = false
    node.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  // hero 态（2026-10-27 原型 v2）：空会话把 composer 居中，像一个空白工作台；
  // 只对 tui + 显式开启的宿主生效（主对话），草稿工作台行为不变。
  const heroMode = !!tui && !!heroEmpty && !streaming && messages.length === 0

  return (
    <div className={cn('relative flex flex-col flex-1 min-h-0', heroMode && 'justify-center')}>
      {/* Content area */}
      {!heroMode && (!hasSession ? (
        hideEmptyState ? (
          <div className="flex-1" />
        ) : tui ? (
          <div className="flex flex-1 items-center px-5" role="status" aria-live="polite">
            <div className="mx-auto w-full max-w-4xl py-10 text-[12.5px] leading-relaxed">
              <div className="text-pop-pink">
                ❯ <span className="text-pop-ink">{emptyStateTitle ?? '开始你的第一个对话'}</span>
              </div>
              <div className="mt-2 max-w-xl text-pop-dim">
                {emptyStateDescription ?? 'Agent 可以理解你的意图，自动编排工作流、管理记忆和分身。试试发送一条指令吧。'}
              </div>
              <div className="mt-5 flex items-center gap-2 text-[11px] text-pop-dim/70">
                <span className="text-pop-pink">✳</span>
                <span>⏎ 发送 · ⇧⏎ 排队 · Alt⏎ 换行</span>
              </div>
            </div>
          </div>
        ) : (
          <AgentEmptyState
            icon={MessageSquare}
            title={emptyStateTitle ?? "开始你的第一个对话"}
            description={emptyStateDescription ?? "Agent 可以理解你的意图，自动编排工作流、管理记忆和分身。试试发送一条指令吧。"}
          />
        )
      ) : (
        <div
          ref={scrollRef}
          onScroll={(e) => {
            const el = e.currentTarget
            stickBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
          }}
          className="flex-1 overflow-y-auto"
        >
          <div className={tui ? 'mx-auto max-w-4xl px-5 py-4 space-y-1.5 text-[12.5px] leading-relaxed' : 'max-w-3xl mx-auto px-4 py-4 space-y-2.5'}>
            {/* Session exists but has no turns yet (new chat / new task). */}
            {tui && messages.length === 0 && !streaming && !hideEmptyState && (
              <div className="py-8" role="status" aria-live="polite">
                <div className="text-pop-pink">
                  ❯ <span className="text-pop-ink">{emptyStateTitle ?? '开始你的第一个对话'}</span>
                </div>
                <div className="mt-2 max-w-xl text-pop-dim">
                  {emptyStateDescription ?? 'Agent 可以理解你的意图，自动编排工作流、管理记忆和分身。试试发送一条指令吧。'}
                </div>
                <div className="mt-5 flex items-center gap-2 text-[11px] text-pop-dim/70">
                  <span className="text-pop-pink">✳</span>
                  <span>⏎ 发送 · ⇧⏎ 排队 · Alt⏎ 换行</span>
                </div>
              </div>
            )}
            {Array.from(new Map(messages.map(m => [m.id, m])).values()).map((msg) => (
              <Fragment key={msg.id}>
                {tui ? <TuiMessage message={msg} /> : <ChatBubble message={msg} />}
                {messageExtras?.(msg)}
              </Fragment>
            ))}
            {transcriptTail}

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
      ))}

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
          输入（busy 不锁死）+ 控件条（专家咨询│model│ctx … 右端挂快捷键提示/busy）。 */}
      {tui ? (
        <div
          ref={dockRef}
          className={cn(
            'shrink-0 px-4',
            heroMode
              ? 'border-t-0 bg-transparent pb-0 pt-0'
              : 'border-t border-white/[0.06] bg-pop-bg pb-3 pt-2',
          )}
          data-tui-dock
          data-tui-hero={heroMode ? 'true' : undefined}
        >
          <div className="relative mx-auto max-w-4xl">
            {heroMode && !hideEmptyState && (
              <div className="mb-5 text-center" role="status" aria-live="polite" data-tui-hero-title>
                <div className="text-[15px] font-semibold text-pop-ink">
                  {emptyStateTitle ?? '开始新的对话'}
                </div>
                <div className="mt-1.5 text-[11.5px] text-pop-dim">
                  {emptyStateDescription ?? '问点什么，或者直接描述要开发的任务'}
                </div>
              </div>
            )}
            <MentionAutocomplete
              inputValue={input}
              onSelect={handleMentionSelect}
              textareaRef={null}
              currentCloneName={currentCloneName}
              onOpenChange={setMentionOpen}
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
                    key={`${i}:${q.text.slice(0, 12)}`}
                    type="button"
                    onClick={() => recallQueue(i)}
                    title="点击退回输入框"
                    data-tui-queue-item={i}
                    className="flex w-full items-center gap-2 rounded px-1 text-left text-[11px] text-pop-dim transition-colors hover:text-pop-amber"
                  >
                    <span className="w-[72px] shrink-0 text-pop-pink">⧗ queued</span>
                    <span className="shrink-0 text-pop-pink">{i + 1}/{TUI_QUEUE_MAX}</span>
                    <span className="min-w-0 flex-1 truncate">{q.text}</span>
                    <span className="ml-auto shrink-0 text-[10px]">esc/点击 → 退回输入框</span>
                  </button>
                ))}
              </div>
            )}
            {(attachedSkill || attachedExpert) && (
              <div className="mb-1.5 flex flex-wrap items-center gap-1" data-composer-chips>
                {attachedSkill && (
                  <span className="flex items-center gap-1 rounded-full border border-pop-cyan/40 bg-pop-cyan-soft px-2 py-0.5 text-[10.5px] text-pop-cyan">
                    <Sparkles className="size-2.5" />
                    <span className="font-mono">/{attachedSkill.name}</span>
                    <button
                      type="button"
                      onClick={() => setAttachedSkill(null)}
                      aria-label="移除 SKILL"
                      className="text-pop-cyan/70 transition-colors hover:text-pop-cyan"
                    >
                      <X className="size-2.5" />
                    </button>
                  </span>
                )}
                {attachedExpert && (
                  <span className="flex items-center gap-1 rounded-full border border-pop-purple/40 bg-pop-purple-soft px-2 py-0.5 text-[10.5px] text-pop-purple">
                    <Users className="size-2.5" />
                    <span>分身 · {attachedExpert.displayName}</span>
                    <button
                      type="button"
                      onClick={() => setAttachedExpert(null)}
                      aria-label="移除专家"
                      className="text-pop-purple/70 transition-colors hover:text-pop-purple"
                    >
                      <X className="size-2.5" />
                    </button>
                  </span>
                )}
              </div>
            )}
            <div
              data-composer-block
              className="rounded-[9px] border border-white/[0.08] bg-pop-paper/60 px-2.5 py-1.5 transition-colors focus-within:border-white/[0.16]"
            >
              <div className="flex items-start gap-2">
                {/* pt-1.5 与 textarea 的 py-1.5 对齐：两者行高同为 24px，
                    不补 padding 则 ❯ 比首行文字高 6px（items-start 下不居中）。 */}
                <span aria-hidden className="shrink-0 pt-1.5 font-bold leading-6 text-pop-pink">❯</span>
                {/* maxRows=3（2026-09-24 用户定稿：初始 1 行、最多长到 3 行，
                    再超出走内滚）。不写 CSS max-height —— 会钳住 scrollHeight
                    导致几行就不再长高（原型 v2 实测 bug）。 */}
                <AutoResizeTextarea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleTuiKeyDown}
                  maxRows={3}
                  disabled={!!pendingConfirm}
                  placeholder={
                    queue.length > 0
                      ? '继续输入 —— ⏎/⇧⏎ 都会加入排队'
                      : streaming
                        ? '输入新指令 —— ⏎ 打断接管 · ⇧⏎ 不打断排队'
                        : composerPlaceholder ?? '问 task-author…　⏎ 发送 · ⇧⏎ 排队 · Alt⏎ 换行'
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
                      className="grid size-6 place-items-center rounded-md border border-pop-bd bg-pop-pink text-[10px] font-bold text-pop-bg transition-opacity disabled:opacity-40"
                    >
                      ⏎
                    </button>
                  )}
                </span>
              </div>
            </div>
            {/* 控件条：+ 挂载 / model / ctx 居左；快捷键提示 + busy 计时挂
                最右（2026-09-24 用户改判：提示不再单独占输入框下方一行）。 */}
            <div className="mt-2 flex min-w-0 items-center gap-1 overflow-x-auto text-[10.5px] text-pop-dim/85 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" data-tui-ctrlbar>
              {composerLeading && (
                <span className="flex shrink-0 items-center gap-1.5" data-composer-leading>{composerLeading}</span>
              )}
              {showComposerAttach && (
                <ComposerAttachPopover
                  skill={attachedSkill}
                  expert={attachedExpert}
                  onSkillChange={setAttachedSkill}
                  onExpertChange={setAttachedExpert}
                  // hero（新会话）身份只走下方单选选择器；＋ 面板不重复展示切换，
                  // 但保留只读身份上下文，用来置顶「身份自带」的 SKILL。
                  identity={heroMode ? undefined : identity}
                  identityContext={
                    identity?.activeName
                      ? { name: identity.activeName, label: identity.label }
                      : null
                  }
                  workspaceContext={workspaceContext}
                  open={attachOpen}
                  onOpenChange={setAttachOpen}
                />
              )}
              {currentModel && (
                onModelChange ? (
                  <ComposerModelPopover
                    currentModel={currentModel}
                    onModelChange={handleModelChange}
                    effort={effort ?? 'high'}
                    onEffortChange={onEffortChange ?? (() => {})}
                    context={maxContext ?? '200k'}
                    onContextChange={onMaxContextChange ?? (() => {})}
                    modelPresets={modelPresets}
                    effectiveModel={contextUsage?.model}
                  />
                ) : (
                  <span className="flex h-[22px] shrink-0 items-center gap-1 px-1.5">
                    <span>model</span>
                    <span className="text-pop-green">{currentModel}</span>
                    <span aria-hidden className="text-pop-dim">▾</span>
                  </span>
                )
              )}
              {/* hero 还没有会话：ctx / token 都是空占位，只留模型可选。 */}
              {!heroMode && (
                <>
                  <span className="hidden items-center gap-1 sm:flex">
                    {contextUsage ? (
                      <Popover open={contextExpanded} onOpenChange={setContextExpanded}>
                          <PopoverTrigger asChild>
                            <button
                              type="button"
                              className={cn(
                                'flex h-[22px] shrink-0 items-center rounded-[7px] border border-transparent px-1.5 text-[11px] transition-colors hover:bg-pop-paper hover:text-pop-ink',
                                contextExpanded ? 'border-pop-bd bg-pop-paper text-pop-ink' : 'text-pop-ink/90',
                              )}
                              data-tui-ctx
                            >
                              {'ctx '}{/* fmt-ok: 终端角标百分比 */}{contextUsage.estimated ? '~' : ''}{contextUsage.percentage.toFixed(0)}%{contextExpanded ? ' ▴' : ' ▾'}
                            </button>
                          </PopoverTrigger>
                          <PopoverContent
                            side="top"
                            align="start"
                            sideOffset={8}
                            className="w-72 rounded-[14px] border-[1.5px] border-pop-bd bg-pop-paper p-3 shadow-pop"
                          >
                            <ContextUsagePanel contextUsage={contextUsage} />
                          </PopoverContent>
                        </Popover>
                    ) : showUsagePlaceholders ? (
                      <span className="flex h-[22px] shrink-0 items-center px-1.5 text-pop-dim/60" title="暂无上下文用量">ctx --% ▾</span>
                    ) : null}
                  </span>
                  <span className="hidden sm:flex">
                    {taskUsage !== undefined ? (
                      <TaskCostChip usage={taskUsage} placeholder={showUsagePlaceholders} />
                    ) : (
                      <SessionCostChip usage={sessionUsage} contextUsage={contextUsage} placeholder={showUsagePlaceholders} />
                    )}
                  </span>
                </>
              )}
              <span className="ml-auto hidden min-w-0 items-center justify-end gap-2 text-[10.5px] sm:flex">
                {streaming && (
                  <span className="shrink-0 text-pop-amber" data-tui-busy>
                    <span className="text-pop-pink">{spinGlyph}</span> {busyPhase} {busyElapsed.toFixed(1)}s {/* fmt-ok: 终端 busy 行秒数，非全站计时器 */}
                  </span>
                )}
                {queueHint ? (
                  <span className="shrink-0 text-pop-red" data-tui-hint>{queueHint}</span>
                ) : queue.length > 0 ? (
                  <span className="truncate" data-tui-hint>⏎ 继续排队 · ⇧⏎ 排队 · esc 退回输入框 <span className="opacity-70">队列 {queue.length}/{TUI_QUEUE_MAX} · done 即发</span></span>
                ) : streaming ? (
                  <span className="shrink-0" data-tui-hint>⏎ 打断并接管 · ⇧⏎ 不打断，排队 · esc 打断</span>
                ) : (
                  <span className="shrink-0" data-tui-hint>⏎ 发送 · ⇧⏎ 排队 · Alt⏎ 换行</span>
                )}
              </span>
            </div>
            {/* hero 态第二行：工作区 + 当前身份（左对齐输入框；2026-10-27 原型 v2）
                身份选择器只做单选——「委派」属于 ＋ 面板，不搬到新会话首页。 */}
            {heroMode && (composerHeroFooter || identity) && (
              <div className="mt-3 flex flex-wrap items-center gap-2" data-tui-hero-footer>
                {composerHeroFooter}
                {identity && (
                  <ComposerIdentityPicker
                    activeName={identity.activeName}
                    label={identity.label}
                    onSelect={identity.onSwitch}
                  />
                )}
              </div>
            )}
          </div>
        </div>
      ) : (
      <div className="border-t-[1.5px] border-pop-bd bg-pop-paper p-3">
        <div className="max-w-3xl mx-auto relative">
          {/* @分身 mention autocomplete */}
          <MentionAutocomplete
            inputValue={input}
            onSelect={handleMentionSelect}
            textareaRef={null}
            currentCloneName={currentCloneName}
            onOpenChange={setMentionOpen}
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
                if (e.key === 'Enter' && e.altKey) {
                  // Alt+⏎ 换行（与 tui 路径同语义：原生 insertText 优先）
                  e.preventDefault()
                  const ta = e.currentTarget
                  const s = ta.selectionStart
                  const en = ta.selectionEnd
                  ta.setSelectionRange(s, en)
                  const ok = document.execCommand ? document.execCommand('insertText', false, '\n') : false
                  if (!ok) {
                    setInput((prev) => prev.slice(0, s) + '\n' + prev.slice(en))
                    requestAnimationFrame(() => { ta.selectionStart = ta.selectionEnd = s + 1 })
                  }
                  return
                }
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
              className="flex items-center gap-[3px] border-t-[1.5px] border-dashed border-pop-bd/25 px-1.5 py-1 pr-2.5"
            >
              {composerLeading && (
                <div className="mr-1 flex shrink-0 items-center gap-1.5" data-composer-leading>{composerLeading}</div>
              )}
              {/* 原型 cmp-bar：model / ctx / 会话账同高 22px、等宽字、无 emoji。 */}
              {currentModel && (
                <div className="flex h-[22px] shrink-0 items-center">
                  {onModelChange ? (
                    <div className="relative flex items-center">
                      <select
                        value={currentModel}
                        onChange={(e) => handleModelChange(e.target.value)}
                        aria-label="模型"
                        title="切换模型"
                        className="h-[22px] cursor-pointer appearance-none rounded-[7px] border border-transparent bg-transparent pl-1.5 pr-[18px] font-mono text-[11px] leading-none text-pop-dim outline-none transition-colors hover:bg-pop-paper hover:text-pop-ink focus-visible:border-pop-bd [&>option]:bg-pop-paper [&>option]:text-pop-ink"
                      >
                        <option value="pro-max">pro-max</option>
                        <option value="pro">pro</option>
                        <option value="se">se</option>
                      </select>
                      <span aria-hidden className="pointer-events-none absolute right-1.5 text-[8px] text-pop-dim">▾</span>
                    </div>
                  ) : (
                    <span className="flex h-[22px] items-center gap-1 rounded-[7px] px-1.5 font-mono text-[11px] leading-none text-pop-dim">
                      {currentModel}
                      <span aria-hidden className="text-[8px]">▾</span>
                    </span>
                  )}
                </div>
              )}
              {contextUsage ? (
                <Popover open={contextExpanded} onOpenChange={setContextExpanded}>
                  <PopoverTrigger asChild>
                    <button
                      type="button"
                      title={contextUsageTitle}
                      className={cn(
                        'flex h-[22px] shrink-0 items-center gap-1 rounded-[7px] border border-transparent px-1.5 text-[11px] leading-none text-pop-dim transition-colors hover:bg-pop-paper hover:text-pop-ink',
                        contextExpanded && 'border-pop-bd bg-pop-paper text-pop-ink',
                      )}
                    >
                      <span>{'ctx '}{/* fmt-ok: percentage 量纲未经 server 核实（providers wire），待查后收编；角标取整对齐原型 */}{contextUsage.estimated ? '~' : ''}{contextUsage.percentage.toFixed(0)}%</span>
                      <span aria-hidden className="text-[8px]">{contextExpanded ? '▴' : '▾'}</span>
                    </button>
                  </PopoverTrigger>
                  <PopoverContent
                    side="top"
                    align="start"
                    sideOffset={8}
                    className="w-72 rounded-[14px] border-[1.5px] border-pop-bd bg-pop-paper p-3 shadow-pop"
                  >
                    <ContextUsagePanel contextUsage={contextUsage} />
                  </PopoverContent>
                </Popover>
              ) : showUsagePlaceholders ? (
                <span
                  className="flex h-[22px] shrink-0 items-center gap-1 rounded-[7px] px-1.5 text-[11px] leading-none text-pop-dim/60"
                  title="暂无上下文用量"
                >
                  <span>ctx --%</span>
                  <span aria-hidden className="text-[8px]">▾</span>
                </span>
              ) : null}
              {taskUsage !== undefined ? (
                      <TaskCostChip usage={taskUsage} placeholder={showUsagePlaceholders} />
                    ) : (
                      <SessionCostChip usage={sessionUsage} contextUsage={contextUsage} placeholder={showUsagePlaceholders} />
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
                    className="h-8 w-8 rounded-xl border-2 border-pop-bd bg-pop-pink text-pop-bg shadow-pop-sm pop-press hover:brightness-110"
                  >
                    <Send className="h-3.5 w-3.5" />
                  </Button>
                )}
              </span>
            </div>
          </div>

        </div>
      </div>
      )}

      <ChatTimeline
        items={userTurns}
        activeId={activeTurnId}
        onJump={jumpToTurn}
        clearDock={timelineClearDock}
      />
    </div>
  )
}

/** ctx 占用明细：TUI 与非 TUI 两个 composer 弹层共用。 */
function ContextUsagePanel({ contextUsage }: { contextUsage: ContextUsageData }) {
  return (
    <>
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-[11px] font-bold text-pop-ink">上下文占用</span>
        <span className="font-mono text-[10px] tabular-nums text-pop-dim">
          {formatTokenCount(contextUsage.totalTokens)} / {formatTokenCount(contextUsage.maxTokens)} · {contextUsage.percentage.toFixed(1)}%{/* fmt-ok: percentage 量纲为 0–100（SDK context_usage），非 0–1 比率 */}
        </span>
      </div>
      {contextUsage.estimated && (
        <div className="mb-2 rounded-[7px] border border-dashed border-pop-bd/70 px-2 py-1 text-[10px] leading-relaxed text-pop-dim" data-tui-ctx-estimated>
          估算值：该会话最后一轮早于 ctx 落库，这里按 token 账本推算；下一轮对话后自动换成精确值。
        </div>
      )}
      <div className="space-y-1">
        {contextUsage.categories.map((cat) => (
          <div key={cat.name} className="flex items-center justify-between gap-2 text-[11px]">
            <span className="flex min-w-0 items-center gap-1.5 text-pop-dim">
              <span className="size-2 shrink-0 rounded-[3px]" style={{ backgroundColor: cat.color }} />
              <span className="truncate">{cat.name}</span>
            </span>
            <span className="shrink-0 font-mono text-[10.5px] tabular-nums text-pop-ink">{formatTokenCount(cat.tokens)}</span>
          </div>
        ))}
      </div>
      {contextUsage.memoryFiles && contextUsage.memoryFiles.length > 0 && (
        <div className="mt-2 border-t border-dashed border-pop-bd/60 pt-2">
          <div className="mb-1 text-[10px] text-pop-dim">记忆文件 ({contextUsage.memoryFiles.length})</div>
          {contextUsage.memoryFiles.map((f) => (
            <div key={f.path} className="flex items-center justify-between gap-2 py-0.5 text-[10.5px]">
              <span className="max-w-[190px] truncate font-mono text-pop-dim/80" title={f.path}>{f.path}</span>
              <span className="shrink-0 font-mono tabular-nums text-pop-ink">{formatTokenCount(f.tokens)}</span>
            </div>
          ))}
        </div>
      )}
    </>
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
