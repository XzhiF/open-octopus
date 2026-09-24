'use client'

// TUI (claude-code 终端皮肤) 消息渲染 —— 任务草稿工作台专用（2026-09-24 TUI 改版）。
// 原型 = public/prototype/chat-tui.html：`❯` 用户行 / `✳` agent 行 /
// `◌ 过程（时间序）· N 步` 折叠 meta（对话完成后思考、步骤收起，沿用原交互）。

import { useMemo, useState, type ReactNode } from 'react'
import type { AgentMessage, MessageTimelineEntry, ToolCallRecord } from '@/lib/agent/types'
import type { StreamTimelineItem } from '@/hooks/useAgentChat'

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
      <div className="rounded-md bg-pop-paper px-3 py-1.5 italic shadow-[inset_0_0_0_1px_var(--pop-bd)]" data-tui-msg="user">
        <span className="font-bold not-italic text-pop-pink">❯ </span>
        <span className="break-words whitespace-pre-wrap">{message.content}</span>
      </div>
    )
  }

  const metaCount = (hasTimeline ? timeline!.length : 0) + (message.thinking && !hasTimeline ? 1 : 0)
  return (
    <div data-tui-msg="assistant">
      <TuiMeta thinking={message.thinking} toolCalls={message.tool_calls} timeline={timeline} />
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

/** 流式中的即时过程行（到达序），结束后由 TuiMessage 的折叠 meta 接管。 */
export function TuiLive({ items, toolCalls }: {
  items: StreamTimelineItem[]
  toolCalls: ToolCallRecord[]
}) {
  return (
    <div data-tui-live className="space-y-0.5">
      {items.map((item) => {
        if (item.kind === 'thinking') {
          // 3 行窗口：只渲染末 3 行，旧行渐隐；overflow-hidden 不出滚动条。
          const win = item.text.split('\n').slice(-3)
          return (
            <div key={item.id} data-tui-thinking className="text-pop-dim">
              <div>
                ◌ thinking
                {item.active && <span className="ml-1 animate-pulse text-pop-pink">▊</span>}
              </div>
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
            </div>
          )
        }
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
