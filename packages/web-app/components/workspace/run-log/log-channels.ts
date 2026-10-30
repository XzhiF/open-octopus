// 运行日志 · 通道模型（纯函数，无 React）
//
// 为什么要这一层：旧的 ExecutionLogViewer 把事件按 nodeId 折成一组组可折叠块，
// 时间顺序被组边界打断 —— 并发（DAG 多节点 / swarm 多专家）时既看不出谁在同时跑，
// 也追不上一行该归谁。这里改成「流」的模型：一条事件 = 一行 = 一个通道 + 一个时刻，
// 全局按时间排序，通道只决定颜色和标签，不决定分组。
//
// 数据来源 GET /api/.../executions/:id/agent-events —— 服务端已把 SQLite 与 JSONL
// 两路合并成全局时间序，并做过 compact（thinking_block / text_block / tool_call /
// bash_output 等块状事件）。节点状态与起止时间以 steps（node_executions）为准，
// 事件里的 start/end 只做行内标记。

import type { AgentEvent, StepExecution } from "@/lib/types"
import { formatDuration } from "@/lib/format"

/** 事件里带 role / round 等 swarm 字段，AgentEvent 未声明，这里就地补窄。 */
export type RunEvent = AgentEvent & {
  role?: string
  model?: string
  round?: number
  expertCount?: number
  tokens?: number
  synthesis?: string
  prompt?: string
  options?: Array<{ label?: string; value?: string }>
  decision?: string
  comment?: string
  error?: string
  message?: string
  output?: string
  type?: string
}

export type LogKind =
  | "start" | "end" | "fail"
  | "think" | "text" | "tool" | "out" | "log"
  | "warn" | "err"
  | "swarm" | "approval" | "beat"

export type LogLevel = "trace" | "info" | "warn" | "error"

export interface LogRow {
  /** React key：事件序号 + 通道，稳定且唯一 */
  id: string
  /** 事件时刻（epoch ms）；缺时间戳的块状事件回落到 startedAt/completedAt */
  at: number
  chId: string
  kind: LogKind
  level: LogLevel
  /** 行内正文（已压成单行摘要） */
  text: string
  /** 展开后的正文（工具输入/结果、完整输出、多行叙述） */
  detail?: string
  /** 正文本身就是多行 → 折叠时截断，展开时原样显示 */
  block?: boolean
  /** swarm 专家等并发子流标识 */
  role?: string
  /** 行内被截断掉的行数提示 */
  moreLines?: number
  /** 思考段摘要（字数 · 时长），折叠态显示在标题上 */
  meta?: string
  /** 工具调用的结构化载荷 —— 展开面板分别渲染 input / result */
  toolName?: string
  toolInput?: string
  toolResult?: string
  toolIsError?: boolean
  event: RunEvent
}

export type ChannelStatus = "pending" | "running" | "done" | "failed" | "skipped"

export interface LogChannel {
  id: string
  /** 基础 nodeId（去掉 -iterN 后缀），用于和 DAG 节点联动 */
  node: string
  /** 短标 —— 流里那一列 */
  tag: string
  label: string
  color: string
  iteration?: number
  count: number
  firstAt: number | null
  lastAt: number | null
  /** 通道结束时刻（steps 终态或 end 事件） */
  endedAt: number | null
  startedAt: number | null
  status: ChannelStatus
  durationMs: number | null
  /** 并发子流（swarm 专家 role） */
  roles: string[]
  /** 终态错误摘要 */
  error?: string
}

/** 通道色：只取色板，红/灰留给错误 —— 同一通道恒定同色，不随步骤增减而变。 */
export const CHANNEL_PALETTE = [
  "var(--pop-navy)",
  "var(--pop-green)",
  "var(--pop-cyan)",
  "var(--pop-purple)",
  "var(--pop-yellow)",
  "var(--pop-pink)",
]

export function colorForChannel(id: string): string {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  return CHANNEL_PALETTE[h % CHANNEL_PALETTE.length]
}

/** 事件时间：块状事件（bash_output / tool_call）不带 timestamp，只有 startedAt。 */
export function eventTime(e: RunEvent): number {
  const raw = e.timestamp || e.startedAt || e.completedAt
  if (!raw) return 0
  const t = Date.parse(raw)
  return Number.isNaN(t) ? 0 : t
}

/**
 * 通道 = 一条并发流的最小单位：
 *   节点（含 sub_workflow 的 `父:子` scoped id）+ loop 轮次 + swarm 专家 role。
 * role 不进通道 id —— 专家同属一个节点通道，行内以 role 徽章区分，
 * 并发计数时再按 role 拆开（见 concurrentStreams）。
 */
export function channelKeyOf(e: RunEvent): string {
  const node = e.nodeId || "(未归属)"
  return e.iteration != null && e.iteration > 0 ? `${node}#${e.iteration}` : node
}

export function shortTag(node: string, iteration?: number): string {
  const base = node.includes(":") ? node.slice(node.lastIndexOf(":") + 1) : node
  const stripped = base.replace(/-iter\d+$/i, "")
  const tag = stripped.length > 14 ? `${stripped.slice(0, 13)}…` : stripped
  return iteration != null && iteration > 0 ? `${tag}·${iteration}` : tag
}

/**
 * 通道的唯一展示名 —— 同一行/同一栏里永远只出现这一种写法。
 *   · 有真正的人话名（stepName ≠ node 且 ≠ 短标）→ 用人话名
 *   · 否则用短标（sub_workflow 只取 `:` 后一段，ticket-dag:ticket-01 → ticket-01）
 * 完整 node_id 只留给 tooltip / DAG 联动，不再上屏。
 */
export function displayNameOf(ch: Pick<LogChannel, "node" | "tag" | "label">): string {
  if (ch.node === "__engine_init__") return "初始化"
  const label = ch.label?.trim()
  if (label && label !== ch.node && label !== ch.tag) return label
  return ch.tag
}

const ONE_LINE = /\s*\n\s*/g

function oneLine(s: string, max = 200): string {
  const flat = s.replace(ONE_LINE, " · ").trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

/** 工具入参压成可读的一小截：优先挑语义键，而不是整坨 JSON。 */
export function compactInput(input: unknown): string {
  if (input == null) return ""
  if (typeof input === "string") return oneLine(input, 120)
  if (Array.isArray(input)) return oneLine(JSON.stringify(input), 120)
  if (typeof input === "object") {
    const rec = input as Record<string, unknown>
    for (const key of ["command", "cmd", "file_path", "path", "pattern", "query", "url", "prompt", "todos", "skill", "node_id"]) {
      const v = rec[key]
      if (typeof v === "string" && v) return oneLine(v, 120)
      if (Array.isArray(v) && v.length) return `${key}: ${v.length} 项`
    }
    return oneLine(JSON.stringify(input), 120)
  }
  return String(input)
}

function detailOfTool(e: RunEvent): string | undefined {
  const parts: string[] = []
  if (e.input != null) parts.push(`输入\n${typeof e.input === "string" ? e.input : JSON.stringify(e.input, null, 2)}`)
  if (e.result) parts.push(`结果\n${e.result}`)
  if (!parts.length && e.event_data?.input != null) {
    parts.push(`输入\n${typeof e.event_data.input === "string" ? e.event_data.input : JSON.stringify(e.event_data.input, null, 2)}`)
  }
  if (!parts.length && e.event_data?.content) parts.push(String(e.event_data.content))
  return parts.length ? parts.join("\n\n") : undefined
}

function outputRow(e: RunEvent, content: string, errLevel: LogKind): Pick<LogRow, "kind" | "level" | "text" | "detail" | "moreLines"> {
  const lines = e.lines && e.lines.length ? e.lines : content.split("\n").filter((l) => l.trim() !== "")
  const head = lines.slice(0, 2).join(" ⏎ ")
  return {
    kind: errLevel,
    level: errLevel === "err" ? "error" : "trace",
    text: oneLine(head, 220),
    detail: lines.length > 2 ? lines.join("\n") : undefined,
    moreLines: lines.length > 2 ? lines.length - 2 : undefined,
  }
}

const END_OK = new Set(["completed", "success", "skipped"])

/** 旧数据里的 tool input 常是 JSON 字符串；先解回对象，语义键提取才不会失效。 */
function parseToolInput(v: unknown): unknown {
  if (typeof v !== "string") return v
  const text = v.trim()
  if (!text.startsWith("{") && !text.startsWith("[")) return v
  try { return JSON.parse(text) } catch { return v }
}

/** 工具入参/结果 → 展开面板里的纯文本。 */
function payloadText(v: unknown): string | undefined {
  if (v == null || v === "") return undefined
  if (typeof v === "string") return v
  try { return JSON.stringify(v, null, 2) } catch { return String(v) }
}

function spanDuration(startedAt?: string, completedAt?: string): string | null {
  if (!startedAt || !completedAt) return null
  const ms = Date.parse(completedAt) - Date.parse(startedAt)
  return Number.isFinite(ms) && ms > 0 ? formatDuration(ms) : null
}

/**
 * 同一 toolCallId 的碎片合成一条 —— 历史数据里控制事件插在
 * tool_input / tool_result 之间，把一次调用拆成了两行。服务端已修根，
 * 这里再兜底一次，保证旧执行、旧缓存也能显示成完整的 `▸ Read path [✓]`。
 */
export function coalesceToolCalls(events: RunEvent[]): RunEvent[] {
  const out: RunEvent[] = []
  const byId = new Map<string, RunEvent>()
  for (const e of events) {
    if (e.event !== "tool_call" || !e.toolCallId) {
      out.push(e)
      continue
    }
    const key = `${e.nodeId ?? ""}|${e.toolCallId}`
    const prev = byId.get(key)
    if (!prev) {
      const copy = { ...e }
      byId.set(key, copy)
      out.push(copy)
      continue
    }
    if ((prev.input == null || prev.input === "") && e.input != null && e.input !== "") prev.input = e.input
    if (prev.result == null && e.result != null) prev.result = e.result
    if (e.isError) prev.isError = true
    if (!prev.toolName && e.toolName) prev.toolName = e.toolName
    for (const key of ["startedAt", "completedAt"] as const) {
      if (!e[key]) continue
      const current = Date.parse(prev[key] ?? "")
      const next = Date.parse(e[key])
      if (Number.isNaN(current)) prev[key] = e[key]
      else if (!Number.isNaN(next) && (key === "startedAt" ? next < current : next > current)) prev[key] = e[key]
    }
  }
  return out
}

/**
 * 一条事件 → 一行（或 null = 不显示）。
 * branch_start / branch_end 是给 Loop 概览用的元数据；status 是心跳级噪声 —— 都不进流。
 */
export function rowFromEvent(e: RunEvent, index: number): LogRow | null {
  const chId = channelKeyOf(e)
  const base = { id: `${chId}:${index}`, at: eventTime(e), chId, role: e.role, event: e }
  const ev = e.event
  const sub = e.event_data?.type

  // ── 永不显示 ──
  if (ev === "branch_start" || ev === "branch_end" || ev === "status") return null

  // ── 节点生命周期 ──
  if (ev === "start") {
    return { ...base, kind: "start", level: "info", text: `节点开始 · ${e.type ?? e.data?.type ?? "node"}` }
  }
  if (ev === "end") {
    const status = String(e.status ?? e.data?.status ?? "completed")
    const dur = e.durationMs == null ? "" : ` · ${formatDuration(e.durationMs)}`
    const code = e.exitCode != null && e.exitCode !== 0 ? ` · exit ${e.exitCode}` : ""
    const bad = !END_OK.has(status)
    return {
      ...base,
      kind: bad ? "fail" : "end",
      level: bad ? "error" : "info",
      text: `${bad ? "节点结束" : "节点完成"} · ${status}${dur}${code}${e.error ? ` · ${oneLine(String(e.error), 90)}` : ""}`,
    }
  }

  // ── agent 块状事件（服务端已 compact）──
  if (ev === "thinking_block" || sub === "thinking_block") {
    const content = e.content ?? e.event_data?.content ?? ""
    const duration = spanDuration(e.startedAt, e.completedAt)
    const meta = `${content.length.toLocaleString()} 字${duration ? ` · ${duration}` : ""}`
    return { ...base, kind: "think", level: "info", text: `思考 · ${meta}`, detail: content, block: true, meta }
  }
  if (ev === "text_block" || sub === "text_delta") {
    const content = e.content ?? e.event_data?.content ?? ""
    return { ...base, kind: "text", level: "info", text: oneLine(content, 160), detail: content, block: true }
  }
  if (ev === "tool_call") {
    const name = e.toolName || "tool"
    const input = parseToolInput(e.input)
    const arg = compactInput(input)
    const failed = e.isError === true
    return {
      ...base,
      kind: failed ? "err" : "tool",
      level: failed ? "error" : "info",
      text: arg ? `${name} ${arg}` : name,
      detail: detailOfTool(e),
      toolName: name,
      toolInput: payloadText(input) ?? payloadText(e.event_data?.input),
      toolResult: payloadText(e.result) ?? payloadText(e.event_data?.content),
      toolIsError: failed,
    }
  }
  if (ev === "bash_output" || ev === "python_output") {
    return { ...base, ...outputRow(e, e.content ?? "", "out") }
  }
  if (ev === "bash_stderr" || ev === "python_stderr") {
    return { ...base, ...outputRow(e, e.content ?? "", "err") }
  }
  // 未 compact 的旧行（JSONL 兜底路径）
  if (ev === "bash_log" || ev === "python_log") {
    return { ...base, kind: "out", level: "trace", text: oneLine(e.line ?? e.content ?? "", 220) }
  }
  if (ev === "tool_input" || ev === "tool_result") {
    const name = e.toolName ?? e.event_data?.toolName ?? "tool"
    const isResult = ev === "tool_result"
    return {
      ...base,
      kind: isResult && e.isError ? "err" : "tool",
      level: isResult && e.isError ? "error" : "info",
      text: name,
      detail: detailOfTool(e),
      toolName: name,
      toolInput: isResult ? undefined : payloadText(e.input),
      toolResult: isResult ? payloadText(e.content ?? e.result) : undefined,
      toolIsError: isResult && e.isError === true,
    }
  }
  if (ev === "agent_event") {
    // 控制事件 / 空外壳：旧读路径会把外层 event_type 当 subtype，这里直接吞掉。
    if (!sub || sub === "status" || sub === "turn_usage" || sub === "active_goal") return null
    if (sub === "agent_event") {
      const legacy = e.content ?? e.event_data?.content
      return legacy ? { ...base, kind: "log", level: "info", text: oneLine(legacy, 200) } : null
    }
    if (sub === "error") {
      return { ...base, kind: "err", level: "error", text: oneLine(e.event_data?.message ?? e.event_data?.content ?? "错误", 200) }
    }
    if (sub === "thinking" || sub === "thinking_start" || sub === "thinking_done") return null
    const content = e.content ?? e.event_data?.content ?? e.event_data?.message
    if (!content) return null
    return { ...base, kind: "log", level: "info", text: oneLine(`${sub} ${content}`, 200) }
  }

  // ── 节点自身输出 / 子工作流转发 ──
  if (ev === "node_log") {
    const line = e.line ?? e.content ?? ""
    const failed = /\b(error|失败|failed|exception)\b/i.test(line)
    return { ...base, kind: failed ? "err" : "log", level: failed ? "error" : "info", text: oneLine(line, 220) }
  }
  if (ev === "error") {
    return { ...base, kind: "err", level: "error", text: oneLine(String(e.message ?? e.error ?? e.content ?? "错误"), 220) }
  }

  // ── swarm：专家是并发子流 ──
  if (ev === "expert_spawn") {
    return { ...base, kind: "swarm", level: "info", role: e.role, text: `专家上岗 · ${e.role ?? "?"}${e.model ? ` · ${e.model}` : ""}` }
  }
  if (ev === "expert_message") {
    const content = e.content ?? ""
    return { ...base, kind: "text", level: "info", role: e.role, text: oneLine(content, 160), detail: content, block: true }
  }
  if (ev === "expert_complete") {
    const bad = e.status && e.status !== "completed"
    return {
      ...base,
      kind: bad ? "fail" : "end",
      level: bad ? "error" : "info",
      role: e.role,
      text: `专家完成 · ${e.role ?? "?"} · ${e.status ?? "completed"}${e.tokens ? ` · ${e.tokens} tok` : ""}`,
      detail: e.output ?? e.synthesis ?? undefined,
    }
  }
  if (ev === "swarm_round_end") {
    return { ...base, kind: "swarm", level: "info", text: `R${e.round ?? "?"} 结束 · ${e.expertCount ?? e.role?.length ?? 0} 专家` }
  }
  if (ev === "consensus_check") {
    return { ...base, kind: "swarm", level: "info", text: `共识检测 · R${e.round ?? "?"}` }
  }
  if (ev === "swarm_complete") {
    return { ...base, kind: "swarm", level: e.status === "failed" ? "error" : "info", text: `Swarm 完成 · ${e.status ?? "?"}`, detail: e.synthesis ?? undefined }
  }

  // ── 审批 / 人工干预 ──
  if (ev === "approval_metadata") {
    const opts = (e.options ?? []).map((o) => o?.label ?? o?.value ?? "").filter(Boolean).join(" / ")
    return {
      ...base, kind: "approval", level: "warn",
      text: `等待审批${e.prompt ? ` · ${oneLine(e.prompt, 90)}` : ""}${opts ? ` [${opts}]` : ""}${e.decision ? ` → ${e.decision}` : ""}`,
      detail: [e.prompt, e.comment && `备注：${e.comment}`].filter(Boolean).join("\n") || undefined,
    }
  }
  if (ev === "intervention" || ev === "intervention_result") {
    const d = (e.data ?? {}) as { prompt?: string; result?: string; nodeName?: string }
    return { ...base, kind: "approval", level: "warn", text: `${ev === "intervention" ? "⚑ 注入干预" : "⚑ 干预回执"} · ${oneLine(d.prompt ?? d.result ?? "", 140)}`, detail: d.prompt ?? d.result ?? undefined }
  }

  // ── 心跳 / harness / 其他 ──
  if (ev === "heartbeat") {
    const hb = e.heartbeatPayload
    return {
      ...base, kind: "beat", level: "trace",
      text: hb ? `心跳 · ${hb.step ?? "?"}${hb.tokens_used ? ` · ${hb.tokens_used} tok` : ""}${hb.current_activity ? ` · ${oneLine(hb.current_activity, 60)}` : ""}` : "心跳",
    }
  }
  if (ev === "heartbeat_stall") {
    return { ...base, kind: "warn", level: "warn", text: `停滞检测 · 超过 ${e.stallPayload?.timeout_seconds ?? "?"}s 无心跳` }
  }
  if (ev.startsWith("harness_")) {
    const d = (e.data ?? {}) as { reason?: string; message?: string; type?: string }
    const isAbort = ev.includes("abort")
    return {
      ...base, kind: isAbort ? "fail" : "warn", level: isAbort ? "error" : "warn",
      text: `🛡 ${ev.replace("harness_", "")}${d.reason ? ` · ${oneLine(d.reason, 120)}` : ""}`,
      detail: d.message ?? undefined,
    }
  }

  return { ...base, kind: "log", level: "info", text: oneLine(String(e.content ?? e.line ?? ev), 220) }
}

export function buildRows(events: RunEvent[]): LogRow[] {
  const rows: LogRow[] = []
  const coalesced = coalesceToolCalls(events)
  for (let i = 0; i < coalesced.length; i++) {
    const row = rowFromEvent(coalesced[i], i)
    if (row) rows.push(row)
  }
  // 服务端已按时间排序；这里只做稳定兜底（同刻保持原序）
  return rows.sort((a, b) => a.at - b.at)
}

const DONE_STEPS = new Set(["completed", "failed", "skipped", "cancelled", "rejected"])
const BAD_STEPS = new Set(["failed", "cancelled", "rejected"])

/** steps 里该节点的归属行：loop / sub_workflow 的子步骤带 `-iterN` 后缀，与事件通道 id 不同形。 */
function stepFor(steps: StepExecution[], node: string, iteration?: number): StepExecution | undefined {
  const direct = steps.find((s) => s.stepId === node)
  if (direct) return direct
  if (iteration == null) return undefined
  // 事件 iteration 从 1 起，stepId 后缀基数按 0/1 两种都试一次
  return steps.find((s) => s.stepId === `${node}-iter${iteration}`)
    ?? steps.find((s) => s.stepId === `${node}-iter${iteration - 1}`)
}

function statusOfStep(step?: StepExecution): ChannelStatus {
  if (!step) return "running"
  if (step.status === "running" || step.status === "pending_approval" || step.status === "pending_interaction") return "running"
  if (step.status === "pending") return "pending"
  if (step.status === "skipped") return "skipped"
  if (BAD_STEPS.has(step.status)) return "failed"
  return "done"
}

/**
 * 通道列表 = 已经在说话的流。
 * 以事件为主（每个节点一开始就有 start 行），steps 只提供可读名 / 权威状态 / 起止时间；
 * 另把「已启动但一行未吐」的 running 节点补进来 —— 那正是停滞信号，不该隐身。
 * 未开始的节点不在这里出现，它们是 DAG 的职责。
 */
export function buildChannels(rows: LogRow[], steps: StepExecution[]): LogChannel[] {
  const map = new Map<string, LogChannel>()

  for (const r of rows) {
    let ch = map.get(r.chId)
    if (!ch) {
      const node = r.chId.split("#")[0]
      const iteration = r.chId.includes("#") ? Number(r.chId.slice(r.chId.indexOf("#") + 1)) : undefined
      const step = stepFor(steps, node, iteration)
      ch = {
        id: r.chId, node, iteration,
        tag: shortTag(node, iteration),
        label: step?.stepName && step.stepName !== node ? step.stepName : node,
        color: colorForChannel(r.chId),
        count: 0, firstAt: null, lastAt: null,
        startedAt: step?.startedAt ? Date.parse(step.startedAt) : null,
        endedAt: step?.completedAt && DONE_STEPS.has(step.status) ? Date.parse(step.completedAt) : null,
        status: statusOfStep(step),
        durationMs: step?.duration != null ? step.duration * 1000 : null,
        roles: [],
        error: step?.error,
      }
      map.set(r.chId, ch)
    }
    ch.count++
    if (ch.firstAt == null) ch.firstAt = r.at
    ch.lastAt = r.at
    if (ch.startedAt == null) ch.startedAt = r.at
    if (r.role && !ch.roles.includes(r.role)) ch.roles.push(r.role)
    // 只有节点级 end/fail（非专家回执）才给通道定终态
    if (!r.role && (r.kind === "end" || r.kind === "fail")) {
      ch.endedAt = ch.endedAt ?? r.at
      ch.status = r.kind === "fail" ? "failed" : "done"
    }
  }

  for (const s of steps) {
    if (!s.startedAt || statusOfStep(s) !== "running") continue
    const id = channelKeyOf({ nodeId: s.stepId, event: "start" } as RunEvent)
    if (map.has(id)) continue
    map.set(id, {
      id, node: s.stepId,
      tag: shortTag(s.stepId), label: s.stepName && s.stepName !== s.stepId ? s.stepName : s.stepId,
      color: colorForChannel(id),
      count: 0, firstAt: null, lastAt: null,
      startedAt: Date.parse(s.startedAt), endedAt: null,
      status: "running",
      durationMs: s.duration != null ? s.duration * 1000 : null,
      roles: [],
    })
  }

  const list = Array.from(map.values())
  for (const ch of list) {
    if (ch.durationMs == null && ch.startedAt != null && ch.endedAt != null) ch.durationMs = ch.endedAt - ch.startedAt
  }
  return list.sort((a, b) => (a.startedAt ?? a.firstAt ?? Infinity) - (b.startedAt ?? b.firstAt ?? Infinity) || a.id.localeCompare(b.id))
}

/** 运行中通道的耗时随秒表增长 —— 不烘进 channels，由展示侧按 now 现算。 */
export function elapsedMs(ch: LogChannel, now: number): number | null {
  if (ch.startedAt == null) return null
  return (ch.endedAt ?? now) - ch.startedAt
}

/** 并发流数：运行中通道按专家 role 拆开计数（1 个 swarm 节点 3 专家 = 3 条流）。 */
export function concurrentStreams(channels: LogChannel[]): number {
  return channels
    .filter((c) => c.status === "running")
    .reduce((n, c) => n + Math.max(1, c.roles.length > 1 ? c.roles.length : 1), 0)
}

export type StreamLevel = "all" | "summary" | "problem"
const SUMMARY_HIDDEN: Set<LogKind> = new Set(["out", "beat"])
const PROBLEM_KINDS: Set<LogKind> = new Set(["err", "fail", "warn"])

export interface RowFilter {
  /** 通道 id 或 DAG 节点 id（后者会命中该节点的全部轮次通道） */
  channel?: string | null
  level?: StreamLevel
  query?: string
}

/** 聚焦匹配：DAG 点容器节点（sub_workflow / loop）时，要连带命中它的子通道。 */
function matchChannel(chId: string, focus: string): boolean {
  const node = chId.split("#")[0]
  return chId === focus || node === focus || node.startsWith(`${focus}:`)
}

export function inFocus(r: { chId: string; event: RunEvent }, focus: string): boolean {
  return matchChannel(r.chId, focus)
}

export function channelMatchesFocus(ch: LogChannel, focus: string | null): boolean {
  if (!focus) return false
  return matchChannel(ch.id, focus)
}

export function filterRows(rows: LogRow[], f: RowFilter): LogRow[] {
  const level = f.level ?? "all"
  const q = f.query?.trim().toLowerCase() ?? ""
  if (!f.channel && level === "all" && !q) return rows
  return rows.filter((r) => {
    if (f.channel && !inFocus(r, f.channel)) return false
    if (level === "summary" && SUMMARY_HIDDEN.has(r.kind)) return false
    if (level === "problem" && !PROBLEM_KINDS.has(r.kind)) return false
    if (q) {
      const hay = `${r.text} ${r.detail ?? ""} ${r.role ?? ""}`.toLowerCase()
      if (!hay.includes(q)) return false
    }
    return true
  })
}

/** 尾部截断：只渲染最后 cap 行，更早的按需加载。 */
export function tail<T>(list: T[], cap: number): { hidden: number; shown: T[] } {
  if (list.length <= cap) return { hidden: 0, shown: list }
  return { hidden: list.length - cap, shown: list.slice(list.length - cap) }
}

export function clockOf(at: number, withMs = true): string {
  if (!at) return "--:--:--"
  const d = new Date(at)
  const p = (n: number) => String(n).padStart(2, "0")
  const base = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  return withMs ? `${base}.${String(d.getMilliseconds()).padStart(3, "0")}` : base
}

// 时长文案统一走 lib/format 的 formatDuration（ADR-0017 格式化单源，勿在此另起一份）
