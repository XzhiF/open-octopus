import path from "path"
import type { PendingReviewDAO, KnowledgeRuleDAO } from "../../db/dao"
import {
  getKnowledgeDir,
  readKnowledgeFile,
  listKnowledgeFiles,
  parseKnowledgeFile,
  generateRuleId,
} from "./file-ops"
import type { PendingSource } from "@octopus/shared"

// ---------------------------------------------------------------------------
// LLM wrapper (same pattern as extract.ts — placeholder until providers
// exposes a simple completion API)
// ---------------------------------------------------------------------------

async function callHaiku(_prompt: string): Promise<string> {
  // TODO: wire up real LLM call once providers exposes a simple completion API.
  console.warn("[knowledge] callHaiku is a placeholder — returning empty string")
  return ""
}

// ---------------------------------------------------------------------------
// P4.5 — Knowledge file compaction
// ---------------------------------------------------------------------------

/**
 * Compact a knowledge file: LLM merges/deduplicates rules.
 *
 * Does NOT overwrite the original — outputs a consolidated version to
 * pending_review for human approval.
 *
 * Returns the pending item ID plus original and suggested line counts.
 */
export async function compactKnowledgeFile(
  org: string,
  fileName: string,
  pendingReviewDAO: PendingReviewDAO,
): Promise<{ pendingItemId: string; originalLineCount: number; suggestedLineCount: number }> {
  const knowledgeDir = getKnowledgeDir(org)
  const filePath = path.join(knowledgeDir, fileName)
  const content = readKnowledgeFile(filePath)

  if (!content) throw new Error("NOT_FOUND")

  const originalLineCount = content.split("\n").length
  const rules = parseKnowledgeFile(filePath)

  const prompt = `Consolidate and deduplicate these knowledge rules:

${rules.map(r => `- [${r.id}] ${r.text}`).join("\n")}

Return a JSON array of consolidated rules (each as {"text": "imperative sentence"}).
Merge overlapping rules, remove duplicates, keep the most concise version.
Return ONLY the JSON array.`

  const response = await callHaiku(prompt)
  let consolidated: Array<{ text: string }> = []
  try {
    consolidated = JSON.parse(response.replace(/```json?\n?/g, "").replace(/```/g, "").trim())
  } catch {
    consolidated = []
  }

  const suggestedLineCount = consolidated.length * 2 // rule + metadata line

  // Create a pending item with the compacted rules
  const pendingId = generateRuleId("compact")
  pendingReviewDAO.insert({
    id: pendingId,
    type: "rule",
    source: "system" as PendingSource,
    source_ref: `compact:${fileName}`,
    source_label: `Compact ${fileName}`,
    content: consolidated.map(r => `- ${r.text}`).join("\n"),
    target_file: fileName,
    scope: "project",
    conflicts: null,
    confidence: 0.7,
    auto_approve: 0,
    status: "pending",
    user_notes: null,
  })

  return { pendingItemId: pendingId, originalLineCount, suggestedLineCount }
}

// ---------------------------------------------------------------------------
// P4.6 — Compact threshold check
// ---------------------------------------------------------------------------

/**
 * Check if a file exceeds the compact threshold.
 *
 * If the file has reached or exceeded the line count threshold, creates a
 * system PendingItem suggesting compaction. Idempotent: skips if a threshold
 * warning already exists for the same file.
 */
export function checkCompactThreshold(
  org: string,
  fileName: string,
  threshold: number,
  pendingReviewDAO: PendingReviewDAO,
): void {
  const knowledgeDir = getKnowledgeDir(org)
  const filePath = path.join(knowledgeDir, fileName)
  const content = readKnowledgeFile(filePath)
  const lineCount = content ? content.split("\n").length : 0

  if (lineCount >= threshold) {
    const existingCheck = pendingReviewDAO.listBySource("system")
      .find(item => item.source_ref === `compact-threshold:${fileName}`)
    if (existingCheck) return // already flagged

    pendingReviewDAO.insert({
      id: generateRuleId("threshold"),
      type: "rule",
      source: "system" as PendingSource,
      source_ref: `compact-threshold:${fileName}`,
      source_label: `File size warning`,
      content: `File ${fileName} has reached ${lineCount} lines (threshold: ${threshold}). Consider compacting.`,
      target_file: fileName,
      scope: "project",
      conflicts: null,
      confidence: 1.0,
      auto_approve: 0,
      status: "pending",
      user_notes: null,
    })
  }
}

// ---------------------------------------------------------------------------
// P4.7 — Clone merge
// ---------------------------------------------------------------------------

/**
 * Merge knowledge from a Clone back to the main agent.
 *
 * Scans pending_review items from clone executions (source_ref contains
 * `clone:{cloneId}:`) and creates new PendingItems in the main agent's
 * queue with source: 'clone_merge'.
 *
 * Returns the number of items merged.
 */
export function mergeCloneKnowledge(
  cloneId: string,
  pendingReviewDAO: PendingReviewDAO,
): number {
  // Find rules from clone executions (source_ref contains clone:{cloneId}:)
  const allPending = pendingReviewDAO.listBySource("workspace_archive")
  const cloneItems = allPending.filter(item =>
    item.source_ref.includes(`clone:${cloneId}:`)
  )

  let count = 0
  for (const item of cloneItems) {
    // Create new pending items in the main agent's queue
    pendingReviewDAO.insert({
      id: generateRuleId("clone"),
      type: "rule",
      source: "clone_merge" as PendingSource,
      source_ref: item.source_ref,
      source_label: `Clone ${cloneId}: ${item.source_label}`,
      content: item.content,
      target_file: item.target_file,
      scope: item.scope,
      conflicts: item.conflicts,
      confidence: item.confidence,
      auto_approve: 0,
      status: "pending",
      user_notes: null,
    })
    count++
  }

  return count
}

// ---------------------------------------------------------------------------
// P4.8 — Knowledge evolution / pattern analysis
// ---------------------------------------------------------------------------

/**
 * Analyze knowledge patterns for evolution/skill suggestions.
 *
 * Scans org knowledge files, groups rules by target file, and for files with
 * 5+ rules, proposes consolidation as a Skill via a single Haiku call per file.
 *
 * Returns the number of skill proposals created.
 */
export async function analyzeKnowledgePatterns(
  org: string,
  pendingReviewDAO: PendingReviewDAO,
): Promise<number> {
  const knowledgeDir = getKnowledgeDir(org)
  const files = listKnowledgeFiles(knowledgeDir)
  let proposalCount = 0

  // Group rules by target file
  const rulesByFile = new Map<string, Array<{ id: string; text: string; source: string }>>()
  for (const file of files) {
    const filePath = path.join(knowledgeDir, file)
    const rules = parseKnowledgeFile(filePath)
    if (rules.length >= 3) { // Only analyze files with 3+ rules
      rulesByFile.set(file, rules.map(r => ({
        id: r.id,
        text: r.text,
        source: r.source,
      })))
    }
  }

  // For files with many rules, propose consolidation as skills
  for (const [file, rules] of rulesByFile) {
    if (rules.length < 5) continue // Only propose skills for files with 5+ rules

    const prompt = `These ${rules.length} rules from ${file} might benefit from being organized into a Skill.

Rules:
${rules.map(r => `- ${r.text}`).join("\n")}

If a Skill would help organize these rules, respond with JSON:
{"skillName": "octo-skill-name", "category": "development|testing|ops", "content": "Skill markdown", "confidence": 0.6}
Otherwise respond with: null`

    const response = await callHaiku(prompt)
    if (!response || response.trim() === "null") continue

    try {
      const parsed = JSON.parse(response.replace(/```json?\n?/g, "").replace(/```/g, "").trim())
      if (!parsed.skillName) continue

      const skillId = `skill-pattern-${Date.now().toString(36)}`
      pendingReviewDAO.insert({
        id: skillId,
        type: "skill",
        source: "knowledge_pattern" as PendingSource,
        source_ref: `pattern:${file}`,
        source_label: `Knowledge pattern from ${file}`,
        content: parsed.content ?? "",
        target_file: `skills/${parsed.skillName}/SKILL.md`,
        scope: "project",
        conflicts: null,
        confidence: parsed.confidence ?? 0.5,
        auto_approve: 0,
        status: "pending",
        user_notes: null,
      })
      proposalCount++
    } catch {
      console.warn("[knowledge] Failed to parse skill pattern proposal")
    }
  }

  return proposalCount
}
