'use client'

// 终端式日志行：时间 · 通道标 · 事件符 · 正文（+ 可展开正文）
// 单独成文件是因为它按行 memo —— 一轮执行动辄几千行，只有 tail 窗口内的行会渲染。

import { memo, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { clockOf, type LogChannel, type LogKind, type LogRow } from './log-channels'

/** 事件符与色调：沿用旧日志的语义色（think 紫 / text 青 / tool 黄 / 错误红 / 完成绿）。 */
const KIND_VIEW: Record<LogKind, { g: string; cls: string }> = {
  start: { g: '▶', cls: 'text-pop-navy' },
  end: { g: '✓', cls: 'text-pop-green' },
  fail: { g: '✗', cls: 'text-pop-red' },
  think: { g: '✳', cls: 'text-pop-purple' },
  text: { g: '¶', cls: 'text-pop-cyan' },
  tool: { g: '⚙', cls: 'text-pop-amber' },
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
  const view = KIND_VIEW[row.kind] ?? KIND_VIEW.log
  const expandable = !!(row.detail || row.moreLines)
  const color = ch?.color ?? 'var(--pop-dim)'

  return (
    <>
      <div
        className={cn(
          'grid items-baseline gap-x-1.5 border-l-[3px] py-[1px] pr-3 pl-2 font-mono text-[11.5px] leading-[1.62] hover:bg-white/[0.035]',
          showTs && showTag ? 'grid-cols-[84px_74px_14px_minmax(0,1fr)]'
            : showTs ? 'grid-cols-[84px_14px_minmax(0,1fr)]'
            : showTag ? 'grid-cols-[74px_14px_minmax(0,1fr)]'
            : 'grid-cols-[14px_minmax(0,1fr)]',
          expandable && 'cursor-pointer',
        )}
        style={{ borderLeftColor: `color-mix(in oklab, ${color} 60%, transparent)` }}
        onClick={expandable ? () => onToggle?.(row.id) : undefined}
        onKeyDown={expandable
          ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle?.(row.id) } }
          : undefined}
        tabIndex={expandable ? 0 : undefined}
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
            {ch?.tag ?? '···'}
          </span>
        )}
        <span className={cn('text-center text-[10px]', view.cls)} aria-hidden>{view.g}</span>
        <span className={cn('min-w-0 break-words', row.kind === 'out' ? 'text-pop-dim' : 'text-pop-ink/85', row.kind === 'err' || row.kind === 'fail' ? 'text-pop-red' : '')}>
          {row.role && (
            <span className="mr-1.5 rounded border border-pop-pink/35 bg-pop-pink-soft px-1 py-px align-[1px] text-[8.5px] font-black text-pop-pink">{row.role}</span>
          )}
          {mark(row.text, query)}
          {row.moreLines && !expanded && (
            <span className="ml-1.5 text-[9.5px] text-pop-dim/60">+{row.moreLines} 行</span>
          )}
          {expandable && <span className="ml-1.5 text-[9px] text-pop-dim/60">{expanded ? '▾' : '▸'}</span>}
        </span>
      </div>
      {expandable && expanded && (
        <pre className="mx-3 mb-1.5 ml-(--log-indent,201px) max-h-[190px] overflow-auto rounded-md border border-white/[0.06] bg-white/[0.035] px-2.5 py-1.5 font-mono text-[10.5px] leading-[1.55] whitespace-pre-wrap text-pop-dim">
          {row.detail ?? row.text}
        </pre>
      )}
    </>
  )
})
