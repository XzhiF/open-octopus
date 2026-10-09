// packages/web-app/components/tasks/run-console/log-model.ts
//
// 票 11 ⑩回补 — 「▶ 日志」页签的纯映射层：绑定执行的 agent_events（票06 起
// ⚑ 人工干预也是这里的一等事件）→ 时间正序展示行。
//
// 分类词表**不另起炉灶**：逐行走 nodes-model.eventLineFor 单源（工具/编辑/成败/
// 警告 + ⚑ pink 干预行），本模块只补日志形态特有的两点 —— 时间正序排序与逐行
// 时刻（原型 consoleHtml 的 .ts 前缀）。缺 timestamp 的行（罕见旧代）排到最后，
// 按输入序稳定保留（追加语义不骗人）。

import type { AgentEvent } from "@/lib/types"
import { eventLineFor, type NodeEventLine } from "./nodes-model"

export interface LogLine extends NodeEventLine {
  /** 原始 ISO 时刻（渲染层做 HH:mm:ss）；缺 = null。 */
  at: string | null
}

export function buildLogLines(events: AgentEvent[], limit = 500): LogLine[] {
  const idx = events.map((_, i) => i).sort((a, b) => {
    const ta = timeOf(events[a]!)
    const tb = timeOf(events[b]!)
    if (ta !== tb) return ta - tb
    return a - b
  })
  const lines: LogLine[] = []
  for (const i of idx) {
    const e = events[i]!
    const line = eventLineFor(e)
    if (!line) continue
    lines.push({ ...line, at: e.timestamp ?? null })
  }
  return lines.slice(-Math.max(0, limit))
}

function timeOf(e: AgentEvent): number {
  if (!e.timestamp) return Number.POSITIVE_INFINITY
  const t = Date.parse(e.timestamp)
  return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t
}
