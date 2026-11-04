'use client'

// 作业坞「子代理」详情窗（2026-11-04）：主 Agent 的指令 prompt + 子代理的
// 操作日志（thinking / 工具调用 + 结果 / 文本）+ 最终汇报 + token 汇总。
//
// 数据源：GET /api/agent/sessions/:id/subagents/:agentId。运行中每 2s 轮询
// （子代理消息没有 SSE 增量流，SDK 侧是整条消息到达）；结束后停止轮询。
// token 由服务端从子代理 transcript 汇总回填 —— SDK 的 task usage 在代理
// 端点恒为 0，不能直接展示。

import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, CheckCircle2, Loader2, Terminal, Users } from 'lucide-react'
import { getSessionSubagent, type SubagentLogBlock, type SubagentRunDetail } from '@/lib/agent/api'
import { formatDuration, formatTokenCount } from '@/lib/format'
import {
  isSubagentLive,
  subagentElapsedMs,
  subagentStatusLabel,
  subagentTokenTotal,
} from '@/lib/subagent-format'
import { cn } from '@/lib/utils'

type RenderItem =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool'; toolUseId?: string; name: string; input: unknown; result?: string; isError?: boolean }

function toolInputPreview(name: string, input: unknown): string {
  if (typeof input === 'string') return input
  if (!input || typeof input !== 'object') return ''
  const rec = input as Record<string, unknown>
  const pick = (key: string) => (typeof rec[key] === 'string' ? (rec[key] as string) : undefined)
  switch (name) {
    case 'Bash':
      return pick('command') ?? pick('description') ?? ''
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'NotebookEdit':
      return pick('file_path') ?? ''
    case 'Glob':
    case 'Grep':
      return pick('pattern') ?? ''
    case 'WebFetch':
      return pick('url') ?? ''
    case 'WebSearch':
      return pick('query') ?? ''
    case 'Agent':
      return pick('description') ?? ''
    default: {
      const json = JSON.stringify(input)
      return json.length > 160 ? `${json.slice(0, 160)}…` : json
    }
  }
}

/** 把「工具调用 / 工具结果」配对成一行，文本与思考按到达顺序保留。 */
function buildItems(steps: SubagentLogBlock[]): RenderItem[] {
  const items: RenderItem[] = []
  const toolIndex = new Map<string, number>()
  for (const block of steps) {
    if (block.kind === 'text' && block.text) {
      items.push({ kind: 'text', text: block.text })
    } else if (block.kind === 'thinking' && block.text) {
      items.push({ kind: 'thinking', text: block.text })
    } else if (block.kind === 'tool_use') {
      const item: RenderItem = {
        kind: 'tool',
        toolUseId: block.toolUseId,
        name: block.toolName ?? 'tool',
        input: block.input,
      }
      if (block.toolUseId) toolIndex.set(block.toolUseId, items.length)
      items.push(item)
    } else if (block.kind === 'tool_result') {
      const idx = block.toolUseId ? toolIndex.get(block.toolUseId) : undefined
      if (idx != null && items[idx]?.kind === 'tool') {
        const tool = items[idx] as Extract<RenderItem, { kind: 'tool' }>
        items[idx] = { ...tool, result: block.content ?? '', isError: block.isError }
      } else {
        items.push({
          kind: 'tool',
          toolUseId: block.toolUseId,
          name: '工具结果',
          input: undefined,
          result: block.content ?? '',
          isError: block.isError,
        })
      }
    }
  }
  return items
}

export function SubagentWindow({
  sessionId,
  agentId,
}: {
  sessionId: string | null
  agentId: string | null
}) {
  const [run, setRun] = useState<SubagentRunDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const streamRef = useRef<HTMLDivElement>(null)
  const stickToBottomRef = useRef(true)

  useEffect(() => {
    setRun(null)
    setError(null)
    if (!sessionId || !agentId) return
    let alive = true
    let timer: number | undefined

    const load = async () => {
      try {
        const res = await getSessionSubagent(sessionId, agentId)
        if (!alive) return
        if (!res.run) return
        setRun(res.run)
        setError(null)
        // 运行中持续跟随；刚结束的 30s 内也继续拉几次 —— 服务端会用 transcript
        // 对账 token，窗口要能吃到最终数字（真机 2026-11-04）。
        const ended = res.run.ended_at ? Date.parse(res.run.ended_at) : NaN
        const settleWindow = Number.isFinite(ended) && Date.now() - ended < 30_000
        if (isSubagentLive(res.run) || settleWindow) {
          timer = window.setTimeout(load, 2_000)
        }
      } catch (err: unknown) {
        if (!alive) return
        setError(err instanceof Error ? err.message : '加载失败')
        // 运行中的子代理行可能还没落库 —— 稍后重试一次。
        timer = window.setTimeout(load, 3_000)
      }
    }
    void load()
    return () => {
      alive = false
      if (timer) window.clearTimeout(timer)
    }
  }, [sessionId, agentId])

  const live = run ? isSubagentLive(run) : false
  useEffect(() => {
    if (!live) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [live])

  const items = useMemo(() => buildItems(run?.steps ?? []), [run?.steps])

  // 跟随最新输出：用户手动往上翻时不抢滚动条。
  useEffect(() => {
    const el = streamRef.current
    if (!el || !stickToBottomRef.current) return
    el.scrollTop = el.scrollHeight
  }, [items.length])

  if (!sessionId || !agentId) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-[11px] text-pop-dim">
        从作业坞「子代理」列表里选一条查看。
      </div>
    )
  }

  if (error && !run) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-[11px] leading-5 text-pop-dim">
        <AlertTriangle className="size-5 text-pop-red/70" />
        <span>{error}</span>
        <span className="text-[10px] text-pop-dim/60">子代理记录可能尚未落库；重开对话后再试。</span>
      </div>
    )
  }

  if (!run) {
    return (
      <div className="flex h-full items-center justify-center gap-2 px-6 text-[11px] text-pop-dim">
        <Loader2 className="size-3.5 animate-spin" /> 正在读取子代理记录…
      </div>
    )
  }

  const failed = run.status === 'failed' || run.status === 'killed'
  const tokens = subagentTokenTotal(run)
  const elapsed = subagentElapsedMs(run, now)

  return (
    <div className="flex h-full min-h-0 flex-col font-mono text-[11px]" data-testid="subagent-window">
      {/* 标题条：类型 · 状态 · 计时 */}
      <div className="flex shrink-0 items-center gap-2 border-b border-white/[0.06] px-3 py-2">
        <Users className="size-3.5 shrink-0 text-pop-purple" />
        <span className="shrink-0 rounded border border-pop-purple/35 bg-pop-purple-soft/40 px-1 py-[1px] text-[9px] font-bold text-pop-purple">
          {run.agent_type ?? 'subagent'}
        </span>
        <span className="min-w-0 flex-1 truncate text-[11px] font-semibold text-pop-ink">
          {run.description ?? run.id}
        </span>
        <span
          className={cn(
            'flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-[1px] text-[9px] font-bold',
            live
              ? 'border-pop-purple/35 bg-pop-purple-soft/40 text-pop-purple'
              : failed
                ? 'border-pop-red/35 bg-pop-red-soft text-pop-red'
                : 'border-pop-green/35 bg-pop-green-soft text-pop-green',
          )}
        >
          {live ? (
            <Loader2 className="size-2.5 animate-spin" />
          ) : failed ? (
            <AlertTriangle className="size-2.5" />
          ) : (
            <CheckCircle2 className="size-2.5" />
          )}
          {subagentStatusLabel(run.status)}
        </span>
        <span className="shrink-0 text-[9.5px] tabular-nums text-pop-dim">
          {elapsed != null ? formatDuration(elapsed) : '—'}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto" ref={streamRef}
        onScroll={(event) => {
          const el = event.currentTarget
          stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
        }}
      >
        {/* 主 Agent 的指令 */}
        <div className="m-2 rounded-[8px] border border-pop-purple/25 bg-pop-purple-soft/15 p-2">
          <div className="mb-1 flex items-center gap-1 text-[9px] font-bold text-pop-purple">
            <Terminal className="size-3" /> 主 Agent 的指令
          </div>
          <pre className="max-h-36 overflow-y-auto whitespace-pre-wrap break-words text-[10.5px] leading-[1.6] text-pop-ink/90">
            {run.prompt ?? '（SDK 未回传指令正文）'}
          </pre>
        </div>

        {/* 操作日志 */}
        <div className="space-y-1.5 px-2 pb-2">
          {items.length === 0 && (
            <div className="px-1 py-6 text-center text-[10px] leading-5 text-pop-dim/70">
              {live ? '子代理已启动，正在等待第一条输出…' : '这个子代理没有留下操作日志。'}
            </div>
          )}
          {items.map((item, index) => (
            <SubagentItem key={index} item={item} live={live && index === items.length - 1} />
          ))}
        </div>

        {/* 最终汇报 */}
        {run.summary && (
          <div className="m-2 rounded-[8px] border border-pop-green/30 bg-pop-green-soft/25 p-2">
            <div className="mb-1 flex items-center gap-1 text-[9px] font-bold text-pop-green">
              <CheckCircle2 className="size-3" /> 最终汇报
            </div>
            <pre className="max-h-56 overflow-y-auto whitespace-pre-wrap break-words text-[10.5px] leading-[1.6] text-pop-ink/90">
              {run.summary}
            </pre>
          </div>
        )}
      </div>

      {/* token / 步数脚注 */}
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-t border-white/[0.06] px-3 py-1.5 text-[9px] text-pop-dim">
        <Chip label="输入" value={formatTokenCount(run.input_tokens)} />
        <Chip label="输出" value={formatTokenCount(run.output_tokens)} />
        <Chip label="缓存读" value={formatTokenCount(run.cache_read_tokens)} />
        <Chip label="缓存写" value={formatTokenCount(run.cache_creation_tokens)} />
        <span className="text-pop-dim/40">·</span>
        <span>合计 {formatTokenCount(tokens)} tok</span>
        <span className="text-pop-dim/40">·</span>
        <span>{run.step_count} 步</span>
        {run.model && (
          <>
            <span className="text-pop-dim/40">·</span>
            <span className="truncate text-pop-dim/70">{run.model}</span>
          </>
        )}
        {live && (
          <span className="ml-auto flex items-center gap-1 text-[9px] text-pop-purple/80">
            <span className="size-1 animate-pulse rounded-full bg-pop-purple" /> 实时更新中
          </span>
        )}
      </div>
    </div>
  )
}

function Chip({ label, value }: { label: string; value: string }) {
  return (
    <span className="rounded border border-white/[0.08] bg-black/20 px-1.5 py-[1px] tabular-nums">
      <span className="text-pop-dim/60">{label}</span> {value}
    </span>
  )
}

function SubagentItem({ item, live }: { item: RenderItem; live: boolean }) {
  if (item.kind === 'thinking') {
    return (
      <div className="rounded-[6px] border border-white/[0.05] bg-white/[0.02] px-2 py-1 text-[10px] leading-[1.6] text-pop-dim italic">
        {item.text}
      </div>
    )
  }
  if (item.kind === 'text') {
    return (
      <div className="whitespace-pre-wrap break-words rounded-[6px] px-2 py-1 text-[10.5px] leading-[1.6] text-pop-ink/90">
        {item.text}
      </div>
    )
  }
  const preview = toolInputPreview(item.name, item.input)
  const hasResult = item.result != null && item.result !== ''
  return (
    <div className="overflow-hidden rounded-[7px] border border-white/[0.07] bg-black/20">
      <div className="flex items-center gap-1.5 border-b border-white/[0.05] px-2 py-1">
        <Terminal className="size-3 shrink-0 text-pop-cyan" />
        <span className="shrink-0 font-semibold text-pop-ink">{item.name}</span>
        {preview && (
          <span className="min-w-0 truncate text-[9.5px] text-pop-dim">{preview}</span>
        )}
        <span className="ml-auto shrink-0 text-[9px] text-pop-dim/60">
          {hasResult ? (item.isError ? '失败' : '完成') : live ? '执行中…' : '无结果'}
        </span>
      </div>
      {hasResult && (
        <pre
          className={cn(
            'max-h-44 overflow-auto whitespace-pre-wrap break-words px-2 py-1 text-[9.5px] leading-[1.55]',
            item.isError ? 'text-pop-red/85' : 'text-pop-dim',
          )}
        >
          {item.result}
        </pre>
      )}
    </div>
  )
}
