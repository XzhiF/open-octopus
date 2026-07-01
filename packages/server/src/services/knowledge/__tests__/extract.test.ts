import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import fs from "fs"
import path from "path"
import os from "os"
import crypto from "crypto"
import Database from "better-sqlite3"
import { KnowledgeRuleDAO } from "../../../db/dao/knowledge-rule-dao"
import { PendingReviewDAO } from "../../../db/dao/pending-review-dao"
import { applySchema } from "../../../db/schema"
import {
  shouldExtractRules,
  extractAndCheckRules,
  detectRecurringPitfalls,
  proposeRulesForReview,
} from "../extract"
import type { ExecResult } from "../extract"
import {
  appendToKnowledgeFile,
  readKnowledgeFile,
  writeKnowledgeFile,
} from "../file-ops"
import { compactKnowledgeFile } from "../maintenance"
import { proposeSkillFromWorkspace } from "../skill"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeExecResult(overrides: Partial<ExecResult> = {}): ExecResult {
  return {
    id: "exec-test-001",
    status: "completed",
    nodes: {
      "node-1": { status: "completed", exitCode: 0, lastOutput: "Success" },
    },
    poolSnapshot: {},
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("extract", () => {
  let db: Database.Database
  let ruleDAO: KnowledgeRuleDAO
  let pendingReviewDAO: PendingReviewDAO
  let tmpDir: string
  let stateDir: string

  beforeEach(() => {
    db = new Database(":memory:")
    applySchema(db)
    ruleDAO = new KnowledgeRuleDAO(db)
    pendingReviewDAO = new PendingReviewDAO(db)
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "extract-test-"))
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "extract-state-"))
    process.env.OCTOPUS_KNOWLEDGE_DIR = tmpDir
  })

  afterEach(() => {
    db?.close()
    delete process.env.OCTOPUS_KNOWLEDGE_DIR
    fs.rmSync(tmpDir, { recursive: true, force: true })
    fs.rmSync(stateDir, { recursive: true, force: true })
  })

  // =========================================================================
  // TC-007: shouldExtractRules returns true for anomalous executions
  // =========================================================================
  describe("shouldExtractRules", () => {
    it("returns true when review blockers >= 1", () => {
      const exec = makeExecResult({
        poolSnapshot: { review_blockers: JSON.stringify([{ id: "b1", text: "blocker" }]) },
      })
      expect(shouldExtractRules(exec)).toBe(true)
    })

    it("returns true when 2+ nodes have e2e-related output", () => {
      const exec = makeExecResult({
        nodes: {
          "node-1": { status: "completed", exitCode: 0, lastOutput: "E2E test passed" },
          "node-2": { status: "completed", exitCode: 0, lastOutput: "E2E fix round 2" },
        },
      })
      expect(shouldExtractRules(exec)).toBe(true)
    })

    it("returns true when security keywords detected", () => {
      const exec = makeExecResult({
        nodes: {
          "node-1": { status: "completed", exitCode: 0, lastOutput: "Found XSS vulnerability in input" },
        },
      })
      expect(shouldExtractRules(exec)).toBe(true)
    })

    it("returns true when node failed but execution completed", () => {
      const exec = makeExecResult({
        status: "completed",
        nodes: {
          "node-1": { status: "failed", exitCode: 1, lastOutput: "Build failed" },
        },
      })
      expect(shouldExtractRules(exec)).toBe(true)
    })

    // TC-008: clean execution returns false
    it("returns false for clean execution with no anomalies", () => {
      const exec = makeExecResult({
        status: "completed",
        nodes: {
          "node-1": { status: "completed", exitCode: 0, lastOutput: "Build succeeded" },
          "node-2": { status: "completed", exitCode: 0, lastOutput: "Tests passed" },
        },
        poolSnapshot: {},
      })
      expect(shouldExtractRules(exec)).toBe(false)
    })

    it("returns false when no nodes present", () => {
      const exec = makeExecResult({ nodes: {} })
      expect(shouldExtractRules(exec)).toBe(false)
    })
  })

  // =========================================================================
  // TC-009/TC-010: extractAndCheckRules — imperative filtering + LLM failure
  // =========================================================================
  describe("extractAndCheckRules", () => {
    it("returns heuristic rules when LLM is unavailable (placeholder)", async () => {
      // callHaiku is a placeholder returning "" → triggers buildHeuristicRules fallback
      const exec = makeExecResult({
        nodes: {
          "build-node": { status: "failed", exitCode: 1, lastOutput: "TypeError: Cannot read property 'x' of undefined" },
        },
      })

      const rules = await extractAndCheckRules({
        execResult: exec,
        logDir: "/tmp/logs",
        existingRulesSummary: "",
      })

      // Heuristic fallback generates rules from failed nodes
      // The rule text starts with "Handle" which matches IMPERATIVE_RE
      expect(rules.length).toBeGreaterThanOrEqual(1)
      expect(rules[0].text).toContain("Handle failure in build-node")
      // Verify imperative filter passes: "Handle" is in IMPERATIVE_RE
      expect(rules[0].scope).toBe("project")
    })

    it("returns empty array when no failed nodes and LLM empty", async () => {
      const exec = makeExecResult({
        nodes: {
          "node-1": { status: "completed", exitCode: 0, lastOutput: "All good" },
        },
      })

      const rules = await extractAndCheckRules({
        execResult: exec,
        logDir: "/tmp/logs",
        existingRulesSummary: "",
      })

      // No failed nodes → buildHeuristicRules returns []
      expect(rules).toHaveLength(0)
    })

    it("does not deduplicate rules from different nodes with identical errors", async () => {
      const exec = makeExecResult({
        nodes: {
          "node-a": { status: "failed", exitCode: 1, lastOutput: "Same error" },
          "node-b": { status: "failed", exitCode: 1, lastOutput: "Same error" },
        },
      })

      const rules = await extractAndCheckRules({
        execResult: exec,
        logDir: "/tmp/logs",
        existingRulesSummary: "",
      })

      // Different node IDs → different rule texts ("Handle failure in node-a" vs "node-b")
      expect(rules).toHaveLength(2)
    })
  })

  // =========================================================================
  // TC-005: user_preference.md is never modified by extraction pipeline
  // =========================================================================
  describe("user_preference protection (TC-005)", () => {
    it("extractAndCheckRules does not touch user_preference.md", async () => {
      const prefPath = path.join(tmpDir, "user_preference.md")
      writeKnowledgeFile(prefPath, "original content")

      const exec = makeExecResult({
        nodes: {
          "node-1": { status: "failed", exitCode: 1, lastOutput: "Error happened" },
        },
      })

      await extractAndCheckRules({
        execResult: exec,
        logDir: "/tmp/logs",
        existingRulesSummary: "",
      })

      expect(readKnowledgeFile(prefPath)).toBe("original content")
    })

    it("compactKnowledgeFile does not touch user_preference.md", async () => {
      const prefPath = path.join(tmpDir, "user_preference.md")
      writeKnowledgeFile(prefPath, "original content")

      // Create a target file to compact
      const targetPath = path.join(tmpDir, "octopus.md")
      appendToKnowledgeFile(targetPath, "Rule 1", "r1-20260629-abcd", "system")
      appendToKnowledgeFile(targetPath, "Rule 2", "r2-20260629-efgh", "system")

      await compactKnowledgeFile("test-org", "octopus.md", pendingReviewDAO)

      expect(readKnowledgeFile(prefPath)).toBe("original content")
    })

    it("proposeSkillFromWorkspace does not touch user_preference.md", async () => {
      const prefPath = path.join(tmpDir, "user_preference.md")
      writeKnowledgeFile(prefPath, "original content")

      await proposeSkillFromWorkspace("ws-1", "test-org", pendingReviewDAO, "summary")

      expect(readKnowledgeFile(prefPath)).toBe("original content")
    })
  })

  // =========================================================================
  // TC-011: detectRecurringPitfalls
  // =========================================================================
  describe("detectRecurringPitfalls", () => {
    function writeStateFile(dir: string, nodeId: string, exitCode: number, output: string) {
      const id = crypto.randomUUID()
      const data: ExecResult = {
        id,
        status: "completed",
        nodes: {
          [nodeId]: { status: exitCode === 0 ? "completed" : "failed", exitCode, lastOutput: output },
        },
      }
      fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(data))
    }

    it("returns empty for no recurring patterns", async () => {
      writeStateFile(stateDir, "node-1", 1, "unique error A")
      writeStateFile(stateDir, "node-2", 1, "unique error B")

      const results = await detectRecurringPitfalls("test-org", stateDir, pendingReviewDAO, ruleDAO)
      expect(results).toHaveLength(0)
    })

    it("proposes rule for pattern appearing 2 times (manual review)", async () => {
      writeStateFile(stateDir, "build", 1, "Module not found: react-foo")
      writeStateFile(stateDir, "build", 1, "Module not found: react-foo")

      const results = await detectRecurringPitfalls("test-org", stateDir, pendingReviewDAO, ruleDAO)
      expect(results).toHaveLength(1)
      expect(results[0].autoApprove).toBe(false)
      expect(results[0].rule.source).toBe("recurring_pitfall")
    })

    it("auto-approves pattern appearing >= 3 times", async () => {
      writeStateFile(stateDir, "build", 1, "Module not found: react-foo")
      writeStateFile(stateDir, "build", 1, "Module not found: react-foo")
      writeStateFile(stateDir, "build", 1, "Module not found: react-foo")

      const results = await detectRecurringPitfalls("test-org", stateDir, pendingReviewDAO, ruleDAO)
      expect(results).toHaveLength(1)
      expect(results[0].autoApprove).toBe(true)

      // Verify knowledge file was written
      const knowledgeFile = path.join(tmpDir, "octopus.md")
      const content = readKnowledgeFile(knowledgeFile)
      expect(content).toContain("recurring failure")

      // Verify DB has the rule
      const activeRules = ruleDAO.listActive()
      expect(activeRules.length).toBeGreaterThanOrEqual(1)

      // Verify pendingReviewDAO has approved entry
      const approved = pendingReviewDAO.listBySource("recurring_pitfall")
      expect(approved.length).toBeGreaterThanOrEqual(1)
      expect(approved[0].status).toBe("approved")
      expect(approved[0].auto_approve).toBe(1)
    })

    it("ignores non-JSON files in state directory", async () => {
      writeStateFile(stateDir, "build", 1, "Error X")
      writeStateFile(stateDir, "build", 1, "Error X")
      // YAML snapshot files should be ignored
      fs.writeFileSync(path.join(stateDir, "snapshot.yaml"), "not json")

      const results = await detectRecurringPitfalls("test-org", stateDir, pendingReviewDAO, ruleDAO)
      expect(results).toHaveLength(1)
    })
  })

  // =========================================================================
  // TC-023: cross-source consistency in proposeRulesForReview
  // =========================================================================
  describe("proposeRulesForReview — cross-source (TC-023)", () => {
    it("handles workspace_archive and scheduler sources via pendingReviewDAO", async () => {
      // Insert items from two different sources
      pendingReviewDAO.insert({
        id: "rule-ws-001",
        type: "rule",
        source: "workspace_archive",
        source_ref: "exec-001",
        source_label: "Workspace exec",
        content: "Always validate inputs",
        target_file: "octopus.md",
        scope: "project",
        conflicts: null,
        confidence: 0.8,
        auto_approve: 0,
        status: "pending",
        user_notes: null,
      })
      pendingReviewDAO.insert({
        id: "rule-sc-001",
        type: "rule",
        source: "scheduler",
        source_ref: "sched-001",
        source_label: "Scheduled review",
        content: "Use connection pooling",
        target_file: "octopus.md",
        scope: "project",
        conflicts: null,
        confidence: 0.8,
        auto_approve: 0,
        status: "pending",
        user_notes: null,
      })

      const wsItems = pendingReviewDAO.listBySource("workspace_archive")
      const scItems = pendingReviewDAO.listBySource("scheduler")
      expect(wsItems.length).toBeGreaterThanOrEqual(1)
      expect(scItems.length).toBeGreaterThanOrEqual(1)
      expect(wsItems[0].source).toBe("workspace_archive")
      expect(scItems[0].source).toBe("scheduler")
    })
  })

  // =========================================================================
  // TC-024: config gates in proposeRulesForReview
  // =========================================================================
  describe("proposeRulesForReview — config gates (TC-024)", () => {
    const anomalousExec: ExecResult = {
      id: "exec-gate",
      status: "completed",
      nodes: {
        "node-1": { status: "failed", exitCode: 1, lastOutput: "Build failed" },
      },
      poolSnapshot: {},
    }

    it("returns 0 when config.enabled=false", async () => {
      const count = await proposeRulesForReview(
        anomalousExec, "/tmp/logs", "test-org", stateDir, ruleDAO, pendingReviewDAO,
        { enabled: false },
      )
      expect(count).toBe(0)
    })

    it("returns 0 when config.auto_extract=false", async () => {
      const count = await proposeRulesForReview(
        anomalousExec, "/tmp/logs", "test-org", stateDir, ruleDAO, pendingReviewDAO,
        { auto_extract: false },
      )
      expect(count).toBe(0)
    })

    it("returns 0 when config.knowledge_extraction='disabled'", async () => {
      const count = await proposeRulesForReview(
        anomalousExec, "/tmp/logs", "test-org", stateDir, ruleDAO, pendingReviewDAO,
        { knowledge_extraction: "disabled" },
      )
      expect(count).toBe(0)
    })

    it("proceeds when config is undefined or enabled", async () => {
      const count = await proposeRulesForReview(
        anomalousExec, "/tmp/logs", "test-org", stateDir, ruleDAO, pendingReviewDAO,
        undefined,
      )
      // Heuristic fallback generates rules from failed nodes → pendingCount >= 1
      expect(count).toBeGreaterThanOrEqual(1)
    })
  })

  // =========================================================================
  // TC-025: workspace-level config override
  // =========================================================================
  describe("proposeRulesForReview — workspace override (TC-025)", () => {
    it("workspace knowledge_extraction='disabled' overrides agent auto_extract=true", async () => {
      const exec: ExecResult = {
        id: "exec-ws",
        status: "completed",
        nodes: {
          "node-1": { status: "failed", exitCode: 1, lastOutput: "Error" },
        },
      }

      const count = await proposeRulesForReview(
        exec, "/tmp/logs", "test-org", stateDir, ruleDAO, pendingReviewDAO,
        { auto_extract: true, knowledge_extraction: "disabled" },
      )
      expect(count).toBe(0)
    })
  })

  // =========================================================================
  // TC-045: LLM failure degradation path
  // =========================================================================
  describe("LLM failure degradation (TC-045)", () => {
    it("extractAndCheckRules does not throw when LLM returns empty", async () => {
      const exec = makeExecResult({
        nodes: {
          "node-1": { status: "failed", exitCode: 1, lastOutput: "Something failed" },
        },
      })

      // callHaiku is placeholder → returns "" → fallback to heuristics
      await expect(
        extractAndCheckRules({ execResult: exec, logDir: "/tmp", existingRulesSummary: "" }),
      ).resolves.toBeDefined()
    })

    it("proposeRulesForReview does not block on LLM failure", async () => {
      const exec = makeExecResult({
        nodes: {
          "node-1": { status: "failed", exitCode: 1, lastOutput: "Build error" },
        },
      })

      // Should not throw, should return a number (possibly >0 from heuristics)
      const count = await proposeRulesForReview(
        exec, "/tmp/logs", "test-org", stateDir, ruleDAO, pendingReviewDAO,
      )
      expect(typeof count).toBe("number")
      expect(count).toBeGreaterThanOrEqual(0)
    })

    it("proposeRulesForReview does not throw on bad state dir and returns a number", async () => {
      // Even with weird state, should not throw
      const exec = makeExecResult({
        nodes: { "n": { status: "failed", exitCode: 1, lastOutput: "Error" } },
      })

      const count = await proposeRulesForReview(
        exec, "/nonexistent/path", "test-org", "/nonexistent/state", ruleDAO, pendingReviewDAO,
      )
      expect(typeof count).toBe("number")
    })
  })
})
