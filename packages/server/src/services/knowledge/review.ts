import path from "path"
import fs from "fs"
import { PendingReviewDAO, type PendingReviewRow } from "../../db/dao"
import {
  appendToKnowledgeFile,
  getKnowledgeDir,
  generateRuleId,
} from "./file-ops"
import { validateKnowledgeFileName } from "./validators"

/**
 * wiki 通道审核执行器（票02 起）：approve 按 item.type 分发——
 * 'wiki-split' → 拆分执行器（hub 目录落地）；
 * 'wiki-edit' / 词条形态的 'rule' → 策展编译通道（票06，WikiCurateService，异步
 * ——compileEntry 是 Promise，本服务因此自票06 起 approve 必须 await）。
 * 由 server index.ts 注入（ReviewService 不依赖 wiki 服务，避免环引用）。
 */
export interface WikiReviewHandlers {
  applyWikiSplit?: (item: PendingReviewRow, org?: string) => void
  applyWikiCurate?: (item: PendingReviewRow, org?: string) => Promise<unknown>
}

/** 票06：rule 条目 target_file 是否 wiki 词条形态（域目录开头）。与 wiki/curate.ts
 *  同一判式，此处独立内联——保持 ReviewService 对 wiki 模块零 import（环引用纪律）。 */
const WIKI_TARGET_PATH_RE = /^(?:projects|workflows|business|research|cases)\//
/** user_preference.md 任何形态的 target 都先进策展闸 fail-closed（写权保护，蓝图双钉）。 */
const USER_PREFERENCE_RE = /(^|[\\/])user_preference\.md$/i

export class ReviewService {
  constructor(
    private pendingReviewDAO: PendingReviewDAO,
    private wikiHandlers?: WikiReviewHandlers,
  ) {}

  /**
   * Approve a pending item: write to knowledge file + insert into knowledge_rules + update status.
   * For skill type items, writes SKILL.md to the org skills directory.
   * For 'wiki-split' items (票02), dispatches to the injected wiki split applier —
   * the legacy append path below must never see a wiki row.
   * 票06: 'wiki-edit' 全量走策展编译通道；词条形态 target 的 'rule' 先过策展闸，
   * 再执行旧 append（P1 影子双轨：注入轨道保持运行，P2 剔除属后续票）。
   *
   * `org` is passed per-request so a single ReviewService instance can
   * serve multiple orgs; an undefined value means "global" scope.
   */
  async approveItem(id: string, org?: string): Promise<{ ok: true; ruleId: string }> {
    const item = this.pendingReviewDAO.getById(id)
    if (!item) throw new Error("NOT_FOUND")
    if (item.status === "approved") return { ok: true, ruleId: id } // idempotent

    if (item.type === "wiki-split") {
      if (!this.wikiHandlers?.applyWikiSplit) {
        throw new Error("NO_WIKI_SPLIT_APPLIER: 服务端未接线 wiki 拆分执行器")
      }
      this.wikiHandlers.applyWikiSplit(item, org)
      this.pendingReviewDAO.updateStatus(id, "approved")
      return { ok: true, ruleId: item.source_ref }
    }

    if (item.type === "wiki-edit") {
      if (!this.wikiHandlers?.applyWikiCurate) {
        throw new Error("NO_WIKI_CURATE_APPLIER: 服务端未接线策展编译通道")
      }
      await this.wikiHandlers.applyWikiCurate(item, org)
      this.pendingReviewDAO.updateStatus(id, "approved")
      return { ok: true, ruleId: item.source_ref }
    }

    // 票06 写闸：wiki 词条形态的 rule 必须先过策展编译通道（lint + 合并 + 带审核引用的
    // git commit）；user_preference.md 形态同样先进闸——策展通道对它拒绝自动改写。
    // 编译被拒 ⇒ 整个 approve 失败、状态留在 pending——单一闸门无旁路。
    // 未接线策展通道的部署（无 wiki 轨道）保持 P1 旧追加行为不变。
    // 注意：此闸在旧文件名校验之前——'user_preference.md' 无域前缀，属旧校验的
    // INVALID_TARGET_FILE 语义，但写权保护必须给专错 CURATE_REFUSED_USER_PREFERENCE。
    const wikiRuleGate = item.type === "rule" && this.wikiHandlers?.applyWikiCurate !== undefined
      && (WIKI_TARGET_PATH_RE.test(item.target_file ?? "") || USER_PREFERENCE_RE.test(item.target_file ?? ""))
    if (wikiRuleGate) {
      await this.wikiHandlers!.applyWikiCurate!(item, org)
    }

    // Guard against a poisoned target_file.
    // pending_review rows are system-generated but flow through LLM JSON,
    // so defense in depth is still warranted.
    const targetFile = item.target_file || "projects/unknown.md"
    const targetCheck = validateKnowledgeFileName(targetFile)
    if (!targetCheck.ok) {
      throw new Error(`INVALID_TARGET_FILE: ${targetCheck.error}`)
    }

    const ruleId = item.status === "pending" || item.status === "deferred"
      ? generateRuleId(targetFile.replace(".md", ""))
      : id
    const knowledgeDir = getKnowledgeDir(org)
    const filePath = path.join(knowledgeDir, targetFile)

    // Ensure subdirectory exists (projects/ or workflows/)
    fs.mkdirSync(path.dirname(filePath), { recursive: true })

    appendToKnowledgeFile(filePath, item.content, ruleId, item.source)
    this.pendingReviewDAO.updateStatus(id, "approved")

    return { ok: true, ruleId }
  }

  rejectItem(id: string, userNotes?: string): { ok: true } {
    const item = this.pendingReviewDAO.getById(id)
    if (!item) throw new Error("NOT_FOUND")
    this.pendingReviewDAO.updateStatus(id, "rejected", userNotes)
    return { ok: true }
  }

  deferItem(id: string): { ok: true } {
    const item = this.pendingReviewDAO.getById(id)
    if (!item) throw new Error("NOT_FOUND")
    this.pendingReviewDAO.updateStatus(id, "deferred")
    return { ok: true }
  }

  editItem(id: string, newContent: string): { ok: true } {
    const item = this.pendingReviewDAO.getById(id)
    if (!item) throw new Error("NOT_FOUND")
    this.pendingReviewDAO.updateContent(id, newContent)
    // Keep status as-is (pending) — editing content doesn't change review state
    return { ok: true }
  }

  async batchApprove(ids: string[], org?: string): Promise<{ succeeded: number; failed: number; details: Array<{ id: string; status: string; error?: string }> }> {
    const details: Array<{ id: string; status: string; error?: string }> = []
    let succeeded = 0
    let failed = 0
    for (const id of ids) {
      try {
        await this.approveItem(id, org)
        details.push({ id, status: "ok" })
        succeeded++
      } catch (err) {
        details.push({ id, status: "error", error: err instanceof Error ? err.message : String(err) })
        failed++
      }
    }
    return { succeeded, failed, details }
  }

  batchReject(ids: string[]): void {
    this.pendingReviewDAO.batchUpdateStatus(ids, "rejected")
  }

  getPendingSummary(): { rules: number; skills: number; wiki: number; total: number } {
    return this.pendingReviewDAO.countPendingByType()
  }

  /**
   * Resolve review strategy based on source and agent config.
   */
  resolveReviewStrategy(source: string, agentConfig?: { review_strategy?: string }): string {
    if (source === "recurring_pitfall") return "auto_approve"
    if (source === "agent_conversation") return "inline"
    if (source === "scheduler") return "background"
    return agentConfig?.review_strategy ?? "auto"
  }
}
