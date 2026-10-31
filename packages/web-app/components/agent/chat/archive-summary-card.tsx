'use client'

// 对话里的「归档总框」（2026-10-31 AI-native 归档 · v2 定稿）
//
// 只留一张卡：状态 + 4 个数字 + 一句人话 + 一个「打开归档台看明细」的文字链接。
// 明细（project 表 / 冲突 / 反思清单 / 知识包 / 报告）都在作业坞的只读窗口里；
// 落 wiki / 跳过 / 重试这些动作全部靠用户在主 Chat 里说话，由 Agent 执行。
//
// 卡片自己按 4s（归档中）/ 20s（done 后）轮询 GET /api/tasks/:id/archive，
// 所以 git 进度、反思决策和编译状态会原地更新，不需要服务端重写消息。

import { useEffect, useState } from 'react'
import { getTaskArchive, type TaskArchivePayload } from '@/lib/tasks-api'
import type { AgentMessage } from '@/lib/agent/types'

interface ArchiveStateWire {
  projects?: Record<string, { status?: string; commit?: string | null; completedAt?: string }>
  date?: string
}

const COMPILE_LABEL: Record<string, string> = {
  queued: '排队',
  running: '编译中',
  committed: '已编译',
  failed: '编译失败',
}

function derive(data: TaskArchivePayload) {
  const state = (data.state as ArchiveStateWire | null) ?? null
  const stateProjects = state?.projects ?? {}
  const doneProjects = Object.values(stateProjects).filter((p) => p?.status === 'done').length
  const total = data.projects.length || Object.keys(stateProjects).length
  const entries = data.reflection?.entries ?? []
  const decisions = data.reflection?.decisions ?? {}
  const decided = entries.filter((e) => !!decisions[e.id]).length
  const conflicts = data.report
    ? data.report.projects.reduce((n, p) => n + (p.termConflicts?.length ?? 0), 0)
    : null
  const failures = data.report?.projects.filter((p) => !p.ok) ?? []
  const knowledge = data.knowledge
  const compile = knowledge?.compile_state
    ? (COMPILE_LABEL[knowledge.compile_state] ?? knowledge.compile_state)
    : knowledge && knowledge.pack_items > 0
      ? '已冻结'
      : '—'
  return { state, doneProjects, total, entries, decided, conflicts, failures, compile, knowledge }
}

export function ArchiveSummaryCard({ message }: { message: AgentMessage }) {
  const taskId = message.activity?.taskId ?? null
  const [data, setData] = useState<TaskArchivePayload | null>(null)

  useEffect(() => {
    if (!taskId) return
    let alive = true
    const load = () => {
      getTaskArchive(taskId)
        .then((next) => { if (alive) setData(next) })
        .catch(() => { /* 服务端离线：保留上一份快照 */ })
    }
    void load()
    const timer = window.setInterval(load, data?.status === 'done' ? 20_000 : 4_000)
    return () => { alive = false; window.clearInterval(timer) }
  }, [taskId, data?.status])

  const openArchive = () => {
    window.dispatchEvent(new CustomEvent('octopus:task-card-action', {
      detail: {
        taskId,
        actionId: 'open_archive',
        activity: message.activity,
        messageId: message.id,
      },
    }))
  }

  if (!data) {
    return (
      <div
        data-tui-msg="event"
        data-message-id={message.id}
        data-testid="archive-summary-card"
        data-status="loading"
        className="rounded-lg border-[1.5px] border-pop-bd bg-pop-paper/60 px-3 py-2.5 font-mono text-[11.5px] text-pop-dim"
      >
        归档 · 读取状态…
      </div>
    )
  }

  const { state, doneProjects, total, entries, decided, conflicts, failures, compile, knowledge } = derive(data)
  const done = data.status === 'done'
  const inFlight = data.in_flight
  const stopped = !done && data.status === 'archiving' && !inFlight && !!data.report && !data.report.ok
  const chip = done ? '已完成' : inFlight ? '编排中' : stopped ? '停在归档' : '等待中'
  const chipTone = done
    ? 'border-pop-green/45 bg-pop-green-soft text-pop-green'
    : inFlight
      ? 'border-pop-amber/45 bg-pop-amber-soft text-pop-amber animate-pulse'
      : 'border-pop-amber/45 bg-pop-amber-soft text-pop-amber'

  const note = (() => {
    if (done) {
      const tail = conflicts ? `；${conflicts} 处术语冲突已在归档 PR 等 review` : ''
      return `归档完成，任务已 done${tail}。`
    }
    // 重试在飞时，旧的失败报告已经不是现状 —— 先报进度。
    if (inFlight) return `正在同步到 ${total || '若干'} 个 project…`
    if (failures.length > 0) {
      const first = failures[0]
      return `停在归档：${first.project} — ${first.error ?? '未完成'}（对我说「重试」，我补推。）`
    }
    if (data.report && !data.report.ok) {
      return `停在归档：${data.report.error ?? '有 project 未同步成功'}（对我说「重试」，我补推。）`
    }
    if (!state) return '归档编排已启动，正在准备同步…'
    return `已同步 ${doneProjects}/${total} 个 project。`
  })()

  const reflectionText = entries.length > 0 ? `${decided}/${entries.length}` : '—'
  const gitText = total > 0 ? `${doneProjects}/${total}` : '—'
  const conflictText = conflicts == null ? '—' : String(conflicts)
  const meta = state?.date
    ? `${state.date}${total ? ` · ${total} project` : ''}`
    : (total ? `${total} project` : '')

  return (
    <div
      data-tui-msg="event"
      data-message-id={message.id}
      data-testid="archive-summary-card"
      data-status={done ? 'done' : inFlight ? 'live' : stopped ? 'stopped' : 'waiting'}
      className={[
        'rounded-lg border-[1.5px] px-3 py-2.5 font-mono text-[11.5px] leading-relaxed',
        'shadow-[inset_0_0_0_1px_rgba(255,255,255,0.03)]',
        done
          ? 'border-pop-bd/80 bg-white/[0.02]'
          : stopped
            ? 'border-pop-red/35 bg-pop-red/[0.04]'
            : 'border-pop-cyan/35 bg-pop-cyan/[0.04]',
      ].join(' ')}
    >
      <div className="flex items-center gap-2">
        <span className="font-semibold tracking-wide text-pop-ink/85">归档</span>
        <span className={`rounded-full border px-1.5 py-[1px] text-[9px] font-black ${chipTone}`}>{chip}</span>
        {meta && <span className="ml-auto shrink-0 text-[9.5px] text-pop-dim/75">{meta}</span>}
      </div>

      <div className="mt-2 grid grid-cols-4 gap-1.5">
        {[
          { value: gitText, label: 'git 同步' },
          { value: reflectionText, label: '反思决策' },
          { value: conflictText, label: '术语冲突' },
          { value: compile, label: '知识编译' },
        ].map((metric) => (
          <div key={metric.label} className="rounded-md border border-pop-bd/50 bg-black/15 px-1.5 py-1">
            <div className="truncate text-[13px] font-black tabular-nums text-pop-ink/90">{metric.value}</div>
            <div className="truncate text-[9px] text-pop-dim/75">{metric.label}</div>
          </div>
        ))}
      </div>

      <div className={`mt-2 text-[10.5px] ${stopped ? 'text-pop-red/90' : 'text-pop-dim'}`}>{note}</div>

      <div className="mt-1.5 flex items-center gap-2">
        <button
          type="button"
          onClick={openArchive}
          data-testid="archive-summary-open"
          className="text-[10.5px] font-bold text-pop-cyan underline decoration-pop-cyan/40 underline-offset-2 hover:text-pop-ink"
        >
          打开归档台看明细 →
        </button>
        {entries.length > 0 && decided < entries.length && (
          <span aria-hidden className="ml-auto text-[9px] text-pop-dim/60">
            {entries.length - decided} 条反思待决定 · 直接对我说
          </span>
        )}
        {knowledge && knowledge.compile_state === 'queued' && knowledge.compile_position != null && (
          <span aria-hidden className="ml-auto text-[9px] text-pop-dim/60">
            编译排队 #{knowledge.compile_position}
          </span>
        )}
      </div>
    </div>
  )
}
