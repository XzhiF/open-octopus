// packages/web-app/components/tasks/run-console/nodes-model.ts
//
// 票 04 · ◆ 节点页签的纯逻辑层 —— 把「绑定工作流的一次执行」折叠成任务清单：
//   YAML 顶层节点（声明序）× node_executions 行（steps）× 执行级状态（running/
//   paused/cancelled + 壳层 mode=takeover/fixing）→ 每行 {状态符, 类型徽标, 用时,
//   成本}；展开行的事件流做行整形（含 ⚑ 干预行）。
//
// 状态符词表（票 04 / 原型 taskboard-v2.html nodeRow 的期望，逐条钉在测试里）：
//   ✓ done · ● live · ⏸ paused · ○ 未执行 · ⏹ 终止（abort/takeover 推导，绝不留
//   误导性的 ●）· ✗ failed · ⊘ skipped（审批打回下游，原型 5 符之外的如实补位）。
//
// 数据真相：steps 来自 GET /api/workspaces/:ws/executions/:eid（execution.ts 把
// node_executions 映射成 StepExecution[]，duration 单位=秒、costUsd 三态）；loop
// 等容器只有分形行（"loop-a:inner-iter0"/"dev-iter1"）时按执行流程图既有口径
// 聚合回容器行（running > failed > last-completed）。
//
// ⚑ 行来源：harness_directive（既有 harness 干预数据 —— 无票 06 时的验证源）与
// 06 注入干预的落库形状（GET agent-events 一等 intervention / 顶层 intervention_result，
// 路由直通；旧代 harness_directive 与 engine agent_event 包装并存）。

import type { AgentEvent, StepExecution } from "@/lib/types"
import { formatCost, formatDuration } from "@/lib/format"
import { parseYaml } from "@/lib/yaml-utils"
import type { ConsoleShellMode } from "./tab-assembly"

// ── 节点定义（YAML 顶层）──────────────────────────────────────────────

export interface WorkflowNodeDef {
  id: string
  /** 清单行显示名：YAML name 优先，缺失回落 id。 */
  name: string
  type: string
}

export function extractNodeDefs(yamlContent: string | null | undefined): WorkflowNodeDef[] {
  if (!yamlContent) return []
  const parsed = parseYaml(yamlContent)
  const nodes = parsed?.nodes
  if (!Array.isArray(nodes)) return []
  const defs: WorkflowNodeDef[] = []
  for (const n of nodes) {
    if (!n || typeof n !== "object") continue
    const id = (n as Record<string, unknown>).id
    const type = (n as Record<string, unknown>).type
    if (typeof id !== "string" || typeof type !== "string") continue
    const name = (n as Record<string, unknown>).name
    defs.push({ id, name: typeof name === "string" && name ? name : id, type })
  }
  return defs
}

// ── 行模型 ────────────────────────────────────────────────────────────

export type NodeDisplayState = "done" | "fail" | "live" | "paused" | "stop" | "pend" | "skip"

export const NODE_GLYPH: Record<NodeDisplayState, string> = {
  done: "✓", fail: "✗", live: "●", paused: "⏸", stop: "⏹", pend: "○", skip: "⊘",
}

export interface NodeRow {
  id: string
  name: string
  type: string
  typeBadge: string
  state: NodeDisplayState
  glyph: string
  durationText: string
  costText: string
  /** 当前节点高亮位（= live）。 */
  isCurrent: boolean
  /** ⏹ 中被掐断的现场节点（粉 ⏹ + 「已终止」标），其余停机行是灰 ⏹。 */
  stopLive: boolean
  step?: StepExecution
}

export interface BuildNodeRowsInput {
  defs: WorkflowNodeDef[]
  steps: StepExecution[]
  /** 执行行状态（executions.status），如 running/paused/cancelled/completed。 */
  execStatus: string
  /** 壳形态（takeover 由 08 点亮；fixing 不靠它 —— 用 workflow_ref 自判）。 */
  mode: ConsoleShellMode
  now: number
}

/** 执行级「停机」：abort/takeover/审批整体打回后工作流不会再推进到未执行节点。 */
export function isStoppedExec(execStatus: string, mode: ConsoleShellMode): boolean {
  return mode === "takeover" || execStatus === "cancelled" || execStatus === "aborted" || execStatus === "rejected"
}

/** 修复轮判定 —— 05 落地契约：修复轮执行行 workflow_ref === 'built-in/task-fix'。 */
export function isFixingWorkflow(workflowRef: string | null | undefined): boolean {
  return typeof workflowRef === "string" && workflowRef.endsWith("task-fix")
}

/** 聚合优先级：running > paused/等人 > failed > cancelled > completed > skipped > pending。
 *  与执行流程图（workflow-flow-viewer-with-status 的 stepMap 折叠）同口径。 */
const STEP_PRIORITY: Record<string, number> = {
  running: 8, paused: 7, pending_approval: 7, pending_interaction: 7,
  failed: 6, rejected: 6, cancelled: 5, completed: 4, skipped: 2, pending: 1,
}

function baseStepId(stepId: string): string {
  const scoped = stepId.indexOf(":")
  const head = scoped >= 0 ? stepId.slice(0, scoped) : stepId
  return head.replace(/-iter\d+$/, "")
}

function foldSteps(steps: StepExecution[]): Map<string, StepExecution> {
  const map = new Map<string, StepExecution>()
  for (const s of steps) {
    if (!s?.stepId) continue
    const base = baseStepId(s.stepId)
    const prev = map.get(base)
    if (!prev) { map.set(base, s); continue }
    const p = STEP_PRIORITY[s.status] ?? 0
    const q = STEP_PRIORITY[prev.status] ?? 0
    // 高档态保住（running/failed 不被 completed 覆盖）；同档取后见（最新迭代口径）。
    if (p >= q) map.set(base, s)
  }
  return map
}

const TYPE_BADGES: Record<string, string> = {
  agent: "Agent", octopus_agent: "Agent", bash: "Bash", python: "Python",
  loop: "Loop", swarm: "Swarm", approval: "Approval", condition: "Condition",
  interaction: "Interaction", sub_workflow: "Sub", dynamic_sub_workflow: "Sub",
}

export function typeBadgeOf(nodeType: string | null | undefined): string {
  return (nodeType && TYPE_BADGES[nodeType]) || (nodeType ? nodeType : "?")
}

function displayState(stepStatus: string | null, execStatus: string, mode: ConsoleShellMode): NodeDisplayState {
  const stopped = isStoppedExec(execStatus, mode)
  const paused = execStatus === "paused"
  if (stepStatus == null) return stopped ? "stop" : "pend"
  switch (stepStatus) {
    case "completed": return "done"
    case "failed": case "rejected": return "fail"
    case "skipped": return "skip"
    case "cancelled": return "stop"
    case "paused": case "pending_approval": case "pending_interaction": return "paused"
    case "running": return stopped ? "stop" : paused ? "paused" : "live"
    default: return stopped ? "stop" : "pend" // pending 行（DB 预置）与未知态
  }
}

function durationTextOf(state: NodeDisplayState, s: StepExecution | null, now: number): string {
  if (state === "pend" || state === "skip") return "—"
  if (state === "done" || state === "fail") {
    if (s?.duration != null && s.duration > 0) return formatDuration(s.duration * 1000)
    if (s?.startedAt && s?.completedAt) {
      const a = Date.parse(s.startedAt), b = Date.parse(s.completedAt)
      if (!Number.isNaN(a) && !Number.isNaN(b) && b > a) return formatDuration(b - a)
    }
    return "—"
  }
  // live / paused / stop(现场) —— 从节点起步走到现在（stop 若有 completedAt 则定格）
  const start = s?.startedAt ? Date.parse(s.startedAt) : NaN
  if (Number.isNaN(start)) return "—"
  const end = state === "stop" && s?.completedAt ? Date.parse(s.completedAt) : now
  return `⏱ ${formatDuration(Math.max(0, end - start))}`
}

export function buildNodeRows(input: BuildNodeRowsInput): NodeRow[] {
  const { defs, steps, execStatus, mode, now } = input
  const folded = foldSteps(steps)

  // defs 缺失（workflow_content 读不到）时兜底：按 steps 出已执行的行。
  const sources: WorkflowNodeDef[] = defs.length > 0
    ? defs
    : [...folded.keys()].map((id) => ({
        id, name: id,
        type: (folded.get(id)?.nodeType ?? "agent") as string,
      }))

  return sources.map((d) => {
    const s = folded.get(d.id) ?? null
    const stopLive = isStoppedExec(execStatus, mode) && s?.status === "running"
    const state = displayState(s?.status ?? null, execStatus, mode)
    return {
      id: d.id,
      name: d.name,
      type: d.type,
      typeBadge: typeBadgeOf(d.type),
      state,
      glyph: NODE_GLYPH[state],
      durationText: durationTextOf(state, s, now),
      costText: s ? formatCost(s.costUsd, s.costComplete ?? true) : "—",
      isCurrent: state === "live",
      stopLive,
      step: s ?? undefined,
    }
  })
}

export function nodeSummary(rows: NodeRow[]): { done: number; total: number } {
  return { done: rows.filter((r) => r.state === "done").length, total: rows.length }
}

// ── 票 07 · ready 静态预览 ────────────────────────────────────────────
//
// 待执行且该 phase 尚无 execution 时，◆ 节点页签不再是「无节点」空态，而是
// **绑定流 YAML 顶层节点的声明序清单**（原型 ⓬ readyNodesHtml）：全 ○ 未执行、
// 用时/成本 `—`、展开一行给「未执行 · 等待触发」占位。有 execution 后走
// buildNodeRows 动态模型（判据 = 该 phase 是否有执行行，在调用方）。
// 状态符词表对齐票 04：○ = NODE_GLYPH.pend，不另造符号。

/** 绑定流 YAML 原文 → ○ 静态行清单（声明序）。content 读不到/坏 YAML/无 nodes
 *  → []（调用方落「未绑定 / 读取失败」降级话术，绝不编造清单）。 */
export function assembleStaticNodePreview(yamlContent: string | null | undefined): NodeRow[] {
  return extractNodeDefs(yamlContent).map((d) => ({
    id: d.id,
    name: d.name,
    type: d.type,
    typeBadge: typeBadgeOf(d.type),
    state: "pend" as const,
    glyph: NODE_GLYPH.pend,
    durationText: "—",
    costText: "—",
    isCurrent: false,
    stopLive: false,
  }))
}

// ── 头部状态播报（原型 nodesHtml 的 stTxt：takeover/fixing/paused + 终止补位）──

export interface ExecStateLine { tone: "pink" | "cyan" | "amber" | "red"; text: string }

export function execStateLine(input: { execStatus: string; mode: ConsoleShellMode; workflowRef: string | null | undefined }): ExecStateLine | null {
  const { execStatus, mode, workflowRef } = input
  if (mode === "takeover") return { tone: "pink", text: "工作流已停 · 人工接管中" }
  if (execStatus === "paused") return { tone: "amber", text: "已暂停，等待干预" }
  if (isStoppedExec(execStatus, mode)) return { tone: "red", text: "绑定执行已终止" }
  if (isFixingWorkflow(workflowRef)) return { tone: "cyan", text: "task-fix 推进中" }
  return null
}

// ── 展开行：事件流整形 ────────────────────────────────────────────────

export interface NodeEventLine {
  glyph: string
  tone: "ink" | "dim" | "green" | "red" | "pink" | "amber"
  text: string
  /** ⚑ 干预行标记（样式与 AC 断言都用它）。 */
  intervention?: boolean
  detail?: string
}

function briefInput(input: unknown): string {
  if (input == null) return ""
  if (typeof input === "string") return input.split("\n")[0].slice(0, 80)
  if (typeof input === "object") {
    const o = input as Record<string, unknown>
    for (const k of ["command", "description", "file_path", "path", "pattern", "prompt"]) {
      const v = o[k]
      if (typeof v === "string" && v) return v.split("\n")[0].slice(0, 80)
    }
    try { return JSON.stringify(input).slice(0, 80) } catch { return "" }
  }
  return String(input).slice(0, 80)
}

function firstLine(text: string | string[] | undefined | null): string {
  if (Array.isArray(text)) return (text[0] ?? "").slice(0, 120)
  return (text ?? "").split("\n").filter(Boolean)[0]?.slice(0, 120) ?? ""
}

const END_LABEL: Record<string, { glyph: string; tone: NodeEventLine["tone"]; word: string }> = {
  completed: { glyph: "✓", tone: "green", word: "完成" },
  success: { glyph: "✓", tone: "green", word: "完成" },
  failed: { glyph: "✗", tone: "red", word: "失败" },
  cancelled: { glyph: "⏹", tone: "dim", word: "终止" },
  skipped: { glyph: "⊘", tone: "dim", word: "跳过" },
}

/** 单事件 → 展示行（null = 噪声，不占行）。 */
function lineForEvent(e: AgentEvent): NodeEventLine | null {
  const type = e.event
  switch (type) {
    case "start":
      return { glyph: "·", tone: "dim", text: "节点开始" }
    case "end": {
      const info = END_LABEL[e.status ?? "completed"] ?? { glyph: "·", tone: "dim" as const, word: e.status ?? "结束" }
      const dur = e.durationMs ? ` · ${formatDuration(e.durationMs)}` : ""
      return { glyph: info.glyph, tone: info.tone, text: `节点${info.word}${dur}` }
    }
    case "text_block":
      return e.content?.trim() ? { glyph: "▸", tone: "ink", text: firstLine(e.content) } : null
    case "thinking_block":
      return e.content?.trim() ? { glyph: "◦", tone: "dim", text: firstLine(e.content) } : null
    case "tool_call":
      return {
        glyph: e.isError ? "✗" : "⚙",
        tone: e.isError ? "red" : "dim",
        text: `${e.toolName ?? "tool"} ${briefInput(e.input)}`.trim(),
        detail: e.result ? firstLine(e.result) : undefined,
      }
    case "bash_output": case "python_output":
      return { glyph: "$", tone: "dim", text: firstLine(e.content ?? e.lines) }
    case "bash_log": case "python_log": case "node_log":
      return e.line?.trim() ? { glyph: "·", tone: "dim", text: firstLine(e.line) } : null
    case "approval_metadata": {
      const a = e as AgentEvent & { prompt?: string; decision?: string }
      return { glyph: "▣", tone: "amber", text: `审批：${a.prompt ?? ""}${a.decision ? ` → ${a.decision}` : "（等待放行）"}` }
    }
    case "harness_directive": {
      const d = (e.data ?? {}) as Record<string, unknown>
      const text = [d.directive, d.action, d.reason, e.content].map((v) => (typeof v === "string" ? v : "")).find(Boolean) ?? ""
      return { glyph: "⚑", tone: "pink", text: `harness 干预：${text}`.trim(), intervention: true }
    }
    case "intervention": {
      // 票 06 定稿形状：GET agent-events 一等事件（data={nodeId,nodeName,prompt}，
      // 行源 = ExecutionLifecycle.resume 留痕）—— 与下方 agent_event 包装的旧代并存。
      const d = (e.data ?? {}) as Record<string, unknown>
      const prompt = typeof d.prompt === "string" ? d.prompt : ""
      if (!prompt.trim()) return null
      const nodeName = (typeof d.nodeName === "string" && d.nodeName) || (typeof d.nodeId === "string" && d.nodeId) || e.nodeId
      return { glyph: "⚑", tone: "pink", text: `人工干预 → 节点「${nodeName}」：${firstLine(prompt)}`, intervention: true }
    }
    case "intervention_result": {
      const d = (e.data ?? {}) as Record<string, unknown>
      return { glyph: "⚑", tone: "pink", text: `干预结果：${typeof d.result === "string" ? d.result : ""}`, intervention: true }
    }
    case "heartbeat": case "heartbeat_stall":
      return null
    case "agent_event": {
      const inner = e.event_data as { type: string; content?: string; message?: string } | undefined
      if (!inner?.type) return null
      if (inner.type === "intervention")
        return { glyph: "⚑", tone: "pink", text: `人工干预：${firstLine(inner.content)}`, intervention: true }
      if (inner.type === "intervention_result")
        return { glyph: "⚑", tone: "pink", text: `干预结果：${firstLine(inner.content)}`, intervention: true }
      if (inner.type === "error")
        return { glyph: "✗", tone: "red", text: firstLine(inner.message ?? inner.content) }
      if (inner.type === "thinking" || inner.type === "text_delta")
        return inner.content?.trim() ? { glyph: "▸", tone: "dim", text: firstLine(inner.content) } : null
      return null // status / tool_start / tool_input / tool_result 等碎片：合并形已给出
    }
    default:
      return null
  }
}

/** 节点归属：本体 / 作用域子行（loop-a:inner）/ 迭代后缀行（loop-a-iter1）。 */
export function filterEventsForNode(events: AgentEvent[], nodeId: string): AgentEvent[] {
  return events.filter((e) => {
    const nid = e.nodeId
    if (!nid) return false
    return nid === nodeId || nid.startsWith(`${nodeId}:`) || nid.startsWith(`${nodeId}-iter`)
  })
}

/** 单事件 → 展示行的公开出口（票 11：「▶ 日志」页签复用同一分类词表 ——
 *  工具⚙/✗ · 编辑 · 成败✓/✗ · 警告 · ⚑ pink 干预，噪声 null 不占行）。 */
export function eventLineFor(e: AgentEvent): NodeEventLine | null {
  return lineForEvent(e)
}

export function buildEventLines(events: AgentEvent[], limit = 40): NodeEventLine[] {
  const lines = events.map(lineForEvent).filter((l): l is NodeEventLine => l !== null)
  return lines.slice(-limit)
}
