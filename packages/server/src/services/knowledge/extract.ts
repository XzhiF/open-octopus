import fs from "fs"
import path from "path"
import { KnowledgeRuleDAO } from "../../db/dao/knowledge-rule-dao"
import { PendingReviewDAO } from "../../db/dao/pending-review-dao"
import {
  appendToKnowledgeFile,
  generateRuleId,
  getKnowledgeDir,
} from "./file-ops"
import type {
  ProposedRule,
  ConflictInfo,
  PendingSource,
  KnowledgeScope,
  ConflictType,
} from "@octopus/shared"

// ---------------------------------------------------------------------------
// LLM wrapper
// ---------------------------------------------------------------------------

/**
 * ponytail: LLM provider wrapper — returns empty string on any failure.
 *
 * The @octopus/providers package exposes an agent-oriented streaming API
 * (IAgentProvider.sendQuery → AsyncGenerator<MessageChunk>) designed for
 * multi-turn Claude Agent SDK sessions. It does not expose a simple
 * single-shot chat completion method.
 *
 * Until a lightweight completion helper is added to the providers package,
 * this wrapper is a safe no-op placeholder. The extraction pipeline is
 * structured correctly and will function as soon as the real LLM call is
 * wired in here.
 */
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
// P2.1 — Trigger condition detection
// ---------------------------------------------------------------------------

export interface ExecResult {
  id: string
  status: string
  nodes: Record<string, {
    status: string
    exitCode: number | null
    lastOutput: string | null
  }>
  poolSnapshot?: Record<string, string>
}

/**
 * Determine whether rules should be extracted from an execution result.
 *
 * Returns `true` when ANY of the following signals are present:
 *  1. Review blockers ≥ 1  (pool variable `review_blockers` / `reviewBlockers`)
 *  2. Two or more E2E-related node outputs (indicating repeated fix rounds)
 *  3. Security keyword detected in any node output
 *  4. At least one node failed (non-zero exitCode) but the overall execution
 *     still completed — implying a retry/recovery happened.
 *
 * A clean, fully-successful execution with no anomalies returns `false`.
 */
export function shouldExtractRules(execResult: ExecResult): boolean {
  const nodes = Object.values(execResult.nodes ?? {})

  // --- Condition 1: review blockers ----------------------------------------
  const reviewBlockersRaw =
    execResult.poolSnapshot?.review_blockers ??
    execResult.poolSnapshot?.reviewBlockers

  if (reviewBlockersRaw) {
    try {
      const blockers = JSON.parse(reviewBlockersRaw)
      if (Array.isArray(blockers) && blockers.length >= 1) return true
    } catch {
      // Not valid JSON — treat as a single blocker string if non-empty.
      if (typeof reviewBlockersRaw === "string" && reviewBlockersRaw.trim()) {
        return true
      }
    }
  }

  // --- Condition 2: E2E fix rounds ≥ 2 ------------------------------------
  const e2eNodeCount = nodes.filter((n) => {
    const output = n.lastOutput ?? ""
    return /e2e/i.test(output)
  }).length
  if (e2eNodeCount >= 2) return true

  // --- Condition 3: Security warnings --------------------------------------
  const securityKeywords = [
    "security",
    "vulnerability",
    "cve",
    "xss",
    "sql injection",
    "injection",
  ]
  for (const node of nodes) {
    const output = (node.lastOutput ?? "").toLowerCase()
    if (securityKeywords.some((kw) => output.includes(kw))) return true
  }

  // --- Condition 4: Node failed but execution completed --------------------
  const hasFailedNodes = nodes.some(
    (n) => n.exitCode !== null && n.exitCode !== 0,
  )
  if (hasFailedNodes && execResult.status === "completed") return true

  return false
}

// ---------------------------------------------------------------------------
// P2.2 — LLM extraction + conflict detection (single Haiku call)
// ---------------------------------------------------------------------------

export interface ExtractInput {
  execResult: ExecResult
  logDir: string
  existingRulesSummary: string
}

interface RawExtractedRule {
  text: string
  scope: string
  target: string
  source: string
  conflicts?: Array<{
    existingRule: string
    existingFile: string
    conflictType: string
  }>
}

const VALID_SCOPES: ReadonlySet<string> = new Set<KnowledgeScope>([
  "project",
  "workflow",
  "global",
])

const VALID_SOURCES: ReadonlySet<string> = new Set<PendingSource>([
  "workspace_archive",
  "agent_conversation",
  "clone_merge",
  "system",
  "recurring_pitfall",
  "knowledge_pattern",
  "scheduler",
])

const VALID_CONFLICT_TYPES: ReadonlySet<string> = new Set<ConflictType>([
  "contradicts",
  "overlaps",
  "supersedes",
])

const IMPERATIVE_RE =
  /^(always|use|avoid|never|prefer|ensure|validate|check|don't|do|set|add|remove|keep|write|read|run|test|build|create|delete|update|handle|catch|log|monitor|track|skip|include|exclude|define|import|export|configure|enable|disable)$/i

/**
 * Heuristic fallback: extract basic rules from failed node outputs when LLM is unavailable.
 * Generates imperative rules from error patterns in execution results.
 */
function buildHeuristicRules(execResult: ExecResult): RawExtractedRule[] {
  const nodes = Object.entries(execResult.nodes ?? {})
  const failedNodes = nodes.filter(([, n]) => n.exitCode !== null && n.exitCode !== 0)

  if (failedNodes.length === 0) return []

  const rules: RawExtractedRule[] = []
  const seen = new Set<string>()

  for (const [nodeId, node] of failedNodes) {
    const output = (node.lastOutput ?? "").slice(0, 200)
    if (!output) continue

    // Generate a rule from the failure
    const firstLine = output.split("\n").find(l => l.trim()) ?? "unknown error"
    const ruleText = `Handle failure in ${nodeId}: ${firstLine.slice(0, 80)}`

    // Deduplicate
    if (seen.has(ruleText)) continue
    seen.add(ruleText)

    rules.push({
      text: ruleText,
      scope: "project",
      target: "octopus",
      source: "workspace_archive",
    })
  }

  return rules
}

/**
 * Single Haiku call: extract rules and detect conflicts in one prompt.
 *
 * On any LLM or parse failure the function returns an empty array — it never
 * throws or blocks the surrounding pipeline.
 */
export async function extractAndCheckRules(
  input: ExtractInput,
): Promise<(ProposedRule & { conflicts?: ConflictInfo[] })[]> {
  const { execResult, existingRulesSummary } = input

  // Gather materials for the prompt
  const nodes = Object.entries(execResult.nodes ?? {})
  const reviewBlockers =
    execResult.poolSnapshot?.review_blockers ??
    execResult.poolSnapshot?.reviewBlockers ??
    ""
  const failedNodes = nodes.filter(
    ([, n]) => n.exitCode !== null && n.exitCode !== 0,
  )
  const failedSummary = failedNodes
    .map(
      ([id, n]) =>
        `Node ${id}: ${(n.lastOutput ?? "no output").slice(0, 200)}`,
    )
    .join("\n")

  const prompt = `You are a knowledge extraction engine for a workflow automation platform.

## Execution Summary
Status: ${execResult.status}
Review Blockers: ${reviewBlockers || "none"}
Failed Nodes:
${failedSummary || "none"}

## Existing Rules
${existingRulesSummary || "No existing rules."}

## Task
Analyze the execution and extract actionable rules/lessons learned. For each rule:
1. Write it as an imperative sentence (start with a verb like "Always...", "Use...", "Avoid...")
2. Assign a scope: "project", "workflow", or "global"
3. Assign a target file name (e.g., "octopus" or "workflow-build")
4. Assign a source from: workspace_archive, agent_conversation, clone_merge, system, recurring_pitfall, knowledge_pattern, scheduler
5. Check if it conflicts with any existing rule (contradicts, overlaps, or supersedes)

Return a JSON array:
[{"text": "imperative rule text", "scope": "project", "target": "octopus", "source": "workspace_archive", "conflicts": [{"existingRule": "rule-id", "existingFile": "file", "conflictType": "contradicts"}]}]

If no rules should be extracted, return an empty array [].
Return ONLY the JSON array, no explanation.`

  const response = await callHaiku(prompt)

  let raw: unknown

  if (!response) {
    // Heuristic fallback: extract rules from failed node outputs when LLM is unavailable
    raw = buildHeuristicRules(execResult)
  } else {
    // Parse and validate
    try {
      const cleaned = response
        .replace(/```json?\n?/g, "")
        .replace(/```/g, "")
        .trim()
      raw = JSON.parse(cleaned)
    } catch (err) {
      console.warn("[knowledge] Failed to parse LLM response:", err)
      return []
    }
  }

  if (!Array.isArray(raw)) return []

  return (raw as RawExtractedRule[])
    .filter((item) => {
      if (!item.text || typeof item.text !== "string") {
        console.warn("[knowledge] Skipping rule with empty text")
        return false
      }
      const firstWord = item.text.trim().split(/\s+/)[0] ?? ""
      if (!IMPERATIVE_RE.test(firstWord)) {
        console.warn(
          `[knowledge] Skipping non-imperative rule: "${item.text.slice(0, 50)}..."`,
        )
        return false
      }
      return true
    })
    .map((item) => {
      const scope: KnowledgeScope = VALID_SCOPES.has(item.scope)
        ? (item.scope as KnowledgeScope)
        : "project"

      const source: PendingSource = VALID_SOURCES.has(item.source)
        ? (item.source as PendingSource)
        : "workspace_archive"

      const conflicts: ConflictInfo[] | undefined = Array.isArray(
        item.conflicts,
      )
        ? item.conflicts
            .filter(
              (c) =>
                c &&
                typeof c.existingRule === "string" &&
                typeof c.existingFile === "string" &&
                VALID_CONFLICT_TYPES.has(c.conflictType),
            )
            .map((c) => ({
              existingRule: c.existingRule,
              existingFile: c.existingFile,
              conflictType: c.conflictType as ConflictType,
            }))
        : undefined

      return {
        text: item.text,
        scope,
        target: item.target ?? "octopus",
        source,
        ...(conflicts && conflicts.length > 0 ? { conflicts } : {}),
      } as ProposedRule & { conflicts?: ConflictInfo[] }
    })
}

// ---------------------------------------------------------------------------
// P2.3 — Recurring pitfall detection
// ---------------------------------------------------------------------------

export interface RecurringResult {
  rule: ProposedRule
  autoApprove: boolean
}

/**
 * Scan past execution results for recurring failure patterns.
 *
 * Failures are grouped by `nodeId:errorFirstLine`. Patterns appearing:
 *  - 2 times  → proposed as a pending rule (manual review)
 *  - ≥ 3 times → auto-approved: written directly to the knowledge file,
 *    the DB `knowledge_rules` table, and `pending_review` with
 *    `auto_approve = 1 / status = 'approved'`.
 */
export async function detectRecurringPitfalls(
  org: string,
  stateDir: string,
  pendingReviewDAO: PendingReviewDAO,
  knowledgeRuleDAO: KnowledgeRuleDAO,
): Promise<RecurringResult[]> {
  const results: RecurringResult[] = []

  let stateFiles: string[]
  try {
    stateFiles = fs
      .readdirSync(stateDir)
      // Execution result files are plain UUIDs ({uuid}.json); snapshots have a
      // dash suffix ({uuid}-{name}.yaml).
      .filter((f) => f.endsWith(".json"))
      // ponytail: snapshots are .yaml, execution results are {uuid}.json
      .map((f) => path.join(stateDir, f))
  } catch (err) {
    console.error("[knowledge] Cannot read state directory:", err)
    return results
  }

  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000

  // Collect failure patterns: key → { count, sampleOutput }
  const patterns = new Map<string, { count: number; sampleOutput: string }>()

  for (const file of stateFiles) {
    try {
      const stat = fs.statSync(file)
      if (stat.mtimeMs < thirtyDaysAgo) continue

      const data = JSON.parse(fs.readFileSync(file, "utf-8")) as ExecResult
      const nodes = Object.entries(data.nodes ?? {})

      for (const [nodeId, node] of nodes) {
        if (
          node.exitCode !== null &&
          node.exitCode !== 0 &&
          node.lastOutput
        ) {
          const firstLine =
            String(node.lastOutput)
              .split("\n")
              .find((l: string) => l.trim()) ?? "unknown"
          const patternKey = `${nodeId}:${firstLine.slice(0, 80)}`

          const existing = patterns.get(patternKey)
          if (existing) {
            existing.count++
          } else {
            patterns.set(patternKey, {
              count: 1,
              sampleOutput: String(node.lastOutput).slice(0, 300),
            })
          }
        }
      }
    } catch {
      // Skip unreadable / malformed state files.
    }
  }

  // Extract rules for patterns that recur
  for (const [patternKey, info] of patterns) {
    if (info.count < 2) continue

    const autoApprove = info.count >= 3
    const nodeId = patternKey.split(":")[0] ?? "unknown"
    const rule: ProposedRule = {
      text: `Investigate and fix recurring failure in ${nodeId}: ${info.sampleOutput.slice(0, 100)}`,
      scope: "project",
      target: "octopus",
      source: "recurring_pitfall",
    }

    if (autoApprove) {
      const ruleId = generateRuleId(rule.target)
      const knowledgeDir = getKnowledgeDir(org)
      const filePath = path.join(knowledgeDir, `${rule.target}.md`)

      appendToKnowledgeFile(filePath, rule.text, ruleId, rule.source)

      knowledgeRuleDAO.insert({
        rule_id: ruleId,
        file_name: `${rule.target}.md`,
        text: rule.text,
        scope: rule.scope,
        source: rule.source,
        status: "active",
      })

      pendingReviewDAO.insert({
        id: ruleId,
        type: "rule",
        source: rule.source,
        source_ref: "auto",
        source_label: "Auto-approved recurring pitfall",
        content: rule.text,
        target_file: `${rule.target}.md`,
        scope: rule.scope,
        conflicts: null,
        confidence: 0.9,
        auto_approve: 1,
        status: "approved",
        user_notes: null,
      })
    }

    results.push({ rule, autoApprove })
  }

  return results
}

// ---------------------------------------------------------------------------
// P2.4 — Orchestrator
// ---------------------------------------------------------------------------

export interface KnowledgeConfig {
  enabled?: boolean
  auto_extract?: boolean
  auto_inject?: boolean
  knowledge_extraction?: "auto" | "disabled"
}

/**
 * Main entry point: propose rules for review after a workflow execution.
 *
 * Pipeline:
 *  1. `shouldExtractRules`      — gate: is extraction worth running?
 *  2. `extractAndCheckRules`    — single LLM call to extract + detect conflicts
 *  3. `detectRecurringPitfalls` — scan historical state for repeated failures
 *  4. Write `pending_review` rows for every proposed rule
 *
 * Wrapped in a top-level try/catch — failures in this module MUST never
 * block or fail the surrounding execution pipeline.
 *
 * @returns Total number of rules proposed (including auto-approved ones).
 */
export async function proposeRulesForReview(
  execResult: ExecResult,
  logDir: string,
  org: string,
  stateDir: string,
  knowledgeRuleDAO: KnowledgeRuleDAO,
  pendingReviewDAO: PendingReviewDAO,
  config?: KnowledgeConfig,
): Promise<number> {
  try {
    // Config gate: check if knowledge extraction is enabled
    if (config?.enabled === false) return 0
    if (config?.auto_extract === false) return 0
    if (config?.knowledge_extraction === "disabled") return 0
    // Step 1: gate — is extraction needed?
    if (!shouldExtractRules(execResult)) return 0

    // Step 2: build existing-rules summary for the LLM prompt
    const existingRules = knowledgeRuleDAO.listActive()
    const existingRulesSummary = existingRules
      .map((r) => `- [${r.rule_id}] ${r.text.slice(0, 80)}`)
      .join("\n")

    // Step 3: LLM extraction + conflict detection
    const proposedRules = await extractAndCheckRules({
      execResult,
      logDir,
      existingRulesSummary,
    })

    // Step 4: detect recurring pitfalls (may auto-approve some)
    const recurringResults = await detectRecurringPitfalls(
      org,
      stateDir,
      pendingReviewDAO,
      knowledgeRuleDAO,
    )

    // Step 5: create PendingReview rows for LLM-proposed rules
    let pendingCount = 0
    for (const proposed of proposedRules) {
      const id = generateRuleId(proposed.target)
      const hasConflicts =
        Array.isArray(proposed.conflicts) && proposed.conflicts.length > 0
      const confidence = hasConflicts ? 0.6 : 0.8

      pendingReviewDAO.insert({
        id,
        type: "rule",
        source: proposed.source,
        source_ref: execResult.id,
        source_label: `Execution ${execResult.id.slice(0, 8)}`,
        content: proposed.text,
        target_file: `${proposed.target}.md`,
        scope: proposed.scope,
        conflicts: hasConflicts
          ? JSON.stringify(proposed.conflicts)
          : null,
        confidence,
        auto_approve: 0,
        status: "pending",
        user_notes: null,
      })
      pendingCount++
    }

    const autoApprovedCount = recurringResults.filter(
      (r) => r.autoApprove,
    ).length

    return pendingCount + autoApprovedCount
  } catch (err) {
    console.error("[knowledge] proposeRulesForReview failed:", err)
    return 0
  }
}
