'use client'

import { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo, Fragment, type ReactNode, type MutableRefObject } from 'react'
import { createPortal } from 'react-dom'
import { Send, Square, MessageSquare, Sparkles, Users, X, Check, Copy } from 'lucide-react'
import type { AgentMessage, ToolCallRecord, ContextUsageData, ChatSendMeta, ChatSeedMeta } from '@/lib/agent/types'
import type { LlmUsageAggregates } from '@octopus/shared'
import type { StreamTimelineItem } from '@/hooks/useAgentChat'
import { AutoResizeTextarea } from '@/components/ui/auto-resize-textarea'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { toast } from 'sonner'
import { cn, copyToClipboard } from '@/lib/utils'
import { formatStopwatch, formatTokenCount } from '@/lib/format'
import { ChatBubble } from './ChatBubble'
import { SessionCostChip } from './session-cost-chip'
import { ContextUsageChip, ContextUsagePlaceholder, contextUsageAriaLabel } from './context-usage-chip'
import { ContextUsagePanel } from './context-usage-panel'
import { TaskCostChip } from './task-cost-chip'
import type { TaskUsagePayload } from '@/lib/tasks-api'
import { TuiLive, TuiMessage } from './TuiTranscript'
import { displayContentFor } from '@/lib/agent/display-content'
import { ToolCallCard } from './ToolCallCard'
import { TaskProgressPanel } from './task-progress-panel'
import { deriveTaskProgress } from '@/lib/agent/task-progress'
import { QuestionCard } from '@/components/workspace/chat/question-card'
import type { ChatMessage } from '@/lib/types'
import { DangerConfirmCard } from './DangerConfirmCard'
import { EvolutionConfirmCard } from './EvolutionConfirmCard'
import { ChatTimeline } from './chat-timeline'
import { userPromptTurns } from '@/lib/agent/user-turns'
import { useChatSlot } from '@/components/cockpit/chat/chat-slots'
import { AgentEmptyState } from '../shared/AgentEmptyState'
import { ReviewCard } from '../knowledge/cards/ReviewCard'
import { MentionAutocomplete } from './MentionAutocomplete'
import type { ChatSubagentRef } from '@/hooks/useAgentChat'
import { SlashCommandAutocomplete, type SlashCommand } from './SlashCommandAutocomplete'
import { ComposerModelPopover } from './composer-model-popover'
import { ComposerAttachPopover, type ComposerExpertRef, type ComposerSkillRef, type ComposerIdentityControls } from './composer-attach-popover'
import { ComposerIdentityPicker } from './composer-identity-picker'
import { ComposerIdentityChip, type ComposerIdentityDisplay } from './composer-identity-chip'
import type { ComposerContext, ComposerEffort, ModelPreset } from '@/lib/agent/composer-settings'
import { workPhrase, type WorkPhase } from '@/lib/agent/work-phrases'
import { WORK_PHASE_TONE } from '@/lib/agent/chat-colors'

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
  /** 服务端还有更早的消息没加载（useAgentChat 分页游标）。转录顶部给提示，
   *  滚到顶自动向更早翻一页（2026-11-20 用户 #11：长会话不一次性铺满）。 */
  hasMoreMessages?: boolean
  /** 正在上翻加载（顶部提示换成「加载更早的消息…」）。 */
  loadingOlderMessages?: boolean
  /** 请求更早一页（useAgentChat.loadOlderMessages）。 */
  onLoadOlder?: () => void
  streaming: boolean
  streamContent: string
  streamThinking: string
  isThinking: boolean
  toolCalls: ToolCallRecord[]
  /** Arrival-ordered thinking/text/tool timeline (useAgentChat). When passed,
   *  streaming renders interleaved (thinking as in-flow cards); when omitted,
   *  the legacy fixed-order layout (thinking top / tools / text) is used. */
  streamTimeline?: StreamTimelineItem[]
  /** Real start of the current turn (ms, useAgentChat). When present the busy
   *  timer counts from it — a switch-back mid-turn keeps the true elapsed time
   *  instead of restarting at 0 (2026-10-29). Absent → local ref fallback. */
  turnStartedAt?: number | null
  pendingConfirm: {
    event_id: string
    type: 'dangerous_command' | 'evolution_major'
    operation: string
    detail: string
  } | null
  error: string | null
  statusMessage: string
  /** 正在等的后台任务（provider `background_tasks` 电平，2026-11-04）。
   *  非空时流尾工作行换成「后台运行中：<description>」。 */
  backgroundTasks?: Array<{ id: string; description: string; taskType?: string }>
  /** 后台等待期（2026-11-23 用户 #8）：模型空闲、只等后台任务唤醒。
   *  true 时输入不锁，⏎ 走 onInterject 注进同一条查询（不打断后台）。 */
  canInterject?: boolean
  /** 后台等待期的追加发送（useAgentChat.interject）。 */
  onInterject?: (message: string) => boolean | Promise<boolean> | void
  onSend: (message: string, opts?: { subagents?: ChatSubagentRef[]; meta?: ChatSendMeta }) => void
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
  /** 控件条「当前身份」贴纸：任务线程只读，普通会话悬停 ✕ 清除回主身份。
   *  缺省 = 该宿主不展示身份贴纸（hero 新会话由下方选择器承担）。 */
  identityDisplay?: ComposerIdentityDisplay
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
  /** 分屏：每栏较窄，转录给贴边作业坞留出右内边距（否则正文会钻到坞下面）。 */
  dockGutter?: boolean
  /** 全域座舱（S5）：非空时用 createPortal 把 **composer 原样**渲染进这个容器
   *  （= 底栏 54px 输入区）。为空 = 今天的行内 composer，逐字不变。 */
  composerSlot?: HTMLElement | null
  /** 全域座舱：'cockpit' 只隐藏已经搬到舰桥的模型/上下文读数，
   *  输入、附件、队列、停止、@、/、Esc 全部保留。默认 'full'。 */
  composerVariant?: 'full' | 'cockpit'
  /** 队列深度（tui 排队）变化时通知宿主 —— 舰桥 telemetry 读它。 */
  onQueueDepthChange?: (depth: number) => void
  /** 把「走真 composer 管线」的提交入口暴露给宿主（CockpitChatApi.submit）。
   *  含附件、流式排队、steer，与输入框回车完全同一条路径。 */
  composerBridgeRef?: MutableRefObject<ChatComposerBridge | null>
  /** design 25 §5.5：任务线程默认只读 —— 输入框收成一条「只读 + 兜底开关」的条。
   *  打开兜底后才走正常 composer（例外路径）。 */
  composerHidden?: boolean
  composerHiddenHint?: string
  composerEnableLabel?: string
  onEnableComposer?: () => void
  /** v22 #5：助手行头的身份标签（缺省「汐音」）—— 编队独立窗换成该线程的 agent
   *  身份（执行者 / 作者 …），用户从句首就能看清在跟谁说话。 */
  assistantLabel?: string
  /** v22 #5：独立窗 —— 对话索引 / 星核挂载在本栏内渲染，不 portal 进主通讯台
   *  头部槽（chat-slots 是单槽位，多个 ChatPane 同时挂会互相抢）。 */
  inlineChrome?: boolean
  /** 独立窗自己的「对话索引」槽（窗头 ≡ N 轮）；缺省沿用通讯台槽。 */
  indexSlot?: HTMLElement | null
  /** 独立窗自己的「星核」挂载槽（窗头左上角）；缺省沿用通讯台头部槽。 */
  attachSlot?: HTMLElement | null
  /** 索引面板的定位主机选择器：通讯台 = .ck12-comms，独立窗 = .ck12-cwin。 */
  chromeHostSelector?: string
}

/** ChatArea 暴露给宿主的 composer 能力（只增不减，避免宿主另写 send）。 */
export interface ChatComposerBridge {
  /** 程序化提交一句话：与在输入框里按 ⏎ 的分支完全一致（含队列/steer）。 */
  submit(text: string, meta?: ChatSendMeta): void
  /** 预填输入框（「事项 → 带到输入框」）：可随后编辑再发；挂件随本条生效。 */
  seed(text: string, meta?: ChatSeedMeta): void
  /** 聚焦真输入框（底栏点一下/⌘K 后）。 */
  focus(): void
}

/** v20 全域 TUI 行：时间戳 gutter（HH:MM）与角色符签（design 29 §3.1）。 */
function cockpitRowTime(iso: string | null | undefined): string {
  if (!iso) return ''
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return ''
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
}

/** 全域座舱 · 消息行尾（2026-11-20 用户 #10）：时间 + 复制，常显在最右。
 *  用户行由浮动的这一块贴住首行右侧（正文换行回同一左缘）；助手行由
 *  TuiMeta 的 trail 位承载，跟统计同一行。 */
function CockpitMessageActs({ message }: { message: AgentMessage }) {
  const [copied, setCopied] = useState(false)
  const timerRef = useRef<number | null>(null)
  useEffect(() => () => {
    if (timerRef.current) window.clearTimeout(timerRef.current)
  }, [])
  // 助手正文按历史态口径（有 timeline 时只算真正展示的正文），用户行整条。
  const text = message.role === 'assistant' ? displayContentFor(message) : message.content
  const time = cockpitRowTime(message.created_at)
  const copy = async () => {
    const ok = copyToClipboard(text)
    if (!ok) {
      // 局域网 HTTP 等非安全上下文：clipboard API 缺席，给出明确失败而不是静默。
      try {
        await navigator.clipboard.writeText(text)
      } catch {
        toast.error('复制失败，请手动选择文本')
        return
      }
    }
    setCopied(true)
    if (timerRef.current) window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(() => setCopied(false), 1500)
  }
  return (
    <span className={`ck12-msgacts${copied ? ' is-copied' : ''}`} data-testid="cockpit-msgacts">
      <button
        type="button"
        className="ck12-msgacts-copy"
        title={copied ? '已复制' : '复制这条消息'}
        aria-label="复制这条消息"
        data-testid="cockpit-msgacts-copy"
        onClick={() => void copy()}
      >
        {copied ? <Check className="size-[11px]" aria-hidden /> : <Copy className="size-[11px]" aria-hidden />}
      </button>
      {time && <span className="ck12-msgacts-time">{time}</span>}
    </span>
  )
}

/** ⇧⏎ 排队上限（原型 chat-tui.html 拍板）。 */
const TUI_QUEUE_MAX = 3
const TUI_SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

/** TUI 队列项：消息文本 + 发送时选中的专家（SKILL 已编码进 /命令前缀）+ 来源元数据。 */
interface QueuedComposerMessage {
  text: string
  expert: ComposerExpertRef | null
  /** 事项投递（2026-11-24）：排队期间不丢来源；出队时随 onSend 一起交给服务端。 */
  meta?: ChatSendMeta
}

export function ChatArea({
  messages, streaming, streamContent, streamThinking, isThinking, toolCalls, streamTimeline, turnStartedAt, pendingConfirm,
  hasMoreMessages, loadingOlderMessages, onLoadOlder,
  error, statusMessage, backgroundTasks, canInterject = false, onInterject, onSend, onStop, onConfirm, hasSession, currentCloneName,
  reviewItems, onReviewAction,
  emptyStateTitle, emptyStateDescription, hideEmptyState,
  commands, contextUsage, sessionUsage, taskUsage, currentModel, onModelChange,
  showUsagePlaceholders, showComposerAttach,
  effort, onEffortChange, maxContext, onMaxContextChange, modelPresets,
  composerLeading, composerPlaceholder, heroEmpty, composerHeroFooter, identity, identityDisplay, workspaceContext,
  tui, onSteer, steerActiveRef, resumeTailing,
  messageExtras, transcriptTail, composerSeed, timelineClearDock, dockGutter,
  composerSlot, composerVariant = 'full', onQueueDepthChange, composerBridgeRef,
  composerHidden, composerHiddenHint, composerEnableLabel, onEnableComposer,
  assistantLabel, inlineChrome, indexSlot, attachSlot, chromeHostSelector,
}: ChatAreaProps) {
  const [input, setInput] = useState('')
  const [slashOpen, setSlashOpen] = useState(false)
  const [mentionOpen, setMentionOpen] = useState(false)
  const [contextExpanded, setContextExpanded] = useState(false)
  const [attachedSkill, setAttachedSkill] = useState<ComposerSkillRef | null>(null)
  const [attachedExpert, setAttachedExpert] = useState<ComposerExpertRef | null>(null)

  // 事项投递（2026-11-24 用户）：从「事项」窗「带到输入框」时挂上的来源。
  // ids 随消息发给服务端（meta）；labels 只用于输入框上方的挂件。
  const [seedItems, setSeedItems] = useState<{ ids: string[]; labels: string[] } | null>(null)
  const seedItemsRef = useRef<{ ids: string[]; labels: string[] } | null>(null)
  useEffect(() => { seedItemsRef.current = seedItems }, [seedItems])
  const clearSeedItems = () => {
    seedItemsRef.current = null
    setSeedItems(null)
  }
  const seedMetaNow = (): ChatSendMeta | undefined => {
    const seed = seedItemsRef.current
    return seed && seed.ids.length > 0 ? { via: 'items', itemIds: seed.ids } : undefined
  }

  // 任务清单（Claude Code 风格置顶面板）：历史消息里的 tool_calls + 当前流的
  // toolCalls 合成；同一 tool_call id 只认一次（流式与持久化重叠时防重复）。
  const taskProgress = useMemo(() => {
    const dedupedMessages = Array.from(new Map(messages.map((m) => [m.id, m])).values())
    const persisted = dedupedMessages.flatMap((m) => (Array.isArray(m.tool_calls) ? m.tool_calls : []))
    return deriveTaskProgress([...persisted, ...toolCalls])
  }, [messages, toolCalls])
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
  const scrollObserverRef = useRef<ResizeObserver | null>(null)
  // 浮窗常驻挂载：隐藏（display:none / 47px 收起）时容器的 scrollHeight 恒为 0，
  // 贴底 effect 即使跑过也只会停在顶部；重新开窗不会改 messages，effect 不重跑。
  // 观察容器本身：0 → 有尺寸时（开窗/展开/拖大），只要还在跟随态就重新贴底。
  // 用户回看历史（stickBottom=false）时不打扰。
  const attachScroller = useCallback((node: HTMLDivElement | null) => {
    scrollObserverRef.current?.disconnect()
    scrollObserverRef.current = null
    scrollRef.current = node
    if (!node || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      if (stickBottomRef.current) node.scrollTop = node.scrollHeight
      autoFillRef.current()
    })
    observer.observe(node)
    scrollObserverRef.current = observer
  }, [])
  useEffect(() => () => {
    scrollObserverRef.current?.disconnect()
    scrollObserverRef.current = null
  }, [])
  const unansweredAsk = useMemo(() => findUnansweredAsk(messages), [messages])

  // 同一 execution 的运行卡只画一次完整节点摘要（2026-11-14）：暂停/继续、
  // 历史重复卡等都带同一个 executionId，后到的降级成轻量转场卡 —— 否则 chat 里
  // 会出现两张一模一样的「本轮执行失败 / 执行中」运行卡。
  const renderMessages = useMemo(() => {
    const seenExec = new Set<string>()
    return Array.from(new Map(messages.map((m) => [m.id, m])).values()).map((msg) => {
      const a = msg.activity
      const payload = a?.payload as { workflowRun?: boolean; acceptanceCheck?: boolean } | undefined
      const isRunCard = msg.displayType === 'event'
        && !!a?.taskId
        && (a.status === 'running' || a.status === 'paused')
        && !payload?.workflowRun
        && !payload?.acceptanceCheck
      let compactEvent = false
      if (isRunCard && a?.executionId) {
        if (seenExec.has(a.executionId)) compactEvent = true
        else seenExec.add(a.executionId)
      }
      return { msg, compactEvent }
    })
  }, [messages])

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

  // 上翻分页（2026-11-20 用户 #11）：滚到顶 → 记下当前内容高度，向更早要一页；
  // 新行前插后用 scrollHeight 差值把视口钉回原位，正在看的那条不会往下跳。
  const olderAnchorRef = useRef<{ firstId: string; height: number; top: number } | null>(null)
  const requestOlder = useCallback(() => {
    const el = scrollRef.current
    const first = messages[0]
    if (!onLoadOlder || !hasMoreMessages || !el || !first || olderAnchorRef.current) return
    olderAnchorRef.current = { firstId: first.id, height: el.scrollHeight, top: el.scrollTop }
    onLoadOlder()
  }, [onLoadOlder, hasMoreMessages, messages])
  useLayoutEffect(() => {
    const anchor = olderAnchorRef.current
    if (!anchor) return
    // 请求还在飞：原样等。
    if (loadingOlderMessages) return
    const el = scrollRef.current
    // 跟随态（在底部）不钉位置 —— 让下面贴底 effect 继续跟最新一条。
    if (el && !stickBottomRef.current && messages[0]?.id !== anchor.firstId) {
      el.scrollTop = anchor.top + (el.scrollHeight - anchor.height)
    }
    // 成功（首条已变）/ 失败（首条没变）/ 已无更早 —— 都清门槛，允许再触发。
    olderAnchorRef.current = null
  }, [messages, loadingOlderMessages])
  // 首屏没铺满容器时滚不动（没有 scroll 事件），这里补一次自动上翻，直到填满
  // 或到最早一条。容器还隐藏着（clientHeight=0）时不动，交给下面的 resize 观察。
  useEffect(() => {
    const el = scrollRef.current
    if (!el || !hasMoreMessages || loadingOlderMessages) return
    if (el.clientHeight > 0 && el.scrollHeight <= el.clientHeight + 40) requestOlder()
  }, [messages, hasMoreMessages, loadingOlderMessages, requestOlder])
  // 弹窗从隐藏恢复尺寸时同样补一次（ref 转发，避免 attachScroller 的依赖风暴）。
  const autoFillRef = useRef<() => void>(() => {})
  autoFillRef.current = () => {
    const el = scrollRef.current
    if (!el || !hasMoreMessages || loadingOlderMessages) return
    if (el.scrollHeight <= el.clientHeight + 40) requestOlder()
  }

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
    if (!input.trim()) return
    const raw = input.trim()
    const { text, opts, expert } = takeComposerAttachments(raw)
    const meta = seedMetaNow()
    // 后台等待期（#8）：注进同一条 provider 查询 —— 与 TUI 变体同语义。
    if (streaming) {
      // 事项投递不能走 inject（注入不带 metadata，事项不会被标成 delivered）——
      // 一律排到本轮收口后再发。
      if (meta) pushQueue(text, expert, meta)
      else if (!canInterject || !onInterject) return
      else interjectOrQueue(text, expert)
    } else {
      const sendOpts = { ...(opts ?? {}), ...(meta ? { meta } : {}) }
      onSend(text, Object.keys(sendOpts).length > 0 ? sendOpts : undefined)
    }
    clearSeedItems()
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
  // 停止整轮确认（2026-11-24 用户 #3）：有后台作业在跑时，红方块先弹确认 ——
  // 停止会一并结束那些后台程序（dev 服务等）。仅全域座舱变体。
  const [stopConfirmOpen, setStopConfirmOpen] = useState(false)
  const stopWrapRef = useRef<HTMLSpanElement | null>(null)
  const bgLiveCount = backgroundTasks?.length ?? 0
  useEffect(() => {
    if (!streaming) setStopConfirmOpen(false)
  }, [streaming])
  useEffect(() => {
    if (!stopConfirmOpen) return
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target
      if (target instanceof Node && stopWrapRef.current?.contains(target)) return
      setStopConfirmOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [stopConfirmOpen])
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
      const opts = {
        ...(head.expert ? { subagents: [{ id: head.expert.name, label: head.expert.displayName }] } : {}),
        ...(head.meta ? { meta: head.meta } : {}),
      }
      onSend(head.text, Object.keys(opts).length > 0 ? opts : undefined)
    }
  }, [streaming, tui, onSend, steerActiveRef])

  // 后台等待期（#8）：队列不再无限期干等 —— 队首注进同一条查询（不打断后台）。
  // 注入后队列变短，effect 重跑继续注下一条；SDK 按顺序把它们当各自一轮处理。
  // 没有注入通道（canInterject=false）时维持原语义：等回合收口后 done-flush。
  useEffect(() => {
    if (!tui || !canInterject || !onInterject) return
    if (steerActiveRef?.current) return
    if (queueRef.current.length === 0) return
    const [head, ...rest] = queueRef.current
    setQueue(rest)
    // 注入失败（相位又翻回 generating）→ 队首放回去，消息不丢（用户 #2）。
    const restore = (ok: boolean | void) => {
      if (ok === false) setQueue([head, ...queueRef.current])
    }
    try {
      const result = onInterject(head.text)
      if (result && typeof (result as Promise<boolean>).then === 'function') {
        void (result as Promise<boolean>).then(restore, () => restore(false))
      } else {
        restore(result as boolean | void)
      }
    } catch {
      restore(false)
    }
  }, [canInterject, tui, onInterject, queue.length, steerActiveRef])

  const focusDockInput = () => {
    dockRef.current?.querySelector<HTMLTextAreaElement>('textarea')?.focus()
  }
  const pushQueue = (text: string, expert: ComposerExpertRef | null, meta?: ChatSendMeta) => {
    if (queueRef.current.length >= TUI_QUEUE_MAX) {
      setQueueHint(`队列已满（${TUI_QUEUE_MAX}）`)
      setTimeout(() => setQueueHint(null), 1400)
      return
    }
    setQueue([...queueRef.current, { text, expert, ...(meta ? { meta } : {}) }])
  }
  /**
   * 后台等待期发送（2026-11-24 用户 #2）：注入失败（本地相位过期 / 正好收轮）
   * 时**不能静默丢句话** —— 原来 onInterject 的失败结果被忽略，乐观行撤掉后
   * 用户的消息就凭空消失了。失败一律转入排队，等相位回到 background-wait
   * 或本轮收口后自动补发；排队的消息在输入框上方可见。
   */
  const interjectOrQueue = (text: string, expert: ComposerExpertRef | null) => {
    if (!onInterject) { pushQueue(text, expert); return }
    const fallback = (ok: boolean | void) => {
      if (ok !== false) return
      if (tui) {
        pushQueue(text, expert)
        setQueueHint('注入未成功 · 已转排队')
        setTimeout(() => setQueueHint(null), 1800)
      } else {
        // 非 TUI（classic 通讯台）没有排队区：把原文放回输入框，别让用户的话消失。
        setInput((prev) => (prev.trim() ? `${text}\n${prev}` : text))
        toast('注入未成功 · 已放回输入框')
      }
    }
    try {
      const result = onInterject(text)
      if (result && typeof (result as Promise<boolean>).then === 'function') {
        void (result as Promise<boolean>).then(fallback, () => fallback(false))
      } else {
        fallback(result as boolean | void)
      }
    } catch {
      fallback(false)
    }
  }
  const recallQueue = (i: number) => {
    const back = queueRef.current[i]
    setQueue(queueRef.current.filter((_, j) => j !== i))
    setInput((prev) => (prev.trim() ? `${back.text} ${prev}` : back.text))
    if (back.expert) setAttachedExpert(back.expert)
    focusDockInput()
  }
  const handleTuiKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // v13 全域座舱：⇧⏎ 换行 —— 直接放行浏览器默认行为（textarea 原生插入换行 +
    // 触发受控 onChange）。不要 preventDefault 再 execCommand：实测连打会吞字。
    if (e.key === 'Enter' && isCockpitVariant && e.shiftKey && !e.altKey) return

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
          const meta = seedMetaNow()
          pushQueue(take.text, take.expert, meta)
          clearSeedItems()
        } else {
          handleSend()
        }
        return
      }
      if (queue.length > 0) {
        setInput('')
        const take = takeComposerAttachments(text)
        const meta = seedMetaNow()
        pushQueue(take.text, take.expert, meta)
        clearSeedItems()
        return
      }
      if (streaming) {
        setInput('')
        const take = takeComposerAttachments(text)
        const meta = seedMetaNow()
        // 事项投递（2026-11-24）：不能 inject（带不上 metadata）—— 排队等本轮收口。
        if (meta) {
          pushQueue(take.text, take.expert, meta)
          clearSeedItems()
          return
        }
        // 后台等待期（2026-11-23 用户 #8）：模型空闲、只等后台唤醒 —— 直接把
        // 话注进同一条 provider 查询，不打断后台（2026-11-10 dev-up.sh 事故：
        // Enter 曾经会掐掉服务，后来改成只会排队，但队永远等不到收口）。
        if (canInterject && !resumeTailing && onInterject) {
          interjectOrQueue(take.text, take.expert)
          return
        }
        // 生成中 / 尾随他端回合：本实例没有可掐的流或不该掐 —— 只排队，
        // 回合收口后 done-flush 自动发出。
        if (resumeTailing || (backgroundTasks?.length ?? 0) > 0) {
          pushQueue(take.text, take.expert)
          return
        }
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

  // ── 全域座舱（S5）：把**同一份**提交管线暴露出去 ─────────────────────
  // 不新写 send：submit 走的就是上面 ⏎ 的分支（附件 / 流式排队 / steer），
  // 宿主（CockpitChatHost → ChatPane.onTelemetry.submit）只是换了个触发源。
  // 2026-11-24：submit 可带来源 meta（事项投递）；seed = 预填输入框并挂来源挂件。
  const submitFromBridge = (raw: string, meta?: ChatSendMeta) => {
    const trimmed = raw.trim()
    if (!trimmed) return
    if (!tui) {
      // 非 TUI composer 原本就在流式中直接 return（handleSend 的守卫）。
      if (streaming) return
      const taken = takeComposerAttachments(trimmed)
      const sendOpts = { ...(taken.opts ?? {}), ...(meta ? { meta } : {}) }
      onSend(taken.text, Object.keys(sendOpts).length > 0 ? sendOpts : undefined)
      stickBottomRef.current = true
      return
    }
    if (streaming) {
      const taken = takeComposerAttachments(trimmed)
      // 事项投递（带 meta）不能 inject：排队等本轮收口，出队时随消息带上。
      if (meta) {
        pushQueue(taken.text, taken.expert, meta)
        return
      }
      // 后台等待期：注入同一条查询（不打断后台）—— 与 ⏎ 分支同语义。
      if (canInterject && !resumeTailing && onInterject) {
        interjectOrQueue(taken.text, taken.expert)
        return
      }
      if (queueRef.current.length > 0 || resumeTailing || (backgroundTasks?.length ?? 0) > 0) {
        pushQueue(taken.text, taken.expert)
      } else if (onSteer) {
        onSteer(taken.text, taken.opts)
      } else {
        onStop()
      }
      return
    }
    const taken = takeComposerAttachments(trimmed)
    const sendOpts = { ...(taken.opts ?? {}), ...(meta ? { meta } : {}) }
    onSend(taken.text, Object.keys(sendOpts).length > 0 ? sendOpts : undefined)
    stickBottomRef.current = true
  }

  /** 事项 → 带到输入框：预填文案 + 挂件；发出去才算交付（服务端收到 meta 才关状态）。 */
  const seedFromBridge = (text: string, meta?: ChatSeedMeta) => {
    setInput(text)
    const ids = meta?.via === 'items' && meta.itemIds ? meta.itemIds : []
    if (ids.length > 0) {
      const labels = meta?.labels && meta.labels.length > 0 ? meta.labels : ids
      const next = { ids, labels }
      seedItemsRef.current = next
      setSeedItems(next)
    } else {
      clearSeedItems()
    }
    focusDockInput()
  }

  // ref 每轮渲染后刷新：bridge 里调用到的永远是最新的 handler，
  // 但 ref 本身（以及宿主拿到的 submit 引用）恒稳定。
  useEffect(() => {
    if (!composerBridgeRef) return
    composerBridgeRef.current = {
      submit: submitFromBridge,
      seed: seedFromBridge,
      focus: focusDockInput,
    }
  })
  useEffect(() => () => {
    if (composerBridgeRef) composerBridgeRef.current = null
  }, [composerBridgeRef])

  // 队列深度上报（只在长度变化时触发，宿主别在 render 里读 queue）。
  useEffect(() => {
    onQueueDepthChange?.(queue.length)
  }, [queue.length, onQueueDepthChange])

  const isCockpitVariant = composerVariant === 'cockpit'
  // 全域：标题栏「对话索引」槽（CockpitChatWindow 注册）。classic 拿到 null，
  // 继续用正文右侧那排短杠，行为逐字不变。
  const globalIndexSlot = useChatSlot('index')
  // 全域：标题栏「星核」槽（v22 十轮）—— 挂载面板 portal 进台头。
  const globalAttachSlot = useChatSlot('attach')
  // v22 #5 独立窗：槽是主通讯台的单实例 DOM —— 独立窗抢过去会让主台头部出现
  // 两份索引/星核。独立窗一律用自己窗头的槽（inlineChrome + indexSlot/attachSlot）。 */
  const cockpitIndexSlot = inlineChrome ? (indexSlot ?? null) : globalIndexSlot
  const cockpitAttachSlot = inlineChrome ? (attachSlot ?? null) : globalAttachSlot
  const assistantIdentity = assistantLabel ?? '汐音'

  // ⌥A 开合星核面板（原型口径，由 CockpitShortcuts 发事件）。classic 不响应：
  // 那里的入口在控件条，不抢这个键。
  useEffect(() => {
    if (!isCockpitVariant) return
    const onToggle = () => setAttachOpen((open) => !open)
    window.addEventListener('octopus:composer-attach', onToggle)
    return () => window.removeEventListener('octopus:composer-attach', onToggle)
  }, [isCockpitVariant])

  const busyStartedAt = turnStartedAt ?? (turnStartedAtRef.current || null)
  const busyElapsed = streaming && busyStartedAt ? Math.max(0, (Date.now() - busyStartedAt) / 1000) : 0
  const busyPhase = toolCalls.some((tc) => tc.status === 'start' || tc.status === 'running' || tc.status === 'pending')
    ? 'exec' : 'thinking'
  // 流尾常驻工作行（2026-10-29 用户：输出一开始「Agent 思考中」就消失，干活时
  // 没有任何持续反馈）。阶段 + 真实耗时，整轮在跑时一直挂着，回合结束才退场；
  // 文案按阶段轮换诙谐短语（work-phrases），耗时按 h/m/s 展示（h 封顶、超 24h 继续累计）。
  const workPhase: WorkPhase = busyPhase === 'exec'
    ? 'exec'
    : isThinking ? 'thinking' : streamContent ? 'writing' : 'thinking'
  const workElapsed = Math.floor(busyElapsed)
  const workTone = WORK_PHASE_TONE[workPhase]
  const spinGlyph = TUI_SPIN[Math.floor(busyElapsed * 10) % TUI_SPIN.length]
  // 「等待后台」优先于普通工作行：用户要看到的是后台 shell 在跑什么，
  // 而不是又一句「掐指一算」（2026-11-04）。
  const bgTasks = backgroundTasks ?? []
  const backgroundWait = streaming && bgTasks.length > 0
  const backgroundTitle = bgTasks.map((task) => task.description).join(' / ')
  const backgroundLabel = bgTasks.length <= 2
    ? backgroundTitle
    : `${bgTasks.slice(0, 2).map((task) => task.description).join(' / ')} +${bgTasks.length - 2}`
  const contextUsageTitle = contextUsage
    ? `上下文占用 · ${formatTokenCount(contextUsage.totalTokens)} / ${formatTokenCount(contextUsage.maxTokens, 0)} · ${contextUsage.percentage.toFixed(1)}%${contextUsage.estimated ? '（估算：据最后一轮 token 账本推算，下一轮对话后校准）' : ''}` // fmt-ok: percentage 量纲为 0–100（SDK context_usage），非 0–1 比率
    : ''

  // ── 用户输入历史（右侧时间线）────────────────────────────────────────
  // 折叠态 = 每轮一条短横；悬停展开截断的提示词列表；点击滚动到该轮。
  // 只收真人输入：任务提问/状态事件卡（role=user + displayType=event）与
  // 汐音代你转达的回执不是「我打的字」，点它们只会跳到一张卡（2026-11-17 用户）。
  const userTurns = useMemo(() => userPromptTurns(messages), [messages])
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
    const container = scrollRef.current
    const node = container?.querySelector<HTMLElement>(`[data-message-id="${id}"]`)
    if (!container || !node) return
    // Jumping away from the bottom ends follow-mode; scrolling back re-arms it
    // (the scroll handler above re-sticks within 40px of the bottom).
    stickBottomRef.current = false
    // v21 二轮：只滚转录容器自身，绝不用 scrollIntoView —— 它会把 body / 祖先
    // 一起滚走，整个界面跟着上移（原型实测 bug）。
    const box = container.getBoundingClientRect()
    const target = node.getBoundingClientRect()
    const top = container.scrollTop + (target.top - box.top)
    container.scrollTo({
      top: Math.max(0, Math.min(top, container.scrollHeight - container.clientHeight)),
      behavior: 'smooth',
    })
  }

  // hero 态（2026-10-27 原型 v2）：空会话把 composer 居中，像一个空白工作台；
  // 只对 tui + 显式开启的宿主生效（主对话），草稿工作台行为不变。
  const heroMode = !!tui && !!heroEmpty && !streaming && messages.length === 0

  // 挂载（SKILL / 分身）：普通布局挂在控件条；全域座舱的入口搬到通讯台标题栏
  // 「星核」钮（v22 十轮）—— 同一个子树只渲染一次，portal 进 attach 槽；槽
  // 还没注册（宿主未挂）时退回输入行，功能不丢。
  const attachNode = showComposerAttach ? (
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
      triggerVariant={isCockpitVariant ? 'core' : 'inline'}
    />
  ) : null
  const composerAttach = attachNode && isCockpitVariant && cockpitAttachSlot
    ? createPortal(attachNode, cockpitAttachSlot)
    : attachNode

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
          ref={attachScroller}
          data-testid="chat-transcript-scroll"
          onScroll={(e) => {
            const el = e.currentTarget
            stickBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
            if (el.scrollTop < 80) requestOlder()
          }}
          className="flex-1 overflow-y-auto"
        >
          <div className={tui
            ? (isCockpitVariant
              // 全域座舱（用户 #10）：不再居中、不再 896 上限 —— 内容贴左、
              // 随窗口一起变宽（左内边距 = 1 个字宽，24px）。
              ? cn('w-full px-6 py-4 text-[12.5px] leading-relaxed space-y-2', dockGutter && 'pr-[68px]')
              : cn('mx-auto max-w-4xl px-5 py-4 space-y-1.5 text-[12.5px] leading-relaxed', dockGutter && 'pr-[68px]'))
            : 'max-w-3xl mx-auto px-4 py-4 space-y-2.5'}
            data-tui-col={tui ? '' : undefined}
            data-tui-hero={heroMode ? 'true' : undefined}>
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
            {messages.length > 0 && (hasMoreMessages || loadingOlderMessages) && (
              <button
                type="button"
                data-testid="chat-load-older"
                onClick={requestOlder}
                disabled={loadingOlderMessages}
                className="block w-full select-none py-1 text-center text-[10.5px] text-pop-dim/55 transition-colors hover:text-pop-dim disabled:cursor-default"
              >
                {loadingOlderMessages ? '加载更早的消息…' : '↑ 加载更早的消息'}
              </button>
            )}
            {renderMessages.map(({ msg, compactEvent }) => (
              <Fragment key={msg.id}>
                {tui ? (
                  isCockpitVariant ? (
                    // 2026-11-20 用户 #10（C 版 · classic TUI）：去掉左侧标签列与
                    // 时间 gutter。用户行 `❯ YOU` 与正文同行；助手 `✦ 汐音` 并入
                    // 统计行；正文 / thinking / tool 贴同一条左缘；时间 + 复制常显
                    // 在首行最右（用户行浮在首行右侧，助手行走 TuiMeta 的 trail）。
                    <div className="ck12-tui-msg" data-tui-row={msg.role}>
                      {msg.role === 'user' && !msg.roleSwitch && msg.displayType !== 'event' && (
                        <CockpitMessageActs message={msg} />
                      )}
                      <TuiMessage
                        message={msg}
                        compactEvent={compactEvent}
                        docLinks
                        lead={msg.role === 'assistant' ? <span className="ck12-tui-tag">✦ {assistantIdentity}</span> : undefined}
                        userLead={msg.role === 'user' ? <span className="ck12-tui-tag is-you">❯ YOU</span> : undefined}
                        trail={msg.role === 'assistant' && !msg.roleSwitch && msg.displayType !== 'event'
                          ? <CockpitMessageActs message={msg} />
                          : undefined}
                      />
                    </div>
                  ) : <TuiMessage message={msg} compactEvent={compactEvent} />
                ) : <ChatBubble message={msg} />}
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
              isCockpitVariant ? (
                // 流式过程同款行头：thinking / tool / 正文与历史态同一条左缘。
                <div className="ck12-tui-msg" data-tui-row="assistant">
                  <div className="ck12-tui-livehead"><span className="ck12-tui-tag">✦ {assistantIdentity}</span><span className="ck12-tui-livehint">输出中…</span></div>
                  <TuiLive items={streamTimeline} toolCalls={toolCalls} />
                </div>
              ) : <TuiLive items={streamTimeline} toolCalls={toolCalls} />
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

            {/* 流尾常驻工作行：思考 / 执行工具 / 输出 全程可见，回合结束才消失。 */}
            {streaming && tui && (backgroundWait ? (
              <div
                className="flex items-center gap-2 py-1 text-[12.5px] text-pop-dim"
                data-tui-workline="background"
                title={backgroundTitle}
              >
                <span className={workTone.spin} aria-hidden>{spinGlyph}</span>
                <span className="truncate text-pop-ink/80">
                  后台运行中：{backgroundLabel}
                  {canInterject && <span className="ml-2 text-pop-green">· 可以直接说话</span>}
                </span>
                <span className={`tabular-nums ${workTone.secs}`}>{formatStopwatch(workElapsed * 1000)}</span>
              </div>
            ) : (
              <div
                className="flex items-center gap-2 py-1 text-[12.5px] text-pop-dim"
                data-tui-workline={workPhase}
              >
                <span className={workTone.spin} aria-hidden>{spinGlyph}</span>
                <span className="text-pop-ink/80">{workPhrase(workPhase, workElapsed, busyStartedAt ?? 0)}</span>
                <span className={`tabular-nums ${workTone.secs}`}>{formatStopwatch(workElapsed * 1000)}</span>
              </div>
            ))}

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
      {composerHidden ? (
        // design 25 §5.5：任务线程默认只读 —— 决策在主对话做，这里只是证据面。
        // 「在此处回答（兜底）」是显式开关；打开后才出现输入框（例外路径）。
        <div
          data-testid="composer-readonly-bar"
          className="shrink-0 border-t border-white/[0.06] bg-pop-bg px-4 py-2"
        >
          <div className="mx-auto flex max-w-3xl items-center gap-2 text-[11.5px]">
            <span className="min-w-0 flex-1 truncate text-pop-dim">
              {composerHiddenHint ?? '此线程只读：决定都在主对话里做'}
            </span>
            {onEnableComposer && (
              <button
                type="button"
                data-testid="composer-enable-fallback"
                onClick={onEnableComposer}
                className="shrink-0 rounded-full border border-pop-cyan/40 bg-pop-cyan/10 px-2 py-0.5 font-bold text-pop-cyan transition-colors hover:bg-pop-cyan/20"
              >
                {composerEnableLabel ?? '在此处回答（兜底）'}
              </button>
            )}
          </div>
        </div>
      ) : tui ? (
        <ComposerSlotPortal slot={composerSlot}>
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
          <div className={cn('relative', isCockpitVariant ? 'w-full' : 'mx-auto max-w-4xl')} data-tui-composer>
            {taskProgress && (
              <TaskProgressPanel progress={taskProgress} className="mb-1.5" />
            )}
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
            {(attachedSkill || attachedExpert || seedItems) && (
              <div className="mb-1.5 flex flex-wrap items-center gap-1" data-composer-chips>
                {seedItems && (
                  <span
                    className="ck12-composer-items flex max-w-full items-center gap-1 rounded-full border border-[rgba(61,220,151,.45)] bg-[rgba(61,220,151,.1)] px-2 py-0.5 text-[10.5px] text-[#7ff0bd]"
                    data-composer-items
                    data-testid="composer-items-chip"
                    title="从「事项」窗投递 · 发出去才算交付"
                  >
                    <span aria-hidden>☑</span>
                    <span className="truncate">
                      事项 ×{seedItems.ids.length} · {seedItems.labels.join(' ')}
                    </span>
                    <button
                      type="button"
                      onClick={clearSeedItems}
                      aria-label="取消事项投递"
                      className="text-[#7ff0bd]/70 transition-colors hover:text-pop-red"
                    >
                      <X className="size-2.5" />
                    </button>
                  </span>
                )}
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
                <span aria-hidden data-tui-prompt className="shrink-0 pt-1.5 font-bold leading-6 text-pop-pink">❯</span>
                {/* minRows=2 / maxRows=5（2026-10-30 用户定稿：默认两行高，
                    最长五行，再超出内滚）。行数下限走 rows 属性、上限走 JS ——
                    不写 CSS min/max-height：max-height 会钳住 scrollHeight，
                    几行就不再长高（原型 v2 实测 bug）。
                    v21 二轮：全域通讯台默认一行、最多四行（原型 1→4 行，超出内滚）。 */}
                <AutoResizeTextarea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleTuiKeyDown}
                  minRows={isCockpitVariant ? 1 : 2}
                  maxRows={isCockpitVariant ? 4 : 5}
                  disabled={!!pendingConfirm}
                  placeholder={
                    queue.length > 0
                      ? '继续输入 —— ⏎/⇧⏎ 都会加入排队'
                      : streaming
                        ? canInterject
                          ? '后台任务运行中 —— ⏎ 直接发送（不打断后台）· ⇧⏎ 排队'
                          : '输入新指令 —— ⏎ 打断接管 · ⇧⏎ 不打断排队'
                        : composerPlaceholder ?? '问 task-author…　⏎ 发送 · ⇧⏎ 排队 · Alt⏎ 换行'
                  }
                  className="flex-1 rounded-none border-0 bg-transparent px-0 py-1.5 text-[12.5px] text-pop-ink shadow-none placeholder:text-pop-dim focus-visible:ring-0"
                />
                {isCockpitVariant && queueHint && (
                  <span className="shrink-0 whitespace-nowrap pt-1.5 text-[9.5px] text-pop-red" data-tui-hint>{queueHint}</span>
                )}
                {isCockpitVariant && composerAttach && (
                  cockpitAttachSlot
                    // 已 portal 进台头槽：这里只留 React 挂载位（渲染结果在槽里）。
                    ? composerAttach
                    : <span className="shrink-0 pt-1" data-tui-attach-inline>{composerAttach}</span>
                )}
                <span className="flex shrink-0 items-center gap-1 pt-1" data-tui-send-wrap>
                  {streaming && (
                    <span ref={stopWrapRef} className="relative inline-flex">
                      <button
                        type="button"
                        onClick={() => {
                          // 2026-11-24 用户 #3：有后台作业时先确认 —— 停止整轮会把
                          // 它们一起收掉（provider 对每个后台任务 stopTask + interrupt）。
                          if (isCockpitVariant && bgLiveCount > 0) {
                            setStopConfirmOpen((open) => !open)
                            return
                          }
                          onStop()
                        }}
                        title={
                          bgLiveCount > 0
                            ? `停止整轮（会一并结束 ${bgLiveCount} 个后台作业）`
                            : '停止（esc 同效）'
                        }
                        aria-label="停止生成"
                        aria-expanded={isCockpitVariant && bgLiveCount > 0 ? stopConfirmOpen : undefined}
                        data-tui-stop
                        data-bg-live={isCockpitVariant && bgLiveCount > 0 ? 'true' : undefined}
                        className="grid size-6 place-items-center rounded-md border border-pop-bd text-[10px] text-pop-red transition-colors hover:border-pop-red"
                      >
                        {/* 方块用元素画，不用「■」字形（用户 #19：中断键变形、没居中）。
                            等宽字体里 ■ 的墨迹不在字身中心，再叠 font-weight:800 的
                            合成加粗，方块会被拉歪 —— 几何方块由 grid 居中，跨字体稳定。
                            v21b.css 里这条键的外形也从六角改成了圆角方按钮。 */}
                        <span
                          aria-hidden
                          data-tui-stop-glyph
                          className="block h-3 w-3 rounded-[2.5px] bg-current"
                        />
                        {isCockpitVariant && bgLiveCount > 0 && (
                          <b className="ck12-stopcount" data-testid="cockpit-stop-count">
                            {bgLiveCount}
                          </b>
                        )}
                      </button>

                      {isCockpitVariant && stopConfirmOpen && bgLiveCount > 0 && (
                        <div
                          className="ck12-stopconfirm"
                          role="alertdialog"
                          aria-label="停止整轮确认"
                          data-testid="cockpit-stop-confirm"
                        >
                          <div className="t">⚠ 后台作业还在跑</div>
                          <p>
                            这一轮在等 <b>{bgLiveCount}</b> 个后台作业。点「停止整轮」会
                            一并结束它们 —— 服务会直接停掉。
                          </p>
                          <div className="ck12-stopconfirm-row">
                            <button
                              type="button"
                              onClick={() => setStopConfirmOpen(false)}
                            >
                              继续跑着
                            </button>
                            <button
                              type="button"
                              className="danger"
                              data-testid="cockpit-stop-all"
                              onClick={() => {
                                setStopConfirmOpen(false)
                                onStop()
                              }}
                            >
                              停止整轮
                            </button>
                          </div>
                          <small>
                            只想停单个作业：更多 → 活动日志 → 选择该作业 →「停止作业」。
                          </small>
                        </div>
                      )}
                    </span>
                  )}
                  {(!streaming || canInterject) && (
                    <button
                      type="button"
                      onClick={handleSend}
                      disabled={!input.trim()}
                      title={canInterject ? '发送（不打断后台）' : '发送（⏎ 同效）'}
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
                最右（2026-09-24 用户改判：提示不再单独占输入框下方一行）。
                全域座舱：读数与身份都归舰桥、＋ 并进输入行 —— 整条不渲染，
                底栏只剩 v12 的单行输入（2026-11-14 用户）。 */}
            {!isCockpitVariant && (
            <div className="mt-2 flex min-w-0 items-center gap-1 overflow-x-auto text-[10.5px] text-pop-dim/85 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" data-tui-ctrlbar>
              {composerLeading && (
                <span className="flex shrink-0 items-center gap-1.5" data-composer-leading>{composerLeading}</span>
              )}
              {composerAttach}
              {currentModel && !isCockpitVariant && (
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
              {/* hero 还没有会话：ctx / token 都是空占位，只留模型可选。
                  全域座舱里这些读数已经搬到舰桥（composerVariant='cockpit'）。 */}
              {!heroMode && !isCockpitVariant && (
                <>
                  <span className="hidden items-center gap-1 sm:flex">
                    {contextUsage ? (
                      <Popover open={contextExpanded} onOpenChange={setContextExpanded}>
                          <PopoverTrigger asChild>
                            <button
                              type="button"
                              title={contextUsageTitle}
                              aria-label={contextUsageAriaLabel(contextUsage)}
                              className="shrink-0 rounded-full outline-none focus-visible:ring-1 focus-visible:ring-pop-bd"
                              data-tui-ctx
                            >
                              {/* 2026-10-29 用户：`80.1K / 1M · 8.0%`，框住 + 进度样式 */}
                              <ContextUsageChip
                                contextUsage={contextUsage}
                                expanded={contextExpanded}
                                className={contextExpanded ? 'bg-pop-paper' : undefined}
                              />
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
                      <ContextUsagePlaceholder />
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
              {/* 当前身份贴纸（2026-10-30）：tok / task 之后。任务线程只读，
                  普通会话悬停 ✕ 清除回主身份；hero 新会话由下方选择器承担。
                  全域座舱（2026-11-14 用户）：身份搬进舰桥，跟模型 / token 同一行，
                  composer 下不再单独占一行。 */}
              {identityDisplay && !isCockpitVariant && <ComposerIdentityChip display={identityDisplay} />}
              <span className="ml-auto hidden min-w-0 items-center justify-end gap-2 text-[10.5px] sm:flex">
                {/* 2026-10-29 用户：流尾工作行已经在对话里持续报状态/计时，
                    输入框下方不再重复一条 `⠋ thinking 2.1s`。 */}
                {queueHint ? (
                  <span className="shrink-0 text-pop-red" data-tui-hint>{queueHint}</span>
                ) : queue.length > 0 ? (
                  <span className="truncate" data-tui-hint>⏎ 继续排队 · ⇧⏎ 排队 · esc 退回输入框 <span className="opacity-70">队列 {queue.length}/{TUI_QUEUE_MAX} · done 即发</span></span>
                ) : streaming ? (
                  <span className="shrink-0" data-tui-hint>
                    {resumeTailing
                      ? '⏎ 排队（正在跟随另一窗口的回合，结束即发）'
                      : bgTasks.length > 0
                        ? '⏎ 排队（后台任务运行中，结束即发）· esc 停止'
                        : '⏎ 打断并接管 · ⇧⏎ 不打断，排队 · esc 打断'}
                  </span>
                ) : (
                  <span className="shrink-0" data-tui-hint>⏎ 发送 · ⇧⏎ 排队 · Alt⏎ 换行</span>
                )}
              </span>
            </div>
            )}
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
        </ComposerSlotPortal>
      ) : (
      <ComposerSlotPortal slot={composerSlot}>
      <div className="border-t-[1.5px] border-pop-bd bg-pop-paper p-3">
        <div className="max-w-3xl mx-auto relative">
          {taskProgress && <TaskProgressPanel progress={taskProgress} className="mb-2" />}
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
              minRows={2}
              maxRows={5}
              placeholder={
                streaming
                  ? canInterject
                    ? '后台任务运行中 —— 可以直接输入（⏎ 发送，不打断后台）'
                    : 'Agent 正在回复中...'
                  : composerPlaceholder ?? '输入消息，/ 调用技能，@@ 委托分身，Enter 发送'
              }
              disabled={(streaming && !canInterject) || !!pendingConfirm}
              className="rounded-none border-0 bg-transparent px-3.5 pb-1 pt-2.5 text-[12.5px] text-pop-ink shadow-none focus-visible:ring-0"
            />
            <div
              data-composer-toolbar
              className="flex items-center gap-[3px] border-t-[1.5px] border-dashed border-pop-bd/25 px-1.5 py-1 pr-2.5"
            >
              {composerLeading && (
                <div className="mr-1 flex shrink-0 items-center gap-1.5" data-composer-leading>{composerLeading}</div>
              )}
              {/* 原型 cmp-bar：model / ctx / 会话账同高 22px、等宽字、无 emoji。
                  全域座舱：这些读数归舰桥，composer 只留输入与动作。 */}
              {currentModel && !isCockpitVariant && (
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
              {!isCockpitVariant && (contextUsage ? (
                <Popover open={contextExpanded} onOpenChange={setContextExpanded}>
                  <PopoverTrigger asChild>
                    <button
                      type="button"
                      title={contextUsageTitle}
                      aria-label={contextUsageAriaLabel(contextUsage)}
                      className="shrink-0 rounded-full outline-none focus-visible:ring-1 focus-visible:ring-pop-bd"
                    >
                      <ContextUsageChip
                        contextUsage={contextUsage}
                        expanded={contextExpanded}
                        className={contextExpanded ? 'bg-pop-paper' : undefined}
                      />
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
                <ContextUsagePlaceholder />
              ) : null)}
              {!isCockpitVariant && (taskUsage !== undefined ? (
                      <TaskCostChip usage={taskUsage} placeholder={showUsagePlaceholders} />
                    ) : (
                      <SessionCostChip usage={sessionUsage} contextUsage={contextUsage} placeholder={showUsagePlaceholders} />
                    ))}
              {identityDisplay && <ComposerIdentityChip display={identityDisplay} />}
              <span className="ml-auto flex shrink-0 items-center gap-1.5">
                {streaming && (
                  <Button
                    onClick={onStop}
                    variant="outline"
                    size="icon"
                    title={canInterject ? '停止整轮（会结束后台任务）' : undefined}
                    className="h-8 w-8 rounded-xl border-2 border-pop-bd bg-pop-paper text-pop-red shadow-pop-sm pop-press hover:bg-pop-pink-soft"
                  >
                    <Square className="h-3.5 w-3.5" />
                  </Button>
                )}
                {(!streaming || canInterject) && (
                  <Button
                    onClick={handleSend}
                    disabled={!input.trim()}
                    size="icon"
                    title={canInterject ? '发送（不打断后台）' : undefined}
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
      </ComposerSlotPortal>
      )}

      <ChatTimeline
        items={userTurns}
        activeId={activeTurnId}
        onJump={jumpToTurn}
        clearDock={timelineClearDock}
        compact={isCockpitVariant}
        portalHost={isCockpitVariant ? cockpitIndexSlot : null}
        hostSelector={chromeHostSelector}
      />
    </div>
  )
}

/** composer 的挂载壳：有槽就 portal（全域底栏），没槽就是今天的内联渲染。
 *  portal 不改 DOM 结构、不复制 composer —— 同一个 React 子树只渲染一次。 */
function ComposerSlotPortal({ slot, children }: { slot?: HTMLElement | null; children: ReactNode }) {
  if (!slot) return <>{children}</>
  return createPortal(children, slot)
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
