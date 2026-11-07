'use client'

// 运行窗「事件」页签（2026-11-07）：runtime supervision 的只读时间线。
// 数据与对话里的 IncidentCard 同源（GET /harness/incidents?execution_id=…）。
// 这里不做处置动作 —— 处置走主 chat（AI-native：决策权在 owner Agent）。

import type { RuntimeIncidentWire } from '@/lib/api-client'

const STATUS_LABEL: Record<string, string> = {
  open: '待分派',
  dispatched: 'Agent 处理中',
  waiting_human: '等人决定',
  resolved: '已处理',
  expired: '已超时',
  unowned: '无负责人',
}

const TERMINAL = new Set(['resolved', 'expired'])

function toneOf(incident: RuntimeIncidentWire): string {
  if (incident.status === 'resolved') return 'text-pop-green border-pop-green/35'
  if (incident.status === 'expired') return 'text-pop-dim border-pop-bd'
  if (incident.severity === 'critical') return 'text-pop-red border-pop-red/40'
  if (incident.severity === 'warning') return 'text-pop-amber border-pop-amber/40'
  return 'text-pop-violet border-pop-violet/35'
}

function fmtTime(ts: number): string {
  if (!ts) return '—'
  return new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

export function IncidentTimeline({ incidents }: { incidents: RuntimeIncidentWire[] }) {
  if (incidents.length === 0) {
    return (
      <div data-testid="incident-timeline-empty" className="flex h-full items-center justify-center p-6 text-[11px] text-pop-dim">
        本次运行没有运行时事件。
      </div>
    )
  }

  return (
    <div data-testid="incident-timeline" className="h-full overflow-y-auto p-3 font-mono text-[11px]">
      <ol className="space-y-2">
        {incidents.map((incident) => (
          <li
            key={incident.id}
            data-testid="incident-row"
            data-status={incident.status}
            data-severity={incident.severity}
            className={`rounded border bg-white/[0.015] px-2.5 py-2 ${toneOf(incident)}`}
          >
            <div className="flex items-center gap-2">
              <span className="shrink-0 rounded-full border border-current/40 px-1.5 py-[1px] text-[9px] font-bold">
                {STATUS_LABEL[incident.status] ?? incident.status}
              </span>
              <span className="min-w-0 flex-1 truncate font-semibold">{incident.kind}</span>
              <span className="shrink-0 text-[9.5px] tabular-nums text-pop-dim/70">
                {fmtTime(incident.createdAt)}
              </span>
            </div>
            <div className="mt-1 text-pop-ink/80">{incident.summary}</div>
            <div className="mt-0.5 flex items-center gap-2 text-[10px] text-pop-dim">
              <span>node · {incident.displayNodeId ?? incident.nodeId}</span>
              <span className="text-pop-dim/50">·</span>
              <span>{incident.phase}</span>
              {incident.decision && (
                <>
                  <span className="text-pop-dim/50">·</span>
                  <span className="text-pop-green">
                    {incident.decision.type}
                    {incident.resolutionSource ? ` (${incident.resolutionSource})` : ''}
                  </span>
                </>
              )}
              {!TERMINAL.has(incident.status) && incident.deadlineAt && (
                <>
                  <span className="text-pop-dim/50">·</span>
                  <span className="text-pop-amber">截止 {fmtTime(incident.deadlineAt)}</span>
                </>
              )}
            </div>
          </li>
        ))}
      </ol>
    </div>
  )
}
