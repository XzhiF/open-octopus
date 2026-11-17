// 舱通信 Trace 事件词表（CabinTrace 用）。
// kind 来自 cabin_job_events（append-only），这里只做展示映射。

export interface TraceKindMeta {
  label: string
  /** 圆点 class */
  dot: string
  /** SBadge color */
  badge: 'violet' | 'cyan' | 'amber' | 'pink' | 'dim' | 'green' | 'red' | 'purple' | 'navy'
}

export const TRACE_KIND_META: Record<string, TraceKindMeta> = {
  dispatch: { label: '派发', dot: 'bg-pop-violet', badge: 'violet' },
  brief: { label: '意图', dot: 'bg-pop-violet', badge: 'violet' },
  report: { label: '回报', dot: 'bg-pop-cyan', badge: 'cyan' },
  attention: { label: '需注意', dot: 'bg-pop-amber', badge: 'amber' },
  handback: { label: '回弹', dot: 'bg-pop-pink', badge: 'pink' },
  human_input: { label: '人输入', dot: 'bg-pop-green', badge: 'green' },
  decision: { label: '决策', dot: 'bg-pop-purple', badge: 'purple' },
  resume: { label: '恢复', dot: 'bg-pop-green', badge: 'green' },
}

export function traceKind(kind: string): TraceKindMeta {
  return TRACE_KIND_META[kind] ?? { label: kind, dot: 'bg-pop-dim', badge: 'dim' }
}
