import path from "path"
import fs from "fs"
import { PendingReviewDAO } from "../../db/dao"
import {
  appendToKnowledgeFile,
  getKnowledgeDir,
  generateRuleId,
} from "./file-ops"
import { validateKnowledgeFileName } from "./validators"

export class ReviewService {
  constructor(
    private pendingReviewDAO: PendingReviewDAO,
  ) {}

  /**
   * Approve a pending item: write to knowledge file + insert into knowledge_rules + update status.
   * For skill type items, writes SKILL.md to the org skills directory.
   *
   * `org` is passed per-request so a single ReviewService instance can
   * serve multiple orgs; an undefined value means "global" scope.
   */
  approveItem(id: string, org?: string): { ok: true; ruleId: string } {
    const item = this.pendingReviewDAO.getById(id)
    if (!item) throw new Error("NOT_FOUND")
    if (item.status === "approved") return { ok: true, ruleId: id } // idempotent

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

  batchApprove(ids: string[], org?: string): { succeeded: number; failed: number; details: Array<{ id: string; status: string; error?: string }> } {
    const details: Array<{ id: string; status: string; error?: string }> = []
    let succeeded = 0
    let failed = 0
    for (const id of ids) {
      try {
        this.approveItem(id, org)
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

  getPendingSummary(): { rules: number } {
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
