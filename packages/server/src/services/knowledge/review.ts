import path from "path"
import fs from "fs"
import { KnowledgeRuleDAO, PendingReviewDAO } from "../../db/dao"
import {
  appendToKnowledgeFile,
  getKnowledgeDir,
  generateRuleId,
} from "./file-ops"
import { validateKnowledgeFileName } from "./validators"

/**
 * Strict validation for skill folder names. The value is derived from
 * `target_file` (LLM-generated JSON in the pending_review row) so we must
 * reject anything that could escape the skills directory via path
 * traversal, even though an admin approval gate sits in front of this.
 *
 * Allowed: letters, digits, underscore, hyphen; 1..64 chars.
 */
const SKILL_NAME_REGEX = /^[a-z0-9_-]{1,64}$/i

function assertValidSkillName(name: string): void {
  if (!SKILL_NAME_REGEX.test(name)) {
    throw new Error(`INVALID_SKILL_NAME: ${JSON.stringify(name)}`)
  }
}

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
      // Extract the skill folder name from target_file (typically
      // "skills/<name>/SKILL.md") but validate the result before any
      // path operations. An LLM that returns a traversal payload in
      // target_file would otherwise be written to disk.
      const rawName = (item.target_file ?? "")
        .replace(/^skills\//, "")
        .replace(/\/SKILL\.md$/, "") || "unknown-skill"
      assertValidSkillName(rawName)

      const skillsDir = path.join(getKnowledgeDir(this.org), "..", "skills", rawName)
      fs.mkdirSync(skillsDir, { recursive: true })
      fs.writeFileSync(path.join(skillsDir, "SKILL.md"), item.content, "utf-8")
      this.pendingReviewDAO.updateStatus(id, "approved")
      return { ok: true, ruleId: id }
    }

    // Non-skill path: also guard against a poisoned target_file.
    // pending_review rows are system-generated but flow through LLM JSON,
    // so defense in depth is still warranted.
    const targetFile = item.target_file || "octopus.md"
    const targetCheck = validateKnowledgeFileName(targetFile)
    if (!targetCheck.ok) {
      throw new Error(`INVALID_TARGET_FILE: ${targetCheck.error}`)
    }

    const ruleId = item.status === "pending" || item.status === "deferred"
      ? generateRuleId(targetFile.replace(".md", ""))
      : id
    const knowledgeDir = getKnowledgeDir(this.org)
    const filePath = path.join(knowledgeDir, targetFile)

    appendToKnowledgeFile(filePath, item.content, ruleId, item.source)
    this.knowledgeRuleDAO.insert({
      rule_id: ruleId,
      file_name: targetFile,
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
