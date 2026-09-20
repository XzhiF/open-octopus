// packages/web-app/components/tasks/run-console/signal-build.ts
//
// 「大事报」信号合成器（2026-09-20 定稿，取代执行动线）—— 设计前提是被用户逼出来的：
// 304 条全绿事件压成 6 行履历 = 没有任何一行需要用户决策，看不看一样。
// 反转规则：**只报「你该知道的事」；一条没有 → 整块不渲染**（比"全绿"更好的报告是没有报告）。
//
// 四道信号，捕获度经真数据审计（exec 077578ec / 38127532 实拉）：
//   ✗ 挂过   isError 按节点聚合；「同节点同工具后续成功」判自愈。命令体在老行可能缺
//            （input 空串实测存在），detail 退化吃 result 首行。完结后保留 ——
//            「是不是硬修绿的」对验收判决有真价值。
//   ♻ 修复轮 loopIterations（工作流用 Loop 节点才有；agent 内部自愈引擎是瞎的，不假装）。
//   ▷ 在跑   tool_start 未等到 tool_result/tool_call（按 toolCallId 配对）；
//            现行 matt 流不写 start 行 → 该线自然缺席，有料的流才亮。仅 live。
//   📦 产出  Write/Edit 去重文件数 + 代表名。仅 live（完结后归交付卡/账本，不重复）。

import type { AgentEvent, LoopIterationSummary } from "@/lib/types"
import { formatDuration } from "@/lib/format"

export type SignalLine = {
  kind: "bad" | "loop" | "stall" | "out"
  glyph: string
  text: string
  detail?: string
}

const ts = (e: AgentEvent): number => (e.timestamp ? Date.parse(e.timestamp) : NaN)

function asObj(v: unknown): Record<string, unknown> | null {
  if (v && typeof v === "object") return v as Record<string, unknown>
  if (typeof v === "string" && v.trim().startsWith("{")) {
    try { return JSON.parse(v) as Record<string, unknown> } catch { return null }
  }
  return null
}
const fname = (p: string): string => p.split(/[/\\]/).pop() ?? p
function clip(s: string, n = 90): string {
  const one = s.split("\n").map((x) => x.trim()).filter(Boolean)[0] ?? ""
  return one.length > n ? `${one.slice(0, n)}…` : one
}
/** 工具料：名 + 摘要（input.command/file_path → event_data → result.filePath 的退化链）。 */
function toolFact(e: AgentEvent): { name: string; note: string } {
  const ed = asObj(e.event_data) ?? {}
  const name = String(e.toolName ?? ed.toolName ?? "?")
  const inp = asObj(e.input) ?? asObj(ed.input)
  let note = ""
  if (inp) {
    if (typeof inp.command === "string") note = clip(inp.command)
    else if (typeof inp.file_path === "string") note = fname(inp.file_path)
  }
  if (!note && typeof e.result === "string") {
    const m = e.result.match(/"filePath"\s*:\s*"([^"]+)"/)
    if (m) note = fname(m[1])
  }
  return { name, note }
}

export function buildSignals(
  events: AgentEvent[],
  nowMs: number,
  opts: { live: boolean; loopIterations?: Record<string, LoopIterationSummary> },
): SignalLine[] {
  const out: SignalLine[] = []
  const visible = events.filter((e) => e.nodeId && !e.nodeId.startsWith("__"))

  // ── ✗ 挂过 ────────────────────────────────────────────────────────
  type Bad = { node: string; count: number; tools: Set<string>; firstNote: string; recovered: boolean }
  const bads = new Map<string, Bad>()
  for (let i = 0; i < visible.length; i++) {
    const e = visible[i]
    const isErr = e.isError === true || asObj(e.event_data)?.isError === true
    if (e.event !== "tool_call" || !isErr) continue
    const { name, note } = toolFact(e)
    const b = bads.get(e.nodeId) ?? { node: e.nodeId, count: 0, tools: new Set(), firstNote: "", recovered: false }
    b.count += 1
    b.tools.add(name)
    if (!b.firstNote) {
      b.firstNote = note
        || (typeof e.result === "string" ? clip(e.result) : "")
    }
    // 自愈 = 同节点同工具之后有一次不报错的调用
    b.recovered = visible.slice(i + 1).some((x) => x.event === "tool_call" && x.nodeId === e.nodeId && (x.toolName ?? "") === name && x.isError !== true)
    bads.set(e.nodeId, b)
  }
  for (const b of bads.values()) {
    out.push({
      kind: "bad", glyph: "✗",
      text: `${b.node} 挂过 ${b.count} 次 ${[...b.tools].join("/")}（${b.recovered ? "均已自愈" : "未见恢复"}）`,
      ...(b.firstNote ? { detail: b.firstNote } : {}),
    })
  }

  // ── ▷ 在跑（toolCallId 配对，缺 start 行的流自然无此线）──────────────
  if (opts.live) {
    const settled = new Set<string>()
    const starts: AgentEvent[] = []
    for (const e of visible) {
      const id = e.toolCallId
      if (!id) continue
      if (e.event === "tool_start") starts.push(e)
      else if (e.event === "tool_result" || e.event === "tool_call") settled.add(id)
    }
    for (const s of starts.reverse().slice(0, 2)) {
      if (s.toolCallId && settled.has(s.toolCallId)) continue
      const at = ts(s)
      const { name, note } = toolFact(s)
      out.unshift({
        kind: "stall", glyph: "▷",
        text: `在跑：${name} 已 ${!Number.isNaN(at) ? formatDuration(Math.max(0, nowMs - at)) : "?"}${note ? `（${note}）` : ""}`,
      })
    }
  }

  // ── ♻ 修复轮（仅工作流有 Loop 节点时存在 —— 不假装知道 agent 内部自愈）──
  if (opts.loopIterations) {
    for (const [id, s] of Object.entries(opts.loopIterations)) {
      if (!s || (!s.total && !s.completed && !s.failed && s.current == null)) continue
      const done = (s.completed ?? 0) + (s.failed ?? 0)
      const cur = s.current ?? (opts.live ? done + 1 : done)
      const of = s.total ? `/${s.total}` : ""
      const lastBad = s.iterations?.filter((x) => x.status === "failed").pop()
      out.push({
        kind: "loop", glyph: "♻",
        text: `${id} 第 ${cur}${of} 轮${s.failed ? ` · 已挂 ${s.failed} 轮` : ""}`,
        ...(lastBad?.error ? { detail: clip(lastBad.error) } : {}),
      })
    }
  }

  // ── 📦 产出（仅 live；完结后交付卡/账本已有）────────────────────────
  if (opts.live) {
    const files = new Set<string>()
    for (const e of visible) {
      if (e.event !== "tool_call") continue
      const { name, note } = toolFact(e)
      if ((name === "Write" || name === "Edit") && note) files.add(note)
    }
    if (files.size > 0) {
      const list = [...files]
      out.push({
        kind: "out", glyph: "📦",
        text: `已落 ${files.size} 个文件 · ${list.slice(0, 3).join(" · ") + (list.length > 3 ? ` +${list.length - 3}` : "")}`,
      })
    }
  }

  return out
}
