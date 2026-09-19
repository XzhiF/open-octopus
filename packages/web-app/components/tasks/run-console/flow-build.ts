// packages/web-app/components/tasks/run-console/flow-build.ts
//
// 执行动线合成器 —— 把 GET …/executions/:id/agent-events 的原始事件压成
// 「一行一段」的动线（2026-09-19 降噪定稿，验收C 真数据钉格式）：
//   • start/end 配对成节点行：时长（end.durationMs 优先，缺则时间戳差）+ 工具数
//   • tool_call → 节点下最多 3 条工具行：**input 可解析时给命令/文件摘要；
//     SQLite 混存老行 input 为空串（实测），退化为 result 里的 filePath；再不行只报工具名**
//   • 无 start/end 的节点（swarm 子代理，如 ticket-01）按时窗挂到父节点下缩进
//   • 同名节点二次 start（重试）开新实例，不并到上一段里
//   • loopIterations → ♻ 修复轮行（当前几/共几 + 挂掉计数）
//   • __engine_* 内部节点不算过程（沿用回放时代的过滤）
// 纯函数，无 React —— 真事件形状直接喂单测。

import type { AgentEvent, LoopIterationSummary } from "@/lib/types"
import { formatDuration } from "@/lib/format"
import { clockShort } from "./phase-status"

export type FlowLine =
  | { kind: "node"; key: string; at: string; name: string; dur: string; tools: number; running: boolean; bad: boolean; depth: number; writeNote?: string }
  | { kind: "tool"; key: string; chip: string; note: string; err: boolean; depth: number }
  | { kind: "loop"; key: string; label: string; detail: string }

/** 渲染上限：节点 ≤8（工具/子节点行不占账）；每节点最近工具 ≤3。 */
export const FLOW_NODE_CAP = 8
const RECENT_TOOLS = 3
const NOTE_MAX = 64

const ts = (e: AgentEvent): number => (e.timestamp ? Date.parse(e.timestamp) : NaN)
const iso = (ms: number): string => new Date(ms).toISOString()

function asObj(v: unknown): Record<string, unknown> | null {
  if (v && typeof v === "object") return v as Record<string, unknown>
  if (typeof v === "string" && v.trim().startsWith("{")) {
    try { return JSON.parse(v) as Record<string, unknown> } catch { return null }
  }
  return null
}
const base = (p: string): string => p.split(/[/\\]/).pop() ?? p
function firstLine(s: string): string {
  const l = s.split("\n").map((x) => x.trim()).find(Boolean) ?? ""
  return l.length > NOTE_MAX ? `${l.slice(0, NOTE_MAX)}…` : l
}

/** tool_call → 工具行料：chip=工具名，note 走 input→result.filePath→空 的退化链。 */
export function toolLine(e: AgentEvent): { chip: string; note: string; err: boolean } {
  const ed = asObj(e.event_data) ?? {}
  const chip = String(e.toolName ?? ed.toolName ?? "?")
  const err = e.isError === true || ed.isError === true
  const inp = asObj(e.input) ?? asObj(ed.input)
  let note = ""
  if (inp) {
    if (typeof inp.command === "string") note = firstLine(inp.command)
    else if (typeof inp.file_path === "string") note = base(inp.file_path)
    else if (typeof inp.pattern === "string") note = firstLine(inp.pattern)
  }
  if (!note && typeof e.result === "string") {
    const m = e.result.match(/"filePath"\s*:\s*"([^"]+)"/)
    if (m) note = base(m[1])
  }
  return { chip, note, err }
}

interface NodeAgg {
  name: string
  seq: number            // 同名第几段（重试）
  startTs: number | null
  endTs: number | null
  durMs: number | null
  bad: boolean
  firstTs: number        // 任何事件的最早时间（子节点挂窗用）
  tools: number
  recent: { chip: string; note: string; err: boolean }[]
  lastWrite: string | null
}

/**
 * 主入口。events 乱序容忍（显示按段结束/开始时间倒排）。
 * @param nowMs 进行中节点的活时长（调用方传 Date.now()，测试传定点）。
 */
export function buildFlow(
  events: AgentEvent[],
  nowMs: number,
  loopIterations?: Record<string, LoopIterationSummary>,
): FlowLine[] {
  const instances: NodeAgg[] = []
  const openByName = new Map<string, NodeAgg>()
  const mk = (name: string): NodeAgg => {
    const n: NodeAgg = {
      name, seq: instances.filter((i) => i.name === name).length + 1,
      startTs: null, endTs: null, durMs: null, bad: false, firstTs: Number.POSITIVE_INFINITY,
      tools: 0, recent: [], lastWrite: null,
    }
    instances.push(n)
    return n
  }
  for (const e of events) {
    if (!e.nodeId || e.nodeId.startsWith("__")) continue
    const at = ts(e)
    let n = openByName.get(e.nodeId) ?? null
    if (e.event === "start") {
      // 同名再 start：只有「攒了工具还没等到起止的段」（子代理先干活后转正）可收编；
      // 真正的上一段没等到 end 就重跑（中止后重试）→ 让它以「失败+被顶替时间」收尾
      if (n && n.startTs == null) {
        n.startTs = at
      } else {
        if (n) {
          n.bad = true
          n.endTs = Number.isNaN(at) ? null : at
        }
        n = mk(e.nodeId)
        n.startTs = at
        openByName.set(e.nodeId, n)
      }
    } else if (!n) {
      n = mk(e.nodeId)
      if (e.event === "tool_call") openByName.set(e.nodeId, n) // 子代理常驻「开」：多段工具并到一段
      else if (e.event === "end") n.endTs = at
    }
    if (!Number.isNaN(at) && at < n.firstTs) n.firstTs = at
    if (e.event === "end") {
      n.endTs = at
      if (typeof e.durationMs === "number") n.durMs = e.durationMs
      const st = String(e.status ?? "")
      if (st === "failed" || st === "aborted") n.bad = true
      openByName.delete(e.nodeId)
    } else if (e.event === "tool_call") {
      n.tools += 1
      const l = toolLine(e)
      n.recent.push(l)
      if (n.recent.length > RECENT_TOOLS) n.recent.shift()
      if (l.chip === "Edit" || l.chip === "Write") n.lastWrite = l.note || null
    } else if (e.event === "branch_start" || e.event === "branch_end") {
      // 编排边界不算过程行，但保证 firstTs 吃到时间
    }
  }
  const tops = instances.filter((n) => n.startTs != null || n.endTs != null)
  const children = instances.filter((n) => n.startTs == null && n.endTs == null)
  // 子代理挂父：child.firstTs 落在哪个 top 的 [start, end(活段按 nowMs)] 窗里；兜底取最后一个先开跑的
  const kidsByParent = new Map<NodeAgg, NodeAgg[]>()
  const orphans: NodeAgg[] = []
  for (const c of children) {
    let hit: NodeAgg | null = null
    for (const p of tops) {
      const s = p.startTs ?? Number.POSITIVE_INFINITY
      const en = p.endTs ?? nowMs
      if (c.firstTs >= s - 1000 && c.firstTs <= en) hit = p
    }
    if (!hit) for (const p of tops) if ((p.startTs ?? Infinity) <= c.firstTs) hit = p
    if (hit) {
      const arr = kidsByParent.get(hit) ?? []
      arr.push(c); kidsByParent.set(hit, arr)
    } else orphans.push(c)
  }
  const lastTs = (n: NodeAgg) => n.endTs ?? n.startTs ?? (Number.isFinite(n.firstTs) ? n.firstTs : 0)
  const nodeLine = (n: NodeAgg, depth: number): FlowLine => {
    const running = n.startTs != null && n.endTs == null
    const start = n.startTs ?? n.firstTs
    const durMs = n.durMs ?? (n.endTs != null && Number.isFinite(start) ? n.endTs - start : running && Number.isFinite(start) ? nowMs - start : null)
    const at = n.endTs != null ? clockShort(iso(n.endTs)) : Number.isFinite(start) ? clockShort(iso(start)) : ""
    return {
      kind: "node", key: `n:${n.name}#${n.seq}`, at, name: n.name,
      dur: durMs != null ? formatDuration(durMs) : "—", tools: n.tools,
      running, bad: n.bad, depth,
      ...(n.lastWrite ? { writeNote: n.lastWrite } : {}),
    }
  }
  const ordered = [...tops].sort((a, b) => lastTs(b) - lastTs(a))
  const lines: FlowLine[] = []
  let shown = 0
  for (const n of ordered) {
    if (shown >= FLOW_NODE_CAP) break
    shown += 1
    const running = n.startTs != null && n.endTs == null
    lines.push(nodeLine(n, 0))
    // 工具行只配活节点/最上两枚完结节点 —— 全铺就又成流水账
    if (running || shown <= 2) n.recent.forEach((t, i) => lines.push({ kind: "tool", key: `t:${n.name}#${n.seq}:${i}`, chip: t.chip, note: t.note, err: t.err, depth: 1 }))
    for (const c of kidsByParent.get(n) ?? []) lines.push(nodeLine(c, 1))
  }
  for (const c of orphans.slice(0, FLOW_NODE_CAP)) lines.push(nodeLine(c, 0))
  // ♻ 修复轮（loop 活着的进度）置顶
  if (loopIterations) {
    for (const [id, s] of Object.entries(loopIterations)) {
      if (!s || !s.total) continue
      const cur = s.current ?? s.completed + 1
      lines.unshift({ kind: "loop", key: `l:${id}`, label: `♻ ${id}`, detail: `第 ${Math.min(cur, s.total)}/${s.total} 轮${s.failed ? ` · 已挂 ${s.failed} 轮` : ""}` })
    }
  }
  return lines
}
