'use client'

// TUI (claude-code 终端皮肤) 消息渲染 —— 任务草稿工作台专用（2026-09-24 TUI 改版）。
// 原型 = public/prototype/chat-tui.html：`❯` 用户行 / `✳` agent 行 /
// `◌ 过程（时间序）· N 步` 折叠 meta（对话完成后思考、步骤收起，沿用原交互）。

import { useMemo, useState } from 'react'
import type { AgentMessage, MessageTimelineEntry, ToolCallRecord } from '@/lib/agent/types'
import type { StreamTimelineItem } from '@/hooks/useAgentChat'

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

function ToolLine({ tc }: { tc: ToolCallRecord }) {
  const { glyph, cls } = toolStatusMark(tc.status)
  return (
    <div className="text-pop-dim">
      <span className="text-pop-pink">▸ </span>
      {toolBrief(tc)} <span className={cls}>[{glyph}]</span>
    </div>
  )
}

/** 折叠的过程 meta：thinking / tool 按时间序（timeline 缺失时用字段兜底）。 */
function TuiMeta({ thinking, toolCalls, timeline }: {
  thinking?: string
  toolCalls?: ToolCallRecord[]
  timeline?: MessageTimelineEntry[]
}) {
  const [open, setOpen] = useState(false)
  const rows = useMemo(() => {
    const out: Array<{ key: string; node: 'think' | 'tool' | 'frag'; text?: string; tc?: ToolCallRecord }> = []
    if (timeline?.length) {
      for (const e of timeline) {
        if (e.kind === 'thinking' && e.text) out.push({ key: `th-${out.length}`, node: 'think', text: e.text })
        else if (e.kind === 'tool') {
          const tc = toolCalls?.find((t) => t.id === e.id)
          if (tc) out.push({ key: `tc-${e.id}`, node: 'tool', tc })
        } else if (e.kind === 'text' && e.text) out.push({ key: `fx-${out.length}`, node: 'frag', text: e.text })
      }
    } else {
      if (thinking) out.push({ key: 'th-0', node: 'think', text: thinking })
      for (const tc of toolCalls ?? []) out.push({ key: `tc-${tc.id}`, node: 'tool', tc })
    }
    return out
  }, [thinking, toolCalls, timeline])

  if (rows.length === 0) return null
  return (
    <div className="my-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="select-none text-pop-dim transition-colors hover:text-pop-ink"
        data-tui-meta={open ? 'open' : 'closed'}
      >
        <span className="text-pop-dim">◌ 过程（时间序）· </span>
        <span className="text-pop-pink">{rows.length} 步</span>
        <span className="ml-1">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="ml-3 mt-1 space-y-0.5 border-l border-pop-bd pl-3">
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
      )}
    </div>
  )
}

export function TuiMessage({ message }: { message: AgentMessage }) {
  const isUser = message.role === 'user'
  const timeline = !isUser ? message.timeline : undefined
  const hasTimeline = !!timeline && timeline.length > 0

  // 与 ChatBubble 同语义：有 timeline 时正文只显最后一段 text，其余收进 meta。
  const displayContent = useMemo(() => {
    if (!hasTimeline) return message.content
    const texts = timeline!.filter((e) => e.kind === 'text' && e.text)
    const last = texts[texts.length - 1]
    return last?.text ?? message.content
  }, [hasTimeline, timeline, message.content])

  if (isUser) {
    return (
      <div className="flex gap-2" data-tui-msg="user">
        <span className="shrink-0 font-bold text-pop-ink">❯</span>
        <div className="min-w-0 flex-1 break-words whitespace-pre-wrap">{message.content}</div>
      </div>
    )
  }

  const metaCount = (hasTimeline ? timeline!.length : 0) + (message.thinking && !hasTimeline ? 1 : 0)
  return (
    <div data-tui-msg="assistant">
      <TuiMeta thinking={message.thinking} toolCalls={message.tool_calls} timeline={timeline} />
      {displayContent
        ? displayContent.split('\n').map((line, i) => (
            <div key={i} className="flex gap-2 break-words whitespace-pre-wrap">
              <span className="shrink-0 font-bold text-pop-pink">✳</span>
              <span className="min-w-0 flex-1">{line || ' '}</span>
            </div>
          ))
        : metaCount > 0 && <div className="text-pop-dim">✳ （未生成文本回复）</div>}
      {message.interrupted && (
        <div className="text-pop-red" data-tui-interrupted>（本轮被截断）</div>
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
        if (item.kind === 'thinking') {
          return (
            <div key={item.id} className="truncate text-pop-dim">
              ◌ thinking — {item.text.split('\n').pop()}
              {item.active && <span className="ml-1 animate-pulse text-pop-pink">▊</span>}
            </div>
          )
        }
        if (item.kind === 'tool') {
          const tc = toolCalls.find((t) => t.id === item.id)
          return tc ? <ToolLine key={item.id} tc={tc} /> : null
        }
        return (
          <div key={item.id} className="flex gap-2 break-words whitespace-pre-wrap">
            <span className="shrink-0 font-bold text-pop-pink">✳</span>
            <span className="min-w-0 flex-1">
              {item.text}
              <span className="animate-pulse text-pop-pink">▊</span>
            </span>
          </div>
        )
      })}
    </div>
  )
}
