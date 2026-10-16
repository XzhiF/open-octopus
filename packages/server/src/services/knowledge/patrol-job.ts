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
 * - `appendCardsToSession(db, sessionId, …)`（票10 泛化）：同一写入原语的
 *   **目标会话参数化**形态——投喂泛化后卡片回流任意发起会话；知识中心写者
 *   （本模块 reporter / 裁决回执 / 素材包 announcePack）保持判据包装不变。
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
 * 向**任意会话**（按 sessionId 定位）追加一条 assistant 消息：header 文本 +
 * Lane A fenced 卡块（协议单源 @octopus/shared）。票10 泛化投喂的回流原语——
 * 抓取卡/diff 卡落进发起会话走这里；会话不存在/已软删 ⇒ 诚实降级 {posted:false,
 * reason}（不擅自建会话）。
 */
export function appendCardsToSession(
  db: Database.Database,
  sessionId: string,
  header: string,
  events: KcCardEvent[],
  now: () => Date = () => new Date(),
): ReportOutcome {
  const dao = new AgentSessionDAO(db)
  const session = dao.findById(sessionId)
  if (!session || session.is_deleted) {
    return { posted: false, reason: `会话不存在或已删除（${sessionId}），未报对话` }
  }
  const ts = now()
  const content = `${header}\n\n${events.map(serializeKcCardBlock).join("\n\n")}\n`
  dao.insertMessage({
    id: crypto.randomUUID(),
    session_id: sessionId,
    role: "assistant",
    content,
    created_at: ts.toISOString(),
  })
  dao.updateLastMessageAt(sessionId, ts.toISOString())
  return { posted: true, sessionId }
}

/**
 * 向知识中心**主通道**会话（archive 分身、title=知识中心）追加一条
 * assistant 消息：header 文本 + Lane A fenced 卡块（协议单源 @octopus/shared）。
 * ADR-0033：判据由「title ∨ scope_id」收紧为**仅 title**——知识中心抽屉多会话化后，
 * scope 命中面随用户新建会话漂移，机器播报必须永远落唯一主通道（scope_id 仍标会话
 * 语义供 web 历史列表筛选，只是不再作播报落点判据）。
 * 无会话 ⇒ 诚实降级 {posted:false, reason}（不擅自建会话）。
 * 票10 起为 `appendCardsToSession` 的判据包装——夜巡/裁决回执/素材包等既有生产者
 * 零改动，知识中心落点行为逐字保持。
 */
export function appendKnowledgeSessionCards(
  db: Database.Database,
  header: string,
  events: KcCardEvent[],
  now: () => Date = () => new Date(),
): ReportOutcome {
  const session = new AgentSessionDAO(db)
    .findByClone(KNOWLEDGE_CLONE_NAME, { limit: 50 })
    .items.find(s => s.title === KNOWLEDGE_SESSION_TITLE)
  if (!session) {
    return { posted: false, reason: "无知识中心会话（findings 已入库可查，未报对话）" }
  }
  return appendCardsToSession(db, session.id, header, events, now)
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
  /**
   * P3 票04：巡检**产出后**钩子（b 路 skill 草案扫描的触发腿——spec 故事 15「检测在
   * 归档 hook 与巡检两处触发」的巡检侧）。消费本轮 report，返回 void。
   * 失败显形进 outcome 不炸作业（报对话同律）；缺省零行为变化（票13/03 现状）。
   */
  afterPatrol?: (report: PatrolReport) => void | Promise<void>
  /**
   * P4 票06：effectiveness 记账腿（spec 故事 6「夜巡可反复跑」——记账解析器的自动
   * 触发面，与手动端点 POST /api/knowledge/effectiveness/parse 同服务入口）。
   * 失败显形进 outcome 不炸作业（afterPatrol/报对话同款纪律）；缺省零行为变化。
   */
  parseLedger?: () => void | Promise<void>
  /**
   * P4 票07：confidence 快照刷页腿（spec 故事 3「夜巡批量同步页 front-matter」——
   * EffectivenessSyncService.sync 的自动触发面，与手动端点 POST /sync 同入口）。
   * **必须排在 parseLedger 之后**：先记新账再刷快照，同轮夜巡内引用即见账目推进。
   * 失败显形进 outcome 不炸作业（记账/草案扫描同律）；缺省零行为变化。
   */
  syncConfidence?: () => void | Promise<void>
  /**
   * P4 票09：衰减自动退役窄口腿（spec 故事 16「夜巡步骤」）。**必须挂在 parseLedger
   * 之后**——判据吃当夜账（记账未跑则读旧账，窄口误判窗口拉大）；刷页腿之后殿后跑
   * （夜巡链序：账→快照→窄口）。
   * 失败显形进 outcome 不炸作业（记账/草案扫描同律）；缺省零行为变化。
   * 红线2：本腿是全库唯一的自动退役执行面（90天零引用∧零入链∧非人工文件），
   * 其余退役类目一律仍走 finding 人裁——挂载点不扩第二自动口。
   */
  autoRetire?: () => void | Promise<void>
}

/** 夜巡作业 handler：`{summary, metrics}` 进调度器执行史（运维页可见）。 */
export function knowledgePatrolHandlerFor(patrol: WikiPatrolService, opts: PatrolHandlerOpts = {}): CodeJobHandler {
  // 腿公共形（aa-fix 项③：报对话/草案扫描/记账/同步/自动退役五份同构 try/catch+note 合一）。
  // 纪律逐字保真：腿返回 string=成功注记、void=静默；腿抛错=` · <名>失败（msg）` 显形进
  // outcome——文案有测试钉（patrol-job/effectiveness-trigger/auto-retire-trigger 三路）。
  // 任一腿失败不吞前腿成果、不炸作业（findings/账已入库=诚实滞后，下轮夜巡自愈）。
  const runLeg = async (name: string, fn: () => string | void | Promise<string | void>): Promise<string> => {
    try {
      const r = await fn()
      return typeof r === "string" ? r : ""
    } catch (err) {
      return ` · ${name}失败（${err instanceof Error ? err.message : String(err)}）`
    }
  }
  return async (_ctx: CodeJobContext): Promise<CodeJobOutcome> => {
    const report = await patrol.patrol()
    const created = report.newFindings
    let note = ""
    if (opts.report) {
      const rep = opts.report
      note += await runLeg("报对话", () => {
        const r = rep(created, report)
        return r.posted ? " · 已报对话" : created.length > 0 ? ` · 未报对话（${r.reason ?? "无载体"}）` : ""
      })
    }
    if (opts.afterPatrol) {
      const leg = opts.afterPatrol
      note += await runLeg("草案扫描", () => leg(report))
    }
    if (opts.parseLedger) {
      const leg = opts.parseLedger
      note += await runLeg("记账", () => leg())
    }
    if (opts.syncConfidence) {
      const leg = opts.syncConfidence
      note += await runLeg("同步", () => leg())
    }
    if (opts.autoRetire) {
      const leg = opts.autoRetire
      note += await runLeg("自动退役", () => leg())
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
