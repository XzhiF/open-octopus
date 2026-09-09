'use client'

import { useState, useRef, useEffect, useMemo } from 'react'
import { Send, Square, MessageSquare, ChevronUp, ChevronDown } from 'lucide-react'
import type { AgentMessage, ToolCallRecord, ContextUsageData } from '@/lib/agent/types'
import type { StreamTimelineItem } from '@/hooks/useAgentChat'
import { AutoResizeTextarea } from '@/components/ui/auto-resize-textarea'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { formatTokenCount } from '@/lib/format'
import { ChatBubble } from './ChatBubble'
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
  waiting: { band: 'bg-pop-amber-soft text-amber-800 dark:text-amber-300', dot: 'bg-pop-amber', text: '❓ 等待你的输入', sub: '回答上方问题即继续' },
  done: { band: 'bg-pop-green-soft text-green-800 dark:text-green-300', dot: 'bg-pop-green', text: '✓ 就绪', sub: '随时发送下一条' },
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
}

export function ChatArea({
  messages, streaming, streamContent, streamThinking, isThinking, toolCalls, streamTimeline, pendingConfirm,
  error, statusMessage, onSend, onStop, onConfirm, hasSession, currentCloneName, streamSource,
  reviewItems, onReviewAction,
  emptyStateTitle, emptyStateDescription, hideEmptyState,
  commands, contextUsage, currentModel, onModelChange,
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
          <div className="max-w-3xl mx-auto px-4 py-6 space-y-4">
            {Array.from(new Map(messages.map(m => [m.id, m])).values()).map((msg) => (
              <ChatBubble key={msg.id} message={msg} />
            ))}

            {/* Streaming: interleaved timeline (2026-08-19 UX fix) — thinking /
                tool / text segments in ARRIVAL order. Thinking shows as
                in-flow cards (like tool calls) instead of one pinned top
                block; when the stream completes, the final ChatBubble merges
                thinking into its collapsible meta. */}
            {streaming && streamTimeline && streamTimeline.length > 0 && (
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
            )}

            {/* Legacy fixed-order layout for consumers without streamTimeline */}

            {/* Streaming: thinking first */}
            {streaming && !streamTimeline && streamThinking && (
              <div className="border-l-2 border-agent-divider pl-3 py-1">
                <div className="flex items-center gap-1 text-xs text-muted-foreground mb-1">
                  <span className="animate-pulse">💭</span> 思考中{isThinking ? '...' : ' (完成)'}
                </div>
                <AutoFollowPre text={streamThinking} />
              </div>
            )}

            {/* Streaming: tool calls second */}
            {streaming && !streamTimeline && toolCalls.length > 0 && (
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
            {streaming && !streamTimeline && streamContent && (
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

      {/* 🎪 状态色带 — composer 上方的贴纸 pill(derived from props,无新链路) */}
      {hasSession && chatState !== 'idle' && (
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

      {/* Input area — always visible */}
      <div className="border-t-[2.5px] border-pop-bd bg-pop-paper p-4">
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

          <div className="flex items-end gap-2">
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
              placeholder={streaming ? 'Agent 正在回复中...' : '输入消息，/ 调用技能，@@ 委托分身，Enter 发送'}
              disabled={streaming || !!pendingConfirm}
              className={cn(
                'min-h-[44px] max-h-[200px] resize-none rounded-xl border-2 border-pop-bd text-pop-ink focus-visible:ring-pop-bd',
                chatState === 'waiting' ? 'bg-pop-amber-soft' : 'bg-pop-bg',
              )}
            />
            {streaming ? (
              <Button
                onClick={onStop}
                variant="outline"
                size="icon"
                className="shrink-0 h-10 w-10 rounded-xl border-2 border-pop-bd bg-pop-paper text-pop-red shadow-pop-sm pop-press hover:bg-pop-pink-soft"
              >
                <Square className="h-4 w-4" />
              </Button>
            ) : (
              <Button
                onClick={handleSend}
                disabled={!input.trim()}
                size="icon"
                className="shrink-0 h-10 w-10 rounded-xl border-2 border-pop-bd bg-pop-green text-white shadow-pop-sm pop-press hover:bg-pop-green/90"
              >
                <Send className="h-4 w-4" />
              </Button>
            )}
          </div>

          {/* ── Status bar: context usage + model selector ── */}
          {(contextUsage || currentModel) && (
            <div className="flex items-center gap-2 mt-1.5 text-[10px] text-muted-foreground">
              {/* Context usage */}
              {contextUsage && (
                <button
                  onClick={() => setContextExpanded(!contextExpanded)}
                  className="flex items-center gap-1 hover:text-foreground transition-colors"
                  title="Context window usage"
                >
                  <span>📋</span>
                  <span>{formatTokenCount(contextUsage.totalTokens)} / {formatTokenCount(contextUsage.maxTokens)}</span>
                  <span className="opacity-60">({contextUsage.percentage.toFixed(1)}%) {/* fmt-ok: percentage 量纲未经 server 核实（providers wire），待查后收编 */}</span>
                  {contextExpanded ? <ChevronDown className="size-2.5" /> : <ChevronUp className="size-2.5" />}
                </button>
              )}
              {/* Spacer */}
              {contextUsage && currentModel && <span className="opacity-30">│</span>}
              {/* Model selector */}
              {currentModel && onModelChange && (
                <div className="flex items-center gap-1">
                  <span>🧠</span>
                  <select
                    value={currentModel}
                    onChange={(e) => onModelChange(e.target.value)}
                    className="bg-transparent border-none p-0 text-[10px] text-muted-foreground hover:text-foreground cursor-pointer focus:outline-none appearance-none"
                  >
                    <option value="pro-max">pro-max</option>
                    <option value="pro">pro</option>
                    <option value="se">se</option>
                  </select>
                </div>
              )}
              {currentModel && !onModelChange && (
                <div className="flex items-center gap-1">
                  <span>🧠</span>
                  <span>{currentModel}</span>
                </div>
              )}
            </div>
          )}

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
