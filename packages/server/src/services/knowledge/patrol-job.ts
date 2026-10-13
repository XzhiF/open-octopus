import crypto from "crypto"
import type Database from "better-sqlite3"
import type { KcCardEvent, KcFindingCardData } from "@octopus/shared"
import { serializeKcCardBlock } from "@octopus/shared"
import type { FindingUpsert } from "../../db/dao/findings-dao"
import { AgentSessionDAO } from "../../db/dao/agent-session-dao"
import type { CodeJobContext, CodeJobHandler, CodeJobOutcome } from "../scheduler/code-job-registry"
import type { PatrolReport, WikiPatrolService } from "./patrol"

/**
 * 夜巡作业接线（知识中心票13 触发路①，spec 故事 42）——scheduler 系统作业先例的
 * 知识域 handler + 「findings 报对话」的 Lane A 落点。
 *
 * 形态（对齐 task-lifecycle 双件先例）：
 * - `knowledgePatrolHandlerFor(patrol, opts)`：包 `WikiPatrolService.patrol()` 的
 *   CodeJobHandler（taskLifecycleHandlerFor 同款薄包），作业执行经服务层可测
 *   （不起 HTTP server、不起调度泵）。
 * - `createKnowledgeSessionReporter(db)`：把本轮**新建** finding 序列化成
 *   `finding` 卡（Lane A fenced 块，协议单源 = @octopus/shared card-protocol），
 *   作为 assistant 消息追加进知识中心会话（archive 分身、title=知识中心 ∨
 *   scope_id=knowledge 的行——与 web chat-column 会话选择同判据）。
 *   无会话 ⇒ 诚实降级（findings 仍入库可查，outcome 注明「未报对话」；
 *   不擅自建会话——那是前端进入 /knowledge 时的通道建立面）。
 *
 * 打扰纪律：只报 created（新证据），refreshed/unchanged/suppressed 零消息
 * （幂等夜巡不刷对话流）。
 */

export const KNOWLEDGE_CLONE_NAME = "archive"
export const KNOWLEDGE_SESSION_TITLE = "知识中心"
export const KNOWLEDGE_SESSION_SCOPE_ID = "knowledge"

/** finding 行 → 卡片 data（服务侧投影；web 端从 API view 建同形是契约另一端）。 */
export function findingCardData(row: FindingUpsert): KcFindingCardData {
  let claims: KcFindingCardData["claims"]
  try {
    const detail = JSON.parse(row.detail) as Record<string, unknown>
    if (typeof detail.old_claim === "string" && typeof detail.new_claim === "string") {
      claims = { old: detail.old_claim, new: detail.new_claim }
    }
  } catch {
    // detail 坏形 ⇒ 无 claims，卡仍可读
  }
  let pages: string[] = []
  try {
    pages = JSON.parse(row.pages) as string[]
  } catch {
    pages = []
  }
  return {
    findingId: row.id,
    kind: row.kind,
    title: row.title,
    ...(claims ? { claims } : {}),
    pages,
    rawRef: row.raw_ref,
    source: row.source,
    status: "open",
  }
}

export interface ReportOutcome {
  posted: boolean
  sessionId?: string
  reason?: string
}

/**
 * 向知识中心会话（archive 分身、title=知识中心 ∨ scope_id=knowledge）追加一条
 * assistant 消息：header 文本 + Lane A fenced 卡块（协议单源 @octopus/shared）。
 * 无会话 ⇒ 诚实降级 {posted:false, reason}（不擅自建会话）。
 */
export function appendKnowledgeSessionCards(
  db: Database.Database,
  header: string,
  events: KcCardEvent[],
  now: () => Date = () => new Date(),
): ReportOutcome {
  const dao = new AgentSessionDAO(db)
  const session = dao
    .findByClone(KNOWLEDGE_CLONE_NAME, { limit: 50 })
    .items.find(s => s.title === KNOWLEDGE_SESSION_TITLE || s.scope_id === KNOWLEDGE_SESSION_SCOPE_ID)
  if (!session) {
    return { posted: false, reason: "无知识中心会话（findings 已入库可查，未报对话）" }
  }
  const ts = now()
  const content = `${header}\n\n${events.map(serializeKcCardBlock).join("\n\n")}\n`
  dao.insertMessage({
    id: crypto.randomUUID(),
    session_id: session.id,
    role: "assistant",
    content,
    created_at: ts.toISOString(),
  })
  dao.updateLastMessageAt(session.id, ts.toISOString())
  return { posted: true, sessionId: session.id }
}

export type PatrolReporter = (newFindings: FindingUpsert[], report: PatrolReport) => ReportOutcome

export function createKnowledgeSessionReporter(
  db: Database.Database,
  opts?: { now?: () => Date },
): PatrolReporter {
  const now = opts?.now ?? (() => new Date())
  return (newFindings, report) => {
    if (newFindings.length === 0) return { posted: false, reason: "无新建 finding，不打扰对话" }
    const date = now().toISOString().slice(0, 10)
    const events: KcCardEvent[] = newFindings.map(row => ({
      id: row.id, // 卡 id = finding id（协议 id 约定 fnd-<findingId>）
      kind: "finding",
      ts: now().toISOString(),
      data: findingCardData(row),
    }))
    const header = `🩺 夜巡体检报告 ${date} · 扫 ${report.scanned.pages} 页 / ${report.scanned.executions} 执行 · 新发现 ${newFindings.length} 条（对话内可逐条裁决）：`
    return appendKnowledgeSessionCards(db, header, events, now)
  }
}

export interface PatrolHandlerOpts {
  report?: PatrolReporter
  /** 测试钉时钟（报告日期/消息时间戳） */
  now?: () => Date
}

/** 夜巡作业 handler：`{summary, metrics}` 进调度器执行史（运维页可见）。 */
export function knowledgePatrolHandlerFor(patrol: WikiPatrolService, opts: PatrolHandlerOpts = {}): CodeJobHandler {
  return async (_ctx: CodeJobContext): Promise<CodeJobOutcome> => {
    const report = patrol.patrol()
    const created = report.newFindings
    let note = ""
    if (opts.report) {
      try {
        const r = opts.report(created, report)
        note = r.posted ? " · 已报对话" : created.length > 0 ? ` · 未报对话（${r.reason ?? "无载体"}）` : ""
      } catch (err) {
        // 报对话失败不吞巡检成果：findings 已在库，失败显形进 outcome
        note = ` · 报对话失败（${err instanceof Error ? err.message : String(err)}）`
      }
    }
    return {
      summary: `夜巡体检：扫 ${report.scanned.pages} 页/${report.scanned.executions} 执行 · 新建 ${created.length} · 在库 open ${report.findings.filter(f => f.action !== "suppressed").length}${note}`,
      metrics: {
        pages: report.scanned.pages,
        executions: report.scanned.executions,
        findings: report.findings.length,
        newFindings: created.length,
        warnings: report.warnings.length,
      },
    }
  }
}
