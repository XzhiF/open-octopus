'use client'

// TUI (claude-code 终端皮肤) 消息渲染 —— 任务草稿工作台专用（2026-09-24 TUI 改版）。
// 原型 = public/prototype/chat-tui.html：`❯` 用户行 / `✳` agent 行 /
// `◌ 过程（时间序）· N 步` 折叠 meta（对话完成后思考、步骤收起，沿用原交互）。

import { useMemo, useState, type ReactNode } from 'react'
import type { AgentMessage, MessageTimelineEntry, ToolCallRecord } from '@/lib/agent/types'
import type { StreamTimelineItem } from '@/hooks/useAgentChat'
import { formatDuration, formatPercent, formatTokenCount } from '@/lib/format'
import type { TurnStats } from '@/lib/turn-stats'

/** mini-markdown：`**bold**` / `行内 code` / 行首 # 标题 —— 消灭字面星号。 */
function mdInline(text: string): ReactNode {
  return text.split(/(\*\*[^*\n]+\*\*|`[^`\n]+`)/g).map((p, i) => {
    if (/^\*\*[^*]+\*\*$/.test(p)) return <strong key={i} className="font-bold text-pop-pink">{p.slice(2, -2)}</strong>
    if (/^`[^`]+`$/.test(p)) return <code key={i} className="rounded-[3px] bg-pop-bd/50 px-1 text-pop-green">{p.slice(1, -1)}</code>
    return p
  })
}

function mdLine(line: string): ReactNode {
  const h = line.match(/^(#{1,4})\s+(.*)$/)
  if (h) return <span className="font-bold text-pop-ink">{mdInline(h[2])}</span>
  return mdInline(line)
}

/** 段首小 ✳：每段回复仅一个，缩小提亮（原型 v4.3 拍板）。 */
function TuiMark() {
  return <span aria-hidden data-tui-mark className="mr-1.5 align-baseline text-[11px] font-bold text-pop-pink/85">✳</span>
}

/** 工具行一句话摘要：name + 首个字符串参数（截断）。 */
export function toolBrief(tc: ToolCallRecord): string {
  const inp = tc.input
  if (inp && typeof inp === 'object') {
    const first = Object.values(inp as Record<string, unknown>).find((v) => typeof v === 'string')
    if (typeof first === 'string' && first.trim()) {
      return `${tc.name} ${first.trim().split('\n')[0].slice(0, 60)}`
    }
  }
  return tc.name
}

function toolStatusMark(status: string): { glyph: string; cls: string } {
  if (status === 'success' || status === 'result') return { glyph: '✓', cls: 'text-pop-green' }
  if (status === 'fail') return { glyph: '✗', cls: 'text-pop-red' }
  return { glyph: '…', cls: 'text-pop-dim' }
}

/** 工具载荷 → 可读文本：字符串原样，对象美化 JSON，异常兜底 String。 */
function fmtToolPayload(v: unknown): string {
  if (typeof v === 'string') return v
  try { return JSON.stringify(v, null, 2) } catch { return String(v) }
}

/** 工具调用行：默认一行简报（名+首参+状态）；点击 ▸/▾ 展开本工具**做了什么**——
 *  input 全量 + 到齐后的 result 全量（各自限高可滚，pre-wrap 不截行）。
 *  流式（TuiLive）与历史（TuiMeta）共用，2026-10-10 用户真机需求。 */
function ToolLine({ tc }: { tc: ToolCallRecord }) {
  const { glyph, cls } = toolStatusMark(tc.status)
  const [open, setOpen] = useState(false)
  const hasInput = tc.input !== undefined && tc.input !== null && tc.input !== ''
  const hasResult = tc.result !== undefined && tc.result !== null && tc.result !== ''
  return (
    <div className="text-pop-dim" data-tui-tool={open ? 'open' : 'closed'}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="block w-full select-none text-left transition-colors hover:text-pop-ink"
        title={open ? '收回工具详情' : '展开本工具 input/result 全文'}
      >
        <span className="text-pop-pink">{open ? '▾ ' : '▸ '}</span>
        {toolBrief(tc)} <span className={cls}>[{glyph}]</span>
      </button>
      {open && (
        <div className="ml-3 mt-0.5 space-y-1.5 border-l border-pop-bd pl-2">
          <div>
            <div className="text-[10px] font-black text-pop-cyan">input · {tc.name}</div>
            <pre className="max-h-[30vh] overflow-y-auto whitespace-pre-wrap break-words">{hasInput ? fmtToolPayload(tc.input) : '（暂无输入）'}</pre>
          </div>
          {hasResult && (
            <div>
              <div className="text-[10px] font-black text-pop-green">result</div>
              <pre className="max-h-[30vh] overflow-y-auto whitespace-pre-wrap break-words">{fmtToolPayload(tc.result)}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/** 折叠的过程 meta：thinking / tool 按时间序（timeline 缺失时用字段兜底）。 */
type MetaRow = { key: string; node: 'think' | 'tool' | 'frag'; text?: string; tc?: ToolCallRecord }

function TuiMeta({ thinking, toolCalls, timeline, stats }: {
  thinking?: string
  toolCalls?: ToolCallRecord[]
  timeline?: MessageTimelineEntry[]
  stats?: TurnStats
}) {
  const [open, setOpen] = useState(false)
  const rows = useMemo<MetaRow[]>(() => {
    // The server column can hand over a non-array (legacy "{}" rows) — treating
    // it as a list here would throw and blank the whole transcript.
    const toolList = Array.isArray(toolCalls) ? toolCalls : []
    const out: MetaRow[] = []
    if (timeline?.length) {
      for (const e of timeline) {
        if (e.kind === 'thinking' && e.text) out.push({ key: `th-${out.length}`, node: 'think', text: e.text })
        else if (e.kind === 'tool') {
          const tc = toolList.find((t) => t.id === e.id)
          if (tc) out.push({ key: `tc-${e.id}`, node: 'tool', tc })
        } else if (e.kind === 'text' && e.text) out.push({ key: `fx-${out.length}`, node: 'frag', text: e.text })
      }
    } else {
      if (thinking) out.push({ key: 'th-0', node: 'think', text: thinking })
      for (const tc of toolList) out.push({ key: `tc-${tc.id}`, node: 'tool', tc })
    }
    return out
  }, [thinking, toolCalls, timeline])

  const counts = useMemo(() => {
    let tools = 0
    let failed = 0
    let thinks = 0
    for (const r of rows) {
      if (r.node === 'tool') {
        tools++
        if (r.tc?.status === 'fail') failed++
      } else if (r.node === 'think') thinks++
    }
    return { tools, failed, thinks }
  }, [rows])

  if (rows.length === 0) return null

  const duration = stats?.durationMs != null && stats.durationMs > 0
    ? formatDuration(stats.durationMs)
    : null
  const tokens = stats && stats.tokens > 0 ? formatTokenCount(stats.tokens) : null
  const cachePct = stats?.cacheHitRate != null ? formatPercent(stats.cacheHitRate) : null
  const cacheTitle = stats && cachePct != null
    ? `缓存读 ${formatTokenCount(stats.cacheReadTokens)} / 写 ${formatTokenCount(stats.cacheCreationTokens)}`
    : undefined

  return (
    <div className="my-1" data-tui-meta-root>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full select-none flex-wrap items-center gap-x-1.5 gap-y-1 rounded-[6px] bg-white/[0.035] px-2 py-[3px] text-left text-pop-dim transition-colors hover:bg-white/[0.06] hover:text-pop-ink"
        data-tui-meta={open ? 'open' : 'closed'}
        title={
          'turn = 一条用户消息 + 助手这一整段回复。步数 = 思考段 + 工具调用 + 正文段；时长 / token / 缓存来自会话账本，旧轮没有账本行时只显示步数与次数。'
        }
      >
        <span className="rounded-full bg-pop-pink px-1.5 text-[10px] font-extrabold leading-[15px] tracking-wider text-pop-bg">TURN</span>
        <span className="font-semibold text-pop-pink">{rows.length} 步</span>
        {/* 收起态显示全部摘要；展开后只留「TURN · N 步」，数字下移到明细行，避免重复。 */}
        {!open && duration && (
          <>
            <span className="text-pop-dim">·</span>
            <span className="text-pop-pink tabular-nums" data-tui-duration>
              {duration}
            </span>
          </>
        )}
        {!open && (
          <>
            <span className="text-pop-dim">·</span>
            <span className="text-pop-cyan">工具 {counts.tools}</span>
            <span className="text-pop-dim">·</span>
            <span className="text-pop-purple">思考 {counts.thinks}</span>
          </>
        )}
        {!open && tokens && (
          <>
            <span className="text-pop-dim">·</span>
            <span className="text-pop-green tabular-nums">{tokens} tok</span>
          </>
        )}
        {!open && cachePct && (
          <>
            <span className="text-pop-dim">·</span>
            <span className="text-pop-amber tabular-nums" title={cacheTitle}>缓存 {cachePct}</span>
          </>
        )}
        <span className="ml-auto pl-2">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="mt-1" data-tui-meta-body>
          {/* 展开态：纯文本统计行 + 原步骤列表。 */}
          <div className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10.5px] text-pop-dim" data-tui-stats-line>
            {duration && (
              <span className="text-pop-pink tabular-nums" title="本轮耗时（账本首尾 call；旧轮无账本行不显示）">
                {duration}
              </span>
            )}
            <span className="text-pop-cyan" title="工具调用次数 / 失败次数">
              工具 {counts.tools}{counts.failed > 0 ? `（失败 ${counts.failed}）` : ''}
            </span>
            <span className="text-pop-purple" title="思考段数（timeline 里 thinking 段，不是字数）">
              思考 {counts.thinks}
            </span>
            {stats && stats.tokens > 0 && (
              <span
                className="text-pop-green tabular-nums"
                title={`输入 ${formatTokenCount(stats.inputTokens)} · 输出 ${formatTokenCount(stats.outputTokens)} · 含缓存合计 ${formatTokenCount(stats.tokens)}`}
              >
                输入 {formatTokenCount(stats.inputTokens)} · 输出 {formatTokenCount(stats.outputTokens)} · 合计 {formatTokenCount(stats.tokens)} tok
              </span>
            )}
            {cachePct && stats && (
              <span className="text-pop-amber" title="缓存命中率 = cacheRead ÷ (input + cacheRead + cacheCreation)">
                缓存命中 {cachePct}（读 {formatTokenCount(stats.cacheReadTokens)} / 写 {formatTokenCount(stats.cacheCreationTokens)}）
              </span>
            )}
            {stats && stats.calls > 1 && (
              <span title="本轮 llm_calls 行数（重试 = 新行）">{stats.calls} 次请求</span>
            )}
            {stats && stats.models.length > 0 && (
              <span title={stats.models.join(' · ')}>
                {stats.models[0]}{stats.models.length > 1 ? ` +${stats.models.length - 1}` : ''}
              </span>
            )}
          </div>
          <div className="ml-3 space-y-0.5 border-l border-pop-bd pl-3">
            {rows.map((r) =>
              r.node === 'tool' && r.tc ? (
                <ToolLine key={r.key} tc={r.tc} />
              ) : r.node === 'frag' ? (
                <div key={r.key} className="whitespace-pre-wrap break-words text-pop-dim">✎ {r.text}</div>
              ) : (
                <div key={r.key} className="whitespace-pre-wrap break-words text-pop-dim">◌ {r.text}</div>
              ),
            )}
          </div>
        </div>
      )}
    </div>
  )
}

/** Server-originated activity card (workflow approval/failure/completion, task
 *  terminal states). Append-only in the transcript; never mutates the system
 *  prompt, so the cached prefix stays intact. */
function ActivityEventCard({ message }: { message: AgentMessage }) {
  const activity = message.activity
  const severity = activity?.severity
  const tone =
    severity === 'critical'
      ? 'border-pop-red/40 bg-pop-red/[0.06] text-pop-red'
      : severity === 'warn'
        ? 'border-pop-amber/40 bg-pop-amber/[0.06] text-pop-amber'
        : 'border-pop-cyan/35 bg-pop-cyan/[0.05] text-pop-cyan'
  const mark = severity === 'critical' ? '✕' : severity === 'warn' ? '!' : '✓'
  const summary = message.content.split('\n').slice(1).find((line) => line.trim() && !line.startsWith('请判断'))?.trim()
  const canOpenWorkflow = !!activity?.executionId && !!activity?.workspaceId

  // 2026-10-28 task-thread: the card's buttons are a protocol, not local logic:
  // ChatTab listens for these and owns the handlers (trigger/accept/archive…).
  const actions = Array.isArray(activity?.actions) ? activity!.actions! : []
  const entries = (() => {
    const raw = (activity?.payload as { entries?: unknown } | undefined)?.entries
    return Array.isArray(raw)
      ? (raw as Array<{ id: string; title: string; target?: string }>)
      : []
  })()
  const fireAction = (actionId: string) => {
    window.dispatchEvent(new CustomEvent('octopus:task-card-action', {
      detail: { taskId: activity?.taskId ?? null, activity, actionId },
    }))
  }
  const decideReflection = (entryId: string, action: 'ingest' | 'skip') => {
    window.dispatchEvent(new CustomEvent('octopus:reflection-decision', {
      detail: { taskId: activity?.taskId ?? null, entryId, action },
    }))
  }

  return (
    <div
      data-tui-msg="event"
      data-message-id={message.id}
      data-testid="activity-event-card"
      className={`rounded-md border px-3 py-2 font-mono text-[11.5px] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.03)] ${tone}`}
    >
      <div className="flex items-center gap-2">
        <span aria-hidden className="grid size-4 place-items-center rounded-full border border-current text-[9px]">
          {mark}
        </span>
        <span className="min-w-0 flex-1 truncate font-semibold">
          {activity?.title ?? '活动通知'}
        </span>
        {canOpenWorkflow && (
          <button
            type="button"
            onClick={() =>
              window.dispatchEvent(new CustomEvent('octopus:open-workflow', {
                detail: {
                  workspaceId: activity?.workspaceId,
                  executionId: activity?.executionId,
                  title: activity?.title,
                },
              }))
            }
            className="shrink-0 rounded border border-current/30 px-1.5 py-0.5 text-[10px] opacity-80 transition-opacity hover:opacity-100"
          >
            打开 DAG
          </button>
        )}
      </div>
      {summary && <div className="mt-1 pl-6 text-pop-dim">{summary}</div>}
      {activity?.nodeId && <div className="mt-0.5 pl-6 text-[10px] text-pop-dim">node · {activity.nodeId}</div>}
      {entries.length > 0 && (
        <div className="mt-2 space-y-1 pl-6" data-testid="reflection-entries">
          {entries.map((entry) => (
            <div key={entry.id} className="rounded border border-current/20 bg-black/10 px-2 py-1.5">
              <div className="text-[10.5px] font-semibold text-pop-ink">{entry.title}</div>
              {entry.target && <div className="text-[9px] text-pop-dim">{entry.target}</div>}
              <div className="mt-1 flex gap-1">
                <button type="button" onClick={() => decideReflection(entry.id, 'ingest')}
                  className="rounded bg-pop-purple px-1.5 py-0.5 text-[9px] font-black text-pop-bg">
                  落 wiki
                </button>
                <button type="button" onClick={() => decideReflection(entry.id, 'skip')}
                  className="rounded border border-current/30 px-1.5 py-0.5 text-[9px] text-pop-dim hover:text-pop-ink">
                  跳过
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      {actions.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1 pl-6" data-testid="task-card-actions">
          {actions.map((action) => (
            <button
              key={action.id}
              type="button"
              onClick={() => fireAction(action.id)}
              className="rounded border border-current/30 bg-black/10 px-1.5 py-0.5 text-[10px] text-pop-ink transition-colors hover:bg-white/[0.08]"
            >
              {action.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** 身份切换标记（v59）：一行 + 可折叠的岗位包全文。追加式，永不改写。 */
export function RoleSwitchCard({ payload }: { payload: NonNullable<AgentMessage['roleSwitch']> }) {
  const [open, setOpen] = useState(false)
  const isReset = payload.kind === 'reset'
  return (
    <div
      data-testid="role-switch-card"
      data-role-switch={payload.kind}
      className="rounded-md border border-pop-purple/35 bg-pop-purple-soft/20 px-3 py-1.5 font-mono text-[11.5px]"
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={open ? '收起岗位包' : '查看岗位包全文'}
        className="flex w-full items-center gap-2 text-left transition-colors hover:text-pop-ink"
      >
        <span aria-hidden className="text-pop-purple">⬢</span>
        <span className="min-w-0 flex-1 truncate text-pop-dim">
          {isReset ? '已解除分身身份 · 回到基础角色' : `已切换分身身份 · ${payload.displayName}`}
          <span className="ml-1.5 text-pop-dim/60">rev {payload.revision}</span>
        </span>
        <span className="shrink-0 text-[10px] text-pop-dim/70">{open ? '▾ 收起' : '▸ 查看岗位包'}</span>
      </button>
      {open && (
        <pre className="mt-1.5 max-h-[40vh] overflow-y-auto whitespace-pre-wrap break-words border-l border-pop-purple/40 pl-2 text-[11px] leading-relaxed text-pop-dim">
          {payload.card}
        </pre>
      )}
    </div>
  )
}

export function TuiMessage({ message }: { message: AgentMessage }) {
  const isUser = message.role === 'user'
  const timeline = !isUser ? message.timeline : undefined
  const hasTimeline = !!timeline && timeline.length > 0

  // 与 ChatBubble 同语义：有 timeline 时正文只显最后一段 text，其余收进 meta。
  // Hooks must run before the early returns below — a message that flips between
  // roleSwitch / event / normal types across renders would otherwise change the
  // hook order (React: "Rendered fewer hooks than expected").
  const displayContent = useMemo(() => {
    if (!hasTimeline) return message.content
    const texts = timeline!.filter((e) => e.kind === 'text' && e.text)
    const last = texts[texts.length - 1]
    return last?.text ?? message.content
  }, [hasTimeline, timeline, message.content])

  if (message.roleSwitch) {
    return <RoleSwitchCard payload={message.roleSwitch} />
  }

  if (message.displayType === 'event') {
    return <ActivityEventCard message={message} />
  }

  if (isUser) {
    return (
      <div
        className="scroll-mt-6 rounded-md bg-pop-paper px-3 py-1.5 shadow-[inset_0_0_0_1px_var(--pop-bd)]"
        data-tui-msg="user"
        data-message-id={message.id}
      >
        <span className="font-bold text-pop-pink">❯ </span>
        <span className="break-words whitespace-pre-wrap">{message.content}</span>
      </div>
    )
  }

  const metaCount = (hasTimeline ? timeline!.length : 0) + (message.thinking && !hasTimeline ? 1 : 0)
  return (
    <div data-tui-msg="assistant" data-message-id={message.id}>
      <TuiMeta
        thinking={message.thinking}
        toolCalls={message.tool_calls}
        timeline={timeline}
        stats={message.turnStats}
      />
      {displayContent
        ? (
          <div className="break-words whitespace-pre-wrap">
            <TuiMark />
            {displayContent.split('\n').map((line, i) => (
              <span key={i}>{i > 0 && '\n'}{mdLine(line)}</span>
            ))}
          </div>
        )
        : metaCount > 0 && <div className="text-pop-dim"><TuiMark />（未生成文本回复）</div>}
      {message.interrupted && (
        <div className="text-pop-red" data-tui-interrupted>（本轮被截断）</div>
      )}
    </div>
  )
}

/** 流式 thinking 段：默认 3 行活窗口（旧行渐隐、行内截断）；
 *  点击标题展开 = 本段全文逐字（pre-wrap 不截行、限高可滚），再点收回。
 *  完成后历史态本就全量（TuiMeta），此处只补流式期的「看全」出口。 */
function LiveThinking({ item }: { item: Extract<StreamTimelineItem, { kind: 'thinking' }> }) {
  const [open, setOpen] = useState(false)
  const win = item.text.split('\n').slice(-3)
  return (
    <div data-tui-thinking className="text-pop-dim">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="select-none transition-colors hover:text-pop-ink"
        data-tui-thinking-expand={open ? 'open' : 'closed'}
        title={open ? '收回 3 行窗口' : '展开本段 thinking 全文'}
      >
        ◌ thinking
        {item.active && <span className="ml-1 animate-pulse text-pop-pink">▊</span>}
        <span className="ml-1 text-[10px]">{open ? '▾ 全文' : '▸ 全文'}</span>
      </button>
      {open ? (
        <div className="ml-3 max-h-[50vh] overflow-y-auto whitespace-pre-wrap break-words border-l border-pop-bd pl-2">{item.text}</div>
      ) : (
        <div className="ml-3 overflow-hidden border-l border-pop-bd pl-2">
          {win.map((l, i) => (
            <div
              key={i}
              className={
                'truncate' +
                (win.length === 3 && i === 0 ? ' opacity-40' : win.length >= 2 && i === win.length - 2 ? ' opacity-70' : '')
              }
            >
              {l || ' '}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** 流式中的即时过程行（到达序），结束后由 TuiMessage 的折叠 meta 接管。 */
export function TuiLive({ items, toolCalls }: {
  items: StreamTimelineItem[]
  toolCalls: ToolCallRecord[]
}) {
  return (
    <div data-tui-live className="space-y-0.5">
      {items.map((item) => {
        if (item.kind === 'thinking') return <LiveThinking key={item.id} item={item} />
        if (item.kind === 'tool') {
          const tc = toolCalls.find((t) => t.id === item.id)
          return tc ? <ToolLine key={item.id} tc={tc} /> : null
        }
        return (
          <div key={item.id} className="break-words whitespace-pre-wrap">
            <TuiMark />
            {item.text.split('\n').map((line, i) => (
              <span key={i}>{i > 0 && '\n'}{mdLine(line)}</span>
            ))}
            <span className="animate-pulse text-pop-pink">▊</span>
          </div>
        )
      })}
    </div>
  )
}
