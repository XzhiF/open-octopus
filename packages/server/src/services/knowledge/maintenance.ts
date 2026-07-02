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
import { callHaiku } from "./llm"
import type { LLMCall } from "./llm"

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
  llmCall: LLMCall = callHaiku,
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

  const response = await llmCall(prompt)
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

/**
 * Build the compact prompt for a knowledge file.
 * Returns the original content and the prompt string.
 */
export function buildCompactPrompt(
  org: string,
  fileName: string,
): { originalContent: string; prompt: string } | null {
  const knowledgeDir = getKnowledgeDir(org)
  const filePath = path.join(knowledgeDir, fileName)
  const content = readKnowledgeFile(filePath)

  if (!content) return null

  const rules = parseKnowledgeFile(filePath)
  if (rules.length === 0) return null

  const date = new Date().toISOString().slice(0, 10)
  const baseName = fileName.replace(/\.md$/, "")

  const prompt = `Consolidate and deduplicate these knowledge rules.
Output directly in knowledge file format. Each rule should be on one line starting with "- ",
followed by a metadata comment on the next line.

Example format:
- Consolidated rule text here
<!-- id:${baseName}-001 | ${date} | compact -->

Rules to consolidate:
${rules.map(r => `- [${r.id}] ${r.text}`).join("\n")}

Merge overlapping rules, remove duplicates, keep the most concise version.
Output the final markdown directly. Do NOT output JSON or explanations.`

  return { originalContent: content, prompt }
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
