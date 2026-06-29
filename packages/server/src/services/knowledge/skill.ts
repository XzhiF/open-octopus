import fs from "fs"
import path from "path"
import crypto from "crypto"
import type { PendingReviewDAO } from "../../db/dao"
import type { ProposedSkill, PendingSource } from "@octopus/shared"
import { getKnowledgeDir } from "./file-ops"

// ---------------------------------------------------------------------------
// LLM wrapper (same pattern as extract.ts — placeholder until providers
// exposes a simple completion API)
// ---------------------------------------------------------------------------

async function callHaiku(_prompt: string): Promise<string> {
  // TODO: wire up real LLM call once providers exposes a simple completion API.
  // Example future implementation:
  //   const { complete } = await import("@octopus/providers")
  //   const result = await complete({ model: "claude-haiku-4-5-20251001", prompt })
  //   return result.text ?? ""
  console.warn("[knowledge] callHaiku is a placeholder — returning empty string")
  return ""
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateSkillId(): string {
  return `skill-${crypto.randomBytes(4).toString("base64url").slice(0, 8)}`
}

// ---------------------------------------------------------------------------
// P4.3 — Skill proposal from workspace execution results
// ---------------------------------------------------------------------------

/**
 * Propose a skill from workspace execution results.
 *
 * Analyzes workspace state (PRD, plan, PR, outputs) via a single Haiku call.
 * If the LLM determines a skill would be valuable, it returns a ProposedSkill
 * and inserts a corresponding PendingReview row for human approval.
 *
 * Returns null if no skill is warranted or on any LLM/parse failure.
 */
export async function proposeSkillFromWorkspace(
  workspaceId: string,
  org: string,
  pendingReviewDAO: PendingReviewDAO,
  executionSummary?: string,
  llmCall: (prompt: string) => Promise<string> = callHaiku,
): Promise<ProposedSkill | null> {
  const prompt = `Based on the following workspace execution summary, propose a reusable Skill:

${executionSummary ?? "No summary available."}

If a skill would be valuable, respond with JSON:
{"skillName": "octo-skill-name", "category": "development|testing|design|ops", "content": "Skill markdown content", "confidence": 0.8}

If no skill is warranted, respond with: null`

  const response = await llmCall(prompt)
  if (!response || response.trim() === "null") return null

  try {
    const parsed = JSON.parse(response.replace(/```json?\n?/g, "").replace(/```/g, "").trim())
    if (!parsed.skillName) return null

    const skill: ProposedSkill = {
      id: generateSkillId(),
      skillName: parsed.skillName,
      category: parsed.category ?? "development",
      source: "workspace_archive" as PendingSource,
      sourceRef: workspaceId,
      content: parsed.content ?? "",
      confidence: parsed.confidence ?? 0.7,
      status: "pending",
    }

    // Insert into pending_review as a skill proposal
    pendingReviewDAO.insert({
      id: skill.id,
      type: "skill",
      source: skill.source,
      source_ref: skill.sourceRef,
      source_label: `Workspace ${workspaceId}`,
      content: skill.content,
      target_file: `skills/${skill.skillName}/SKILL.md`,
      scope: "project",
      conflicts: null,
      confidence: skill.confidence,
      auto_approve: 0,
      status: "pending",
      user_notes: null,
    })

    return skill
  } catch {
    console.warn("[knowledge] Failed to parse skill proposal from LLM")
    return null
  }
}

// ---------------------------------------------------------------------------
// P4.4 — Skill approval
// ---------------------------------------------------------------------------

/**
 * Approve a proposed skill: write SKILL.md to the org skills directory.
 *
 * Creates the skill directory under `~/.octopus/{org}/skills/{skillName}/`
 * and writes the skill content as SKILL.md. Updates the PendingReview row
 * status to "approved".
 */
export function approveSkill(
  proposed: ProposedSkill,
  org: string,
  pendingReviewDAO: PendingReviewDAO,
): { ok: true } {
  const skillsDir = path.join(getKnowledgeDir(org), "..", "skills", proposed.skillName)
  fs.mkdirSync(skillsDir, { recursive: true })
  fs.writeFileSync(path.join(skillsDir, "SKILL.md"), proposed.content, "utf-8")
  pendingReviewDAO.updateStatus(proposed.id, "approved")
  return { ok: true }
}
