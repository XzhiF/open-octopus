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

/** ⑪真机复点 · 日志铺到底 + 自动贴底跟随：仅当用户视口停在底部（80px 缓冲内）
 *  才把新事件滚进来 —— 手动上翻回看不被抢滚动。空盒（scrollHeight ≤ clientHeight，
 *  含 jsdom 全 0 场景）余量为 0/负 → 视为贴底，无害。 */
export function nearStreamBottom(scrollTop: number, scrollHeight: number, clientHeight: number): boolean {
  return scrollHeight - scrollTop - clientHeight < 80
}

// ── 票11 双轴 review 收口① — 既有 SSE 通道实时追加 ──────────────────────────
// 通道 = GET /api/workspaces/:ws/executions/events（engine 经 EngineCallbacks.
// onAgentEvent 以 "agent_event" emit；sse-manager 按 url 共享一条 EventSource，
// 本壳订阅不会另开第二份连接）。载荷 { executionId, nodeId, event }，event =
// engine agent-types.ts 的原始联合。轮询（fetchAgentEvents）退位为兜底/首屏。

/** wire event（engine AgentEvent 的松散形）→ 展示层 AgentEvent；null = 噪声跳过。
 *  只转「结构性事实」：tool_result → tool_call 行（⚙/✗）、error → ✗ 行、
 *  intervention/intervention_result → ⚑ 行（包装形 = nodes-model 既有旧代分支）、
 *  harness_directive → ⚑ 行。text_delta/thinking 增量碎片、turn_usage/status/
 *  heartbeat 等不实时成行 —— 合并形由轮询权威补全（防 token 碎片刷屏）。 */
export function agentEventFromWire(
  nodeId: string,
  raw: Record<string, unknown> | null | undefined,
): AgentEvent | null {
  if (!raw || typeof raw !== "object" || !nodeId) return null
  const type = raw.type
  if (typeof type !== "string") return null
  const ms = typeof raw.timestamp === "number" && Number.isFinite(raw.timestamp)
    ? raw.timestamp
    : Date.now()
  const timestamp = new Date(ms).toISOString()
  switch (type) {
    case "tool_result":
      return {
        nodeId,
        event: "tool_call",
        toolCallId: typeof raw.toolCallId === "string" ? raw.toolCallId : undefined,
        toolName: typeof raw.toolName === "string" ? raw.toolName : undefined,
        result: typeof raw.content === "string" ? raw.content : undefined,
        isError: raw.isError === true,
        timestamp,
      }
    case "error":
    case "intervention":
    case "intervention_result":
      // 包装形 = lineForEvent 的 agent_event 旧代分支（⚑/✗ 都已认）。
      return {
        nodeId,
        event: "agent_event",
        event_data: raw as NonNullable<AgentEvent["event_data"]>,
        timestamp,
      }
    case "harness_directive":
      return {
        nodeId,
        event: "harness_directive",
        data: (raw.data ?? {}) as Record<string, unknown>,
        timestamp,
      }
    default:
      return null
  }
}

/** 轮询快照回来后自愈实时追加：丢弃时刻 ≤ 快照最晚事件的追加行（已被权威快照
 *  覆盖，防同事件双现）；严格更晚或缺时刻的保留。快照排序无关（取 max）。 */
export function retainNewerThan(
  appended: readonly AgentEvent[],
  snapshot: readonly AgentEvent[],
): AgentEvent[] {
  let max = Number.NEGATIVE_INFINITY
  for (const e of snapshot) {
    const t = timeOf(e)
    if (t !== Number.POSITIVE_INFINITY && t > max) max = t
  }
  if (max === Number.NEGATIVE_INFINITY) return [...appended]
  return appended.filter((e) => {
    const t = timeOf(e)
    return t === Number.POSITIVE_INFINITY || t > max
  })
}
