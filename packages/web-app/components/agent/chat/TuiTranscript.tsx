'use client'

// TUI (claude-code 终端皮肤) 消息渲染 —— 任务草稿工作台专用（2026-09-24 TUI 改版）。
// 原型 = public/prototype/chat-tui.html：`❯` 用户行 / `✳` agent 行 /
// `◌ 过程（时间序）· N 步` 折叠 meta（对话完成后思考、步骤收起，沿用原交互）。

import { useMemo, useState, type ReactNode } from 'react'
import type { AgentMessage, MessageTimelineEntry, ToolCallRecord } from '@/lib/agent/types'
import type { StreamTimelineItem } from '@/hooks/useAgentChat'
import { formatCost, formatDuration, formatTokenCount } from '@/lib/format'
import { useBillingCurrency } from '@/lib/billing-currency'
import { THINKING_TONE, TOOL_TONE } from '@/lib/agent/chat-colors'
import type { TurnStats } from '@/lib/turn-stats'
import { TaskStatusCard } from './task-status-card'

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

/** 工具行整行宽度预算（工具名 + 空格 + 参数）：工具名越长参数预算越小，
 *  右缘能对齐。2026-10-29 用户：各行长度尽量一致，超了才省略。 */
const TOOL_BRIEF_MAX = 76

/** 「路径类」参数名：首参不是路径、工具另带路径时（Grep/Glob 的 pattern + path），
 *  把目录附在简报尾部，否则只看到 pattern 不知道在哪儿搜。 */
const PATH_KEYS = ['file_path', 'notebook_path', 'path', 'directory', 'dir', 'cwd', 'root']

/** 像路径 = 带反斜杠，或带斜杠且不含空格（排除命令行 / 自然语言）。 */
function isPathLike(s: string): boolean {
  return s.includes('\\') || (s.includes('/') && !/\s/.test(s))
}

/** 头：从盘符开始按整段追加，最多占预算 35%——目录名永远不切断。 */
function takeHead(parts: string[], cap: number, sep: string): string[] {
  const head: string[] = []
  for (const p of parts) {
    if (head.length >= parts.length - 1) break
    const next = head.length ? `${head.join(sep)}${sep}${p}` : p
    if (next.length > cap) break
    head.push(p)
  }
  if (head.length === 0) head.push(parts[0])
  return head
}

/** 头 +「…」+ 从尾部尽量多的完整段；一段都放不下时只留文件名尾巴。 */
function joinBrief(headParts: string[], parts: string[], sep: string, max: number): string {
  const head = headParts.join(sep)
  const budget = max - head.length - 2 // 「…」+ 省略号后补的分隔符
  const tail: string[] = []
  for (let i = parts.length - 1; i >= headParts.length; i--) {
    const next = [parts[i], ...tail]
    if (next.join(sep).length > budget) break
    tail.unshift(parts[i])
  }
  if (tail.length === 0) {
    // 兜底：连文件名都放不下 → 截掉前缀，保扩展名
    const name = parts[parts.length - 1]
    const keep = Math.max(12, max - 2)
    return `…${sep}${name.length <= keep ? name : name.slice(-keep)}`
  }
  return `${head}…${sep}${tail.join(sep)}`
}

/** 长值简报：路径做「中段省略」——前几级目录 + 末几级目录/文件名都保留，
 *  中间变「…」；命令类保留开头截断。
 *  2026-10-29 用户两轮反馈：先别把文件名截掉；再是只剩末两级太短，
 *  前面要多留路径，各行长度尽量接近。 */
export function briefValue(value: string, max = 72): string {
  const oneLine = value.trim().split('\n')[0]
  if (oneLine.length <= max) return oneLine
  if (!isPathLike(oneLine)) return `${oneLine.slice(0, max - 1)}…`
  const sep = oneLine.includes('\\') ? '\\' : '/'
  const parts = oneLine.split(/[\\/]+/).filter(Boolean)
  if (parts.length < 2) return `${oneLine.slice(0, max - 1)}…`

  const headCap = Math.max(8, Math.floor(max * 0.35))
  let headParts = takeHead(parts, headCap, sep)
  let out = joinBrief(headParts, parts, sep, max)
  // 尾巴某一段太长、剩余预算吃不下时，退一级头再试（只在不浪费 >16 字符时）。
  while (headParts.length > 1 && out.length < max - 16) {
    const shorter = headParts.slice(0, -1)
    const next = joinBrief(shorter, parts, sep, max)
    if (next.length <= out.length) break
    headParts = shorter
    out = next
  }
  return out
}

/** 工具行一句话简报：工具名 + 主参数 —— 所有工具共用同一套压缩规则（不只 Read）。
 *  首参不是路径、但工具另带路径时，尾部再附一段目录（预算内才加）。 */
export function toolBrief(tc: ToolCallRecord): string {
  const inp = tc.input
  if (!inp || typeof inp !== 'object') return tc.name
  const entries = Object.entries(inp as Record<string, unknown>)
    .filter(([, v]) => typeof v === 'string' && (v as string).trim()) as [string, string][]
  if (entries.length === 0) return tc.name
  const [firstKey, firstValue] = entries[0]
  const out = `${tc.name} ${briefValue(firstValue, Math.max(28, TOOL_BRIEF_MAX - tc.name.length - 1))}`
  // 首参本身就是路径参数（Read/Edit/Write 的 file_path）→ 不再附加。
  // 注意不能用「值像路径」判断：`**/*.tsx` 这类 glob 也带斜杠但没有空格。
  if (PATH_KEYS.includes(firstKey)) return out
  const pathEntry = entries.find(([k, v]) => k !== firstKey && PATH_KEYS.includes(k) && isPathLike(v))
  if (!pathEntry) return out
  const dirBudget = TOOL_BRIEF_MAX - out.length - 3 // 「 · 」占 3
  if (dirBudget < 8) return out
  return `${out} · ${briefValue(pathEntry[1], dirBudget)}`
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
  // toolBrief 永远以工具名开头 → 拆开只给工具名上青，参数保持灰。
  const args = toolBrief(tc).slice(tc.name.length)
  return (
    <div className="text-pop-dim" data-tui-tool={open ? 'open' : 'closed'}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="block w-full select-none text-left transition-colors hover:text-pop-ink"
        title={open ? '收回工具详情' : '展开本工具 input/result 全文'}
      >
        <span className={TOOL_TONE.arrow}>{open ? '▾ ' : '▸ '}</span>
        <span className={TOOL_TONE.name}>{tc.name}</span>{args}{' '}
        <span className={cls}>[{glyph}]</span>
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

function TuiMeta({ thinking, toolCalls, timeline, stats, interrupted }: {
  thinking?: string
  toolCalls?: ToolCallRecord[]
  timeline?: MessageTimelineEntry[]
  stats?: TurnStats
  /** 本轮被用户截断 → 状态词换成「已中断」。 */
  interrupted?: boolean
}) {
  const [open, setOpen] = useState(false)
  // 费用按计费设置折算（默认 CNY / 7）：与任务看板、计费页同一枚 formatCost。
  const currency = useBillingCurrency()
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
  const cost = stats && stats.costUsd != null
    ? formatCost(stats.costUsd, stats.costComplete, currency)
    : null
  // 整轮模型都没配价：显示「—」而不是留白（2026-10-29 用户看到「只有 token」以为丢了费用）。
  const unpriced = !!stats && stats.costUsd == null
  const status = interrupted
    ? { label: '已中断', cls: 'text-pop-red' }
    : { label: '已完成', cls: 'text-pop-green' }

  return (
    <div className="my-1" data-tui-meta-root>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full select-none flex-wrap items-center gap-x-1.5 gap-y-1 py-[2px] text-left text-pop-dim transition-colors hover:text-pop-ink"
        data-tui-meta={open ? 'open' : 'closed'}
        title={
          'turn = 一条用户消息 + 助手这一整段回复。步数 = 思考段 + 工具调用 + 正文段；时长 / token / 费用来自会话账本，旧轮没有账本行时只显示步数与次数。'
        }
      >
        {/* 收起 / 展开同一行摘要（2026-10-29 用户：展开不要重复上面的信息）。 */}
        <span className={`font-semibold ${status.cls}`} data-tui-status>{status.label}</span>
        {duration && (
          <>
            <span>·</span>
            <span className="text-pop-pink tabular-nums" data-tui-duration>{duration}</span>
          </>
        )}
        <span>·</span>
        <span className="font-semibold text-pop-ink/85">{rows.length} 步</span>
        <span>·</span>
        <span className="text-pop-cyan" title={counts.failed > 0 ? `失败 ${counts.failed} 次` : '工具调用次数'}>
          工具 {counts.tools}
        </span>
        <span>·</span>
        <span className="text-pop-purple">思考 {counts.thinks}</span>
        {tokens && (
          <>
            <span>·</span>
            <span className="text-pop-green tabular-nums">{tokens} tok</span>
          </>
        )}
        {stats && (cost || unpriced) && (
          <>
            <span>·</span>
            <span
              className="text-pop-amber tabular-nums"
              title={unpriced
                ? '该轮模型还没配价（系统 → Token 计费 → 价格配置）；token 照常记账'
                : stats.costComplete
                  ? '账本价表估算（币种跟随计费设置）'
                  : '账本价表估算：含未定价模型，≈ = 已知部分和'}
              data-tui-cost={unpriced ? 'unpriced' : 'priced'}
            >
              {cost ?? '—'}
            </span>
          </>
        )}
        {/* 箭头紧跟最后一个数字（2026-10-29 用户：不要再被推到最右） */}
        <span aria-hidden>{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="mt-1" data-tui-meta-body>
          {/* 展开态只有步骤列表（2026-10-29 用户：输入/输出/缓存/模型这些明细不必再显示）。
              统计信息全在上面那一行，展开不重复。 */}
          <div className="ml-3 space-y-0.5 border-l border-pop-bd pl-3">
            {rows.map((r) =>
              r.node === 'tool' && r.tc ? (
                <ToolLine key={r.key} tc={r.tc} />
              ) : r.node === 'frag' ? (
                <div key={r.key} className="whitespace-pre-wrap break-words text-pop-dim">✎ {r.text}</div>
              ) : (
                <div key={r.key} className="whitespace-pre-wrap break-words text-pop-dim">
                  <span className={THINKING_TONE.glyph} aria-hidden>◌</span> {r.text}
                </div>
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
  // 任务状态卡（执行中 / 已暂停 / 收尾）交给运行卡组件：它自己走表、按需轮询
  // 执行详情，收尾后定格成只读（2026-10-30 用户定稿）。
  if (activity?.status && activity?.taskId) {
    return <TaskStatusCard message={message} />
  }
  const severity = activity?.severity
  // 决策卡选过就只读：所选按钮高亮，其余禁用；卡片整体降噪（与启动决策一致）。
  const decision = activity?.decision ?? null
  const decisions = activity?.decisions ?? {}
  const decided = !!decision
  const tone =
    decided
      ? 'border-pop-bd/70 bg-white/[0.015] text-pop-dim'
      : severity === 'critical'
        ? 'border-pop-red/40 bg-pop-red/[0.06] text-pop-red'
        : severity === 'warn'
          ? 'border-pop-amber/40 bg-pop-amber/[0.06] text-pop-amber'
          : 'border-pop-cyan/35 bg-pop-cyan/[0.05] text-pop-cyan'
  const mark = severity === 'critical' ? '✕' : severity === 'warn' ? '!' : '✓'
  const summary = message.content.split('\n').slice(1).find((line) => line.trim() && !line.startsWith('请判断'))?.trim()
  const canOpenWorkflow = !!activity?.executionId && !!activity?.workspaceId

  // 2026-10-28 task-thread: the card's buttons are a protocol, not local logic:
  // ChatTab listens for these and owns the handlers (trigger/accept/archive…).
  // 2026-10-30: the click also carries the message id so the human's choice can
  // be persisted back onto this card (read-only afterwards).
  const actions = Array.isArray(activity?.actions) ? activity!.actions! : []
  const entries = (() => {
    const raw = (activity?.payload as { entries?: unknown } | undefined)?.entries
    return Array.isArray(raw)
      ? (raw as Array<{ id: string; title: string; target?: string }>)
      : []
  })()
  const fireAction = (actionId: string) => {
    window.dispatchEvent(new CustomEvent('octopus:task-card-action', {
      detail: { taskId: activity?.taskId ?? null, activity, actionId, messageId: message.id },
    }))
  }
  const decideReflection = (entryId: string, action: 'ingest' | 'skip') => {
    window.dispatchEvent(new CustomEvent('octopus:reflection-decision', {
      detail: { taskId: activity?.taskId ?? null, entryId, action, messageId: message.id },
    }))
  }

  return (
    <div
      data-tui-msg="event"
      data-message-id={message.id}
      data-testid="activity-event-card"
      data-decision={decided ? 'set' : 'open'}
      className={`rounded-md border px-3 py-2 font-mono text-[11.5px] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.03)] ${tone}`}
    >
      <div className="flex items-center gap-2">
        <span className="grid size-4 place-items-center rounded-full border border-current text-[9px]">
          {mark}
        </span>
        <span className={`min-w-0 flex-1 truncate font-semibold ${decided ? 'text-pop-ink/80' : ''}`}>
          {activity?.title ?? '活动通知'}
        </span>
        {decided && (
          <span className="shrink-0 text-[9px] text-pop-dim/70" data-testid="task-card-decision-stamp">
            已选{decision?.at ? ` · ${new Date(decision.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}` : ''}
          </span>
        )}
        {canOpenWorkflow && !decided && (
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
          {entries.map((entry) => {
            const pick = decisions[entry.id]
            return (
              <div key={entry.id} className="rounded border border-current/20 bg-black/10 px-2 py-1.5">
                <div className="text-[10.5px] font-semibold text-pop-ink">{entry.title}</div>
                {entry.target && <div className="text-[9px] text-pop-dim">{entry.target}</div>}
                <div className="mt-1 flex items-center gap-1">
                  <button type="button" onClick={() => decideReflection(entry.id, 'ingest')}
                    disabled={!!pick}
                    className={`rounded px-1.5 py-0.5 text-[9px] font-black disabled:cursor-default ${
                      pick?.id === 'ingest'
                        ? 'border border-pop-green/50 bg-pop-green/10 text-pop-green'
                        : 'bg-pop-purple text-pop-bg disabled:opacity-30'
                    }`}>
                    {pick?.id === 'ingest' ? '✓ 落 wiki' : '落 wiki'}
                  </button>
                  <button type="button" onClick={() => decideReflection(entry.id, 'skip')}
                    disabled={!!pick}
                    className={`rounded border px-1.5 py-0.5 text-[9px] disabled:cursor-default ${
                      pick?.id === 'skip'
                        ? 'border-pop-green/50 bg-pop-green/10 text-pop-green'
                        : 'border-current/30 text-pop-dim hover:text-pop-ink disabled:opacity-30'
                    }`}>
                    {pick?.id === 'skip' ? '✓ 跳过' : '跳过'}
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}
      {actions.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1 pl-6" data-testid="task-card-actions">
          {actions.map((action) => {
            const chosen = decision?.id === action.id
            return (
              <button
                key={action.id}
                type="button"
                disabled={decided}
                onClick={() => fireAction(action.id)}
                className={`rounded border px-1.5 py-0.5 text-[10px] transition-colors disabled:cursor-default ${
                  chosen
                    ? 'border-pop-green/50 bg-pop-green/10 font-bold text-pop-green'
                    : 'border-current/30 bg-black/10 text-pop-ink hover:bg-white/[0.08] disabled:opacity-30 disabled:hover:bg-black/10'
                }`}
              >
                {chosen ? '✓ ' : ''}{action.label}
              </button>
            )
          })}
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
        interrupted={message.interrupted}
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
        <span className={THINKING_TONE.label}>◌ thinking</span>
        {item.active && <span className={`ml-1 animate-pulse ${THINKING_TONE.glyph}`}>▊</span>}
        <span className="ml-1 text-[10px]">{open ? '▾ 全文' : '▸ 全文'}</span>
      </button>
      {open ? (
        <div className={`ml-3 max-h-[50vh] overflow-y-auto whitespace-pre-wrap break-words border-l ${THINKING_TONE.rail} pl-2`}>{item.text}</div>
      ) : (
        <div className={`ml-3 overflow-hidden border-l ${THINKING_TONE.railSoft} pl-2`}>
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
