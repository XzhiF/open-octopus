'use client'

// 终端式日志行 —— 与主页 chat 的 TUI 转录同一套语言：
//   ✳ 模型正文整段显示 · ◌ 思考折叠一行 · ▸ 工具一行 + 展开 input/result
// 单独成文件是因为它按行 memo —— 一轮执行动辄几千行，只有 tail 窗口内的行会渲染。

import { memo, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { clockOf, displayNameOf, type LogChannel, type LogKind, type LogRow } from './log-channels'

/** 事件符与色调：沿 chat TUI 的语义色（想=紫 / 动手=青 / 说=橙 / 错误=红 / 完成=绿）。 */
const KIND_VIEW: Record<LogKind, { g: string; cls: string }> = {
  start: { g: '▶', cls: 'text-pop-navy' },
  end: { g: '✓', cls: 'text-pop-green' },
  fail: { g: '✗', cls: 'text-pop-red' },
  think: { g: '◌', cls: 'text-pop-purple' },
  text: { g: '✳', cls: 'text-pop-pink' },
  tool: { g: '▸', cls: 'text-pop-cyan' },
  out: { g: '·', cls: 'text-pop-dim/60' },
  log: { g: '›', cls: 'text-pop-purple' },
  warn: { g: '!', cls: 'text-pop-amber' },
  err: { g: '!', cls: 'text-pop-red' },
  swarm: { g: '∵', cls: 'text-pop-pink' },
  approval: { g: '⏸', cls: 'text-pop-amber' },
  beat: { g: '♥', cls: 'text-pop-red/50' },
}

/** 关键字高亮：日志正文是不可信文本，只做 split + React 节点，不拼 HTML。 */
export function mark(text: string, query?: string): ReactNode {
  const q = query?.trim()
  if (!q) return text
  const lower = text.toLowerCase()
  const needle = q.toLowerCase()
  const out: ReactNode[] = []
  let from = 0
  let hit = lower.indexOf(needle, from)
  let k = 0
  while (hit >= 0) {
    if (hit > from) out.push(text.slice(from, hit))
    out.push(<mark key={k++} className="rounded-sm bg-pop-amber/25 px-[1px] text-pop-amber">{text.slice(hit, hit + q.length)}</mark>)
    from = hit + q.length
    hit = lower.indexOf(needle, from)
  }
  if (from < text.length) out.push(text.slice(from))
  return out
}

/** 正文轻 markdown：只认 **粗体** 与 `行内 code`，其余原样。 */
function inline(text: string, query?: string): ReactNode[] {
  return text.split(/(\*\*[^*\n]+\*\*|`[^`\n]+`)/g).map((part, i) => {
    if (/^\*\*[^*\n]+\*\*$/.test(part)) {
      return <strong key={i} className="font-bold text-pop-pink">{mark(part.slice(2, -2), query)}</strong>
    }
    if (/^`[^`\n]+`$/.test(part)) {
      return <code key={i} className="rounded-[3px] bg-pop-bd/50 px-1 text-pop-green">{mark(part.slice(1, -1), query)}</code>
    }
    return <span key={i}>{mark(part, query)}</span>
  })
}

function TextBlock({ text, query }: { text: string; query?: string }) {
  return (
    <>
      {text.split('\n').map((line, i) => {
        const heading = line.match(/^(#{1,4})\s+(.*)$/)
        return (
          <span key={i}>
            {i > 0 && '\n'}
            {heading
              ? <span className="font-bold text-pop-ink">{inline(heading[2], query)}</span>
              : inline(line, query)}
          </span>
        )
      })}
    </>
  )
}

function TuiPre({ children, tone = 'text-pop-dim' }: { children: ReactNode; tone?: string }) {
  return (
    <pre className={cn('max-h-[30vh] overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-white/[0.06] bg-white/[0.035] px-2.5 py-1.5 font-mono text-[10.5px] leading-[1.55]', tone)}>
      {children}
    </pre>
  )
}

export interface LogLineProps {
  row: LogRow
  ch?: LogChannel
  /** 与上一行同通道 → 通道标淡显，降低并发行噪音 */
  cont?: boolean
  showTs?: boolean
  /** 分屏 pane 内通道已在表头，行内不再重复打 tag */
  showTag?: boolean
  expanded?: boolean
  query?: string
  onToggle?: (id: string) => void
}

export const LogLine = memo(function LogLine({ row, ch, cont, showTs = true, showTag = true, expanded, query, onToggle }: LogLineProps) {
  const isTool = !!row.toolName
  const view = isTool && row.toolIsError
    ? { g: '✗', cls: 'text-pop-red' }
    : (KIND_VIEW[row.kind] ?? KIND_VIEW.log)
  const canExpand = isTool
    ? !!(row.toolInput || row.toolResult)
    : row.kind === 'text'
      ? false
      : !!(row.detail || row.moreLines)
  const color = ch?.color ?? 'var(--pop-dim)'
  const name = ch ? displayNameOf(ch) : row.chId
  const toolName = row.toolName ?? 'tool'
  const args = isTool ? row.text.slice(toolName.length) : ''
  const toolStatus = row.toolIsError
    ? { glyph: '✗', cls: 'text-pop-red' }
    : row.toolResult != null
      ? { glyph: '✓', cls: 'text-pop-green' }
      : { glyph: '…', cls: 'text-pop-dim' }

  const body = (() => {
    if (row.kind === 'text') {
      return <TextBlock text={row.detail ?? row.text} query={query} />
    }
    if (row.kind === 'think') {
      return (
        <>
          思考 {row.meta && <span className="text-pop-dim/70">{row.meta}</span>}
          {canExpand && <span className="ml-1.5 text-[9px] text-pop-dim/60">{expanded ? '▾ 收起' : '▸ 展开'}</span>}
        </>
      )
    }
    if (isTool) {
      return (
        <>
          <span className="font-bold text-pop-cyan">{toolName}</span>
          {args && <span className="text-pop-dim">{args}</span>}{' '}
          <span className={toolStatus.cls}>[{toolStatus.glyph}]</span>
          {canExpand && <span className="ml-1.5 text-[9px] text-pop-dim/60">{expanded ? '▾ 收起' : '▸ 展开'}</span>}
        </>
      )
    }
    return (
      <>
        {row.role && (
          <span className="mr-1.5 rounded border border-pop-pink/35 bg-pop-pink-soft px-1 py-px align-[1px] text-[8.5px] font-black text-pop-pink">{row.role}</span>
        )}
        {mark(row.text, query)}
        {row.moreLines && !expanded && (
          <span className="ml-1.5 text-[9.5px] text-pop-dim/60">+{row.moreLines} 行</span>
        )}
        {canExpand && <span className="ml-1.5 text-[9px] text-pop-dim/60">{expanded ? '▾ 收起' : '▸ 展开'}</span>}
      </>
    )
  })()

  return (
    <>
      <div
        className={cn(
          'grid items-baseline gap-x-1.5 border-l-[3px] py-[1px] pr-3 pl-2 font-mono text-[11.5px] leading-[1.62] hover:bg-white/[0.035]',
          showTs && showTag ? 'grid-cols-[84px_88px_14px_minmax(0,1fr)]'
            : showTs ? 'grid-cols-[84px_14px_minmax(0,1fr)]'
            : showTag ? 'grid-cols-[88px_14px_minmax(0,1fr)]'
            : 'grid-cols-[14px_minmax(0,1fr)]',
          canExpand && 'cursor-pointer',
        )}
        style={{ borderLeftColor: `color-mix(in oklab, ${color} 60%, transparent)` }}
        onClick={canExpand ? () => onToggle?.(row.id) : undefined}
        onKeyDown={canExpand
          ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle?.(row.id) } }
          : undefined}
        tabIndex={canExpand ? 0 : undefined}
        data-testid="log-line"
        data-kind={row.kind}
        data-channel={row.chId}
      >
        {showTs && (
          <span className="shrink-0 text-[9.5px] tabular-nums text-pop-dim/45">{clockOf(row.at)}</span>
        )}
        {showTag && (
          <span
            className={cn('truncate text-[9.5px] font-black tracking-tight', cont && 'opacity-45')}
            style={{ color }}
            title={ch ? `${ch.node}${row.role ? ` · ${row.role}` : ''}` : row.chId}
          >
            {name}
          </span>
        )}
        <span className={cn('text-center text-[10px]', view.cls)} aria-hidden>{view.g}</span>
        <span className={cn(
          'min-w-0 whitespace-pre-wrap break-words',
          row.kind === 'out' || row.kind === 'think' ? 'text-pop-dim' : 'text-pop-ink/85',
          (row.kind === 'err' || row.kind === 'fail') && 'text-pop-red',
        )}>
          {body}
        </span>
      </div>

      {expanded && isTool && (
        <div className="mr-3 mb-1.5 mt-0.5 space-y-1.5 border-l border-pop-bd pl-2"
        style={{ marginLeft: 'var(--log-indent, 211px)' }}>
          <div>
            <div className="text-[10px] font-black text-pop-cyan">input · {toolName}</div>
            <TuiPre>{row.toolInput ?? '（暂无输入）'}</TuiPre>
          </div>
          {row.toolResult != null && (
            <div>
              <div className={cn('text-[10px] font-black', row.toolIsError ? 'text-pop-red' : 'text-pop-green')}>result</div>
              <TuiPre>{row.toolResult}</TuiPre>
            </div>
          )}
        </div>
      )}

      {expanded && row.kind === 'think' && row.detail && (
        <div className="mr-3 mb-1.5 mt-0.5 border-l border-pop-purple/40 pl-2"
        style={{ marginLeft: 'var(--log-indent, 211px)' }}>
          <TuiPre>{row.detail}</TuiPre>
        </div>
      )}

      {expanded && !isTool && row.kind !== 'think' && (row.detail || row.moreLines) && (
        <div className="mr-3 mb-1.5 mt-0.5"
        style={{ marginLeft: 'var(--log-indent, 211px)' }}>
          <TuiPre>{row.detail ?? row.text}</TuiPre>
        </div>
      )}
    </>
  )
})
