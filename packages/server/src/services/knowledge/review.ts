import path from "path"
import fs from "fs"
import { KnowledgeRuleDAO, PendingReviewDAO } from "../../db/dao"
import {
  appendToKnowledgeFile,
  getKnowledgeDir,
  generateRuleId,
} from "./file-ops"

export class ReviewService {
  constructor(
    private knowledgeRuleDAO: KnowledgeRuleDAO,
    private pendingReviewDAO: PendingReviewDAO,
    private org: string,
  ) {}

  /**
   * Approve a pending item: write to knowledge file + insert into knowledge_rules + update status.
   * For skill type items, writes SKILL.md to the org skills directory.
   */
  approveItem(id: string): { ok: true; ruleId: string } {
    const item = this.pendingReviewDAO.getById(id)
    if (!item) throw new Error("NOT_FOUND")
    if (item.status === "approved") return { ok: true, ruleId: id } // idempotent

    // Handle skill type separately
    if (item.type === "skill") {
      const skillName = (item.target_file ?? "").replace("skills/", "").replace("/SKILL.md", "") || "unknown-skill"
      const skillsDir = path.join(getKnowledgeDir(this.org), "..", "skills", skillName)
      fs.mkdirSync(skillsDir, { recursive: true })
      fs.writeFileSync(path.join(skillsDir, "SKILL.md"), item.content, "utf-8")
      this.pendingReviewDAO.updateStatus(id, "approved")
      return { ok: true, ruleId: id }
    }

    const ruleId = item.status === "pending" || item.status === "deferred"
      ? generateRuleId(item.target_file.replace(".md", ""))
      : id
    const knowledgeDir = getKnowledgeDir(this.org)
    const filePath = path.join(knowledgeDir, item.target_file || "octopus.md")

    appendToKnowledgeFile(filePath, item.content, ruleId, item.source)
    this.knowledgeRuleDAO.insert({
      rule_id: ruleId,
      file_name: item.target_file || "octopus.md",
      text: item.content,
      scope: item.scope,
      source: item.source,
      status: "active",
    })
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
    this.pendingReviewDAO.updateStatus(id, "edited")
    return { ok: true }
  }

  batchApprove(ids: string[]): { succeeded: number; failed: number; details: Array<{ id: string; status: string; error?: string }> } {
    const details: Array<{ id: string; status: string; error?: string }> = []
    let succeeded = 0
    let failed = 0
    for (const id of ids) {
      try {
        this.approveItem(id)
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

  getPendingSummary(): { rules: number; skills: number } {
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
