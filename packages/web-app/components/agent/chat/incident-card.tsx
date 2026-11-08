'use client'

// 对话里的「运行事件」卡（2026-11-07）：runtime supervision 产生 incident 时，
// 服务端落一张 payload.incident 卡。卡片按 incident_id 轮询状态，升级给人时
// 展示选项 —— 人选完把选择发回对话，由 owner Agent 调 resolve_incident，
// 而不是前端直接改执行状态（AI-native：决策权在 Agent，确认权在人）。

import { useEffect, useState } from 'react'
import type { AgentMessage } from '@/lib/agent/types'
import {
  fetchRuntimeIncident,
  type RuntimeIncidentWire,
  type RuntimeIncidentStatus,
} from '@/lib/api-client'

const TERMINAL: RuntimeIncidentStatus[] = ['resolved', 'expired']

const STATUS_LABEL: Record<RuntimeIncidentStatus, string> = {
  open: '待分派',
  dispatched: 'Agent 处理中',
  waiting_human: '等你决定',
  resolved: '已处理',
  expired: '已超时',
  unowned: '无负责人',
}

const SEVERITY_MARK: Record<string, string> = {
  info: '✓',
  warning: '!',
  critical: '✕',
}

interface IncidentPayload {
  incident?: boolean
  incidentId?: string
  incidentKind?: string
  allowedActions?: string[]
  options?: string[] | null
}

export function IncidentCard({ message }: { message: AgentMessage }) {
  const activity = message.activity
  const payload = (activity?.payload ?? {}) as IncidentPayload
  const incidentId = payload.incidentId ?? null
  const workspaceId = activity?.workspaceId ?? null

  const [incident, setIncident] = useState<RuntimeIncidentWire | null>(null)
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!incidentId || !workspaceId) return
    let alive = true
    let stopped = false
    const load = async () => {
      try {
        const next = await fetchRuntimeIncident(workspaceId, incidentId)
        if (!alive) return
        setIncident(next)
        setFailed(false)
        if (next && TERMINAL.includes(next.status)) stopped = true
      } catch {
        if (alive) setFailed(true)
      }
    }
    void load()
    const timer = window.setInterval(() => {
      if (!stopped) void load()
    }, 4000)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [incidentId, workspaceId])

  const status = incident?.status ?? (activity?.status as RuntimeIncidentStatus | undefined) ?? 'dispatched'
  const severity = incident?.severity ?? (activity?.severity === 'warn' ? 'warning' : activity?.severity) ?? 'info'
  const kind = incident?.kind ?? payload.incidentKind ?? 'incident'
  const summary = incident?.summary ?? activity?.message ?? ''
  const nodeId = incident?.displayNodeId ?? incident?.nodeId ?? activity?.nodeId ?? ''
  const terminal = TERMINAL.includes(status)
  const options = payload.options ?? []
  const waitingHuman = status === 'waiting_human'

  const tone =
    severity === 'critical'
      ? 'border-pop-red/40 bg-pop-red/[0.06] text-pop-red'
      : severity === 'warning'
        ? 'border-pop-amber/40 bg-pop-amber/[0.06] text-pop-amber'
        : terminal
          ? 'border-pop-bd/70 bg-white/[0.015] text-pop-dim'
          : 'border-pop-violet/35 bg-pop-violet/[0.05] text-pop-violet'

  const choose = (option: string) => {
    if (busy) return
    setBusy(true)
    window.dispatchEvent(
      new CustomEvent('octopus:incident-choice', {
        detail: { incidentId, option, messageId: message.id },
      }),
    )
    // The agent owns the resolve call; re-enable after the turn is dispatched.
    window.setTimeout(() => setBusy(false), 1500)
  }

  return (
    <div
      data-tui-msg="event"
      data-message-id={message.id}
      data-testid="incident-card"
      data-incident-status={status}
      data-incident-id={incidentId ?? ''}
      className={`rounded-md border px-3 py-2 font-mono text-[11.5px] leading-relaxed shadow-[inset_0_0_0_1px_rgba(255,255,255,0.03)] ${tone}`}
    >
      <div className="flex items-center gap-2">
        <span className="grid size-4 shrink-0 place-items-center rounded-full border border-current text-[9px]">
          {terminal ? '✓' : waitingHuman ? '?' : SEVERITY_MARK[severity] ?? '!'}
        </span>
        <span className="min-w-0 flex-1 truncate font-semibold">
          {waitingHuman ? '需要你决定' : '运行事件'} · {kind}
        </span>
        {nodeId && (
          <span className="shrink-0 text-[10px] text-pop-dim/80">node · {nodeId}</span>
        )}
        <span className="shrink-0 rounded-full border border-current/40 px-1.5 py-[1px] text-[9px] font-bold">
          {failed && !incident ? '状态未知' : STATUS_LABEL[status]}
        </span>
      </div>

      {summary && <div className="mt-1 pl-6 text-pop-dim whitespace-pre-wrap break-words">{summary}</div>}

      <div className="mt-1 flex flex-wrap items-center gap-2 pl-6">
        {activity?.executionId && workspaceId && (
          <button
            type="button"
            onClick={() =>
              window.dispatchEvent(
                new CustomEvent('octopus:open-workflow', {
                  detail: {
                    workspaceId,
                    executionId: activity.executionId,
                    title: activity.title ?? '运行事件',
                  },
                }),
              )
            }
            className="rounded border border-current/30 px-1.5 py-0.5 text-[10px] opacity-80 transition-opacity hover:opacity-100"
          >
            打开 DAG →
          </button>
        )}
        {status === 'unowned' && (
          <span className="text-[9.5px] text-pop-dim/70">无负责人 · 已记录，等待人工认领</span>
        )}
      </div>

      {waitingHuman && options.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1 pl-6" data-testid="incident-options">
          {options.map((option) => (
            <button
              key={option}
              type="button"
              disabled={busy}
              onClick={() => choose(option)}
              className="rounded border border-current/40 bg-black/10 px-1.5 py-0.5 text-[10px] text-pop-ink transition-colors hover:bg-white/[0.08] disabled:opacity-40"
            >
              {option}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
