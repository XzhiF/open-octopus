// packages/web-app/components/tasks/run-console/intervention.ts
//
// 票 06 · 干预接线（⏸ → 注入 → 恢复）的纯逻辑单源 —— 弹框状态机、⚑ 行抽取、
// LIVE 卡计数口径。DOM/网络零依赖，TaskRunConsole 与注入弹框是唯一消费者。
//
// 数据面（真相源 = 服务端，两枚契约测试各钉一头）：
//   resume(intervention) 由 ExecutionLifecycle 落 agent_events event_type='intervention'
//   （ExecutionLifecycle.resume 留痕），GET agent-events 把它映射成
//   {event:"intervention", nodeId, data:{nodeId,nodeName,prompt}, timestamp}
//   （agent-events-intervention.test.ts）。本模块把这条流榨成 ⚑ 行。
//   「agent 后续行为读取到注入内容」仍由引擎路径 B 保证（intervention.jsonl +
//   原会话续跑），UI 只呈现留痕，不重算。

import type { AgentEvent } from "@/lib/types"

/** 服务端契约：resume body {intervention} ≤4000（routes/tasks.ts 400 同额）。 */
export const INTERVENTION_MAX = 4000

export interface InterventionRow {
  /** 引擎节点 id（agent_events 归属键）。 */
  nodeId: string
  /** 展示名 —— YAML 无 name 时服务端兜底为 id。 */
  nodeName: string
  /** 干预原文（逐字）。 */
  text: string
  /** ISO 时间戳（event 行的 timestamp 字段）。 */
  at: string
}

/**
 * GET agent-events 的事件流 → ⚑ 行（时间序保持服务端排序，不重洗）。
 * 容错：data 缺失/原文空白的行是噪声，跳过 —— 「没事不显示」。
 */
export function extractInterventions(events: readonly AgentEvent[]): InterventionRow[] {
  const rows: InterventionRow[] = []
  for (const e of events) {
    if (e.event !== "intervention") continue
    const data = e.data as Record<string, unknown> | undefined
    const prompt = typeof data?.prompt === "string" ? data.prompt : ""
    if (!prompt.trim()) continue
    const nodeId = (typeof data?.nodeId === "string" && data.nodeId) || e.nodeId || ""
    const nodeName = (typeof data?.nodeName === "string" && data.nodeName) || nodeId
    rows.push({ nodeId, nodeName, text: prompt, at: e.timestamp ?? "" })
  }
  return rows
}

/** ⚑ 行文案（原型 taskboard-v2.html 逐字：⚑ 人工干预 → 节点「…」：…）。 */
export function interventionLineText(row: InterventionRow): string {
  return `⚑ 人工干预 → 节点「${row.nodeName}」：${row.text}`
}

// ── 恢复弹框三分支状态机 ─────────────────────────────────────────────
// 原型的 openInject/resume(withInj)：三键恰好三种结局，且没有第四种。
// 取消（保持暂停）= 纯前端关窗，一次 API 都不打；直接继续 = 不带干预的 resume；
// 注入并继续 = 带 trim 后原文的 resume；空文本按原样继续并给提示（不拦）。

export type ResumeDialogAction = "cancel" | "plain" | "inject"

export interface ResumeDecision {
  /** close = 只关窗（取消）；resume = 关窗并打 POST /:id/resume。 */
  kind: "close" | "resume"
  /** 携带的干预原文；undefined = 不注入（直接继续 / 空文本退化为直接继续）。 */
  intervention?: string
  /** 空文本点「注入」的提示文案（组件层 toast warning）。 */
  notice?: string
}

export function decideResume(action: ResumeDialogAction, text: string): ResumeDecision {
  if (action === "cancel") return { kind: "close" }
  if (action === "plain") return { kind: "resume" }
  const trimmed = text.trim()
  if (!trimmed) return { kind: "resume", notice: "没写干预内容 — 按原样继续" }
  return { kind: "resume", intervention: trimmed }
}

/** 超服务端上限：弹框给出警示并禁「注入」（POST 会 400，与其等 400 不如先说清）。 */
export function isOverLimit(text: string): boolean {
  return text.length > INTERVENTION_MAX
}

// ── LIVE 卡 ⚑ 干预×N 口径 ───────────────────────────────────────────
// US16（spec v2，票10 review-7 定版）：LIVE 卡的 ×N = **当前节点**的累计。
// 「当前节点」由调用方传入（= 事件流尾部节点 —— 引擎此刻在往哪个节点吐事件）；
// 执行推进到一个没挨过干预的新节点 → 计数归 0（卡片 >0 才挂 chip，即 0/不显示），
// 不再像旧口径那样黏在「最近一次干预的目标节点」上。
// currentNodeId 省略 = 调用方没有节点现场知识 → 兜底旧口径（最近干预的目标节点）。
// total 供日志区标题（全程累计），与卡片口径正交。

export interface InterventionStats {
  total: number
  currentNodeName: string | null
  currentNodeCount: number
}

export function interventionStats(
  rows: readonly InterventionRow[],
  currentNodeId?: string | null,
): InterventionStats {
  if (rows.length === 0) return { total: 0, currentNodeName: null, currentNodeCount: 0 }
  if (currentNodeId === undefined) {
    const latest = rows[rows.length - 1]
    const same = rows.filter((r) => r.nodeId === latest.nodeId).length
    return { total: rows.length, currentNodeName: latest.nodeName, currentNodeCount: same }
  }
  if (!currentNodeId) return { total: rows.length, currentNodeName: null, currentNodeCount: 0 }
  const mine = rows.filter((r) => r.nodeId === currentNodeId)
  return {
    total: rows.length,
    currentNodeName: mine.length > 0 ? mine[mine.length - 1].nodeName : null,
    currentNodeCount: mine.length,
  }
}
