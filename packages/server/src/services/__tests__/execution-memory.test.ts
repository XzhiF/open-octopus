// packages/server/src/services/__tests__/execution-memory.test.ts
// US-033: Integration tests for execution memory layer (archive, experience, chain, lifecycle)
import { describe, it, expect, beforeEach } from "vitest"
import Database from "better-sqlite3"
import { ArchiveDAO } from "../../db/dao/archive-dao"
import { ExperienceDAO } from "../../db/dao/experience-dao"
import { randomUUID } from "crypto"
import { readFileSync } from "fs"
import { resolve } from "path"

const SCHEMA_SQL = readFileSync(resolve(__dirname, "../../db/schema.sql"), "utf-8")

function createTestDb(): Database.Database {
  const db = new Database(":memory:")
  db.pragma("journal_mode = WAL")
  db.pragma("foreign_keys = ON")
  db.exec(SCHEMA_SQL)
  return db
}

describe("Execution Memory Layer", () => {
  let db: Database.Database
  let archiveDAO: ArchiveDAO
  let experienceDAO: ExperienceDAO
  const org = "test-org"

  beforeEach(() => {
    db = createTestDb()
    archiveDAO = new ArchiveDAO(db)
    experienceDAO = new ExperienceDAO(db)
  })

  // ── P1: Archive (US-001, US-002, US-024) ──────────────────────────────

  describe("Archive DAO", () => {
    it("should insert and retrieve execution archive with cost data", () => {
      const id = randomUUID()
      archiveDAO.insertExecutionArchive({
        id, org, workflow_ref: "wf-1", workflow_name: "Test Workflow",
        status: "completed", started_at: "2026-06-28T00:00:00Z",
        completed_at: "2026-06-28T00:01:00Z", duration_ms: 60000,
        node_summary: JSON.stringify([{ node_id: "n1", status: "completed" }]),
        failed_nodes: null, error_message: null,
        total_input_tokens: 1000, total_output_tokens: 500,
        total_cost_usd: 0.05, model_breakdown: JSON.stringify({ sonnet: { input: 1000, output: 500, cost: 0.05 } }),
        vars_snapshot: "{}", lessons_learned: null,
        workspace_archive_id: null, workspace_id: "ws-1",
        chain_position: null, parent_execution_id: null,
        schedule_id: null, clone_name: null,
      })

      const result = archiveDAO.findExecutionArchiveById(id)
      expect(result).not.toBeNull()
      expect(result!.total_input_tokens).toBe(1000)
      expect(result!.total_output_tokens).toBe(500)
      expect(result!.total_cost_usd).toBe(0.05)
      expect(JSON.parse(result!.model_breakdown!)).toHaveProperty("sonnet")
    })

    it("should list execution archives with pagination and filters", () => {
      for (let i = 0; i < 25; i++) {
        archiveDAO.insertExecutionArchive({
          id: randomUUID(), org, workflow_ref: `wf-${i % 3}`,
          workflow_name: `Workflow ${i % 3}`, status: i % 2 === 0 ? "completed" : "failed",
          started_at: "2026-06-28T00:00:00Z", completed_at: "2026-06-28T00:01:00Z",
          duration_ms: 60000, node_summary: "[]", failed_nodes: null,
          error_message: null, total_input_tokens: 100, total_output_tokens: 50,
          total_cost_usd: 0.01, model_breakdown: "{}", vars_snapshot: "{}",
          lessons_learned: null, workspace_archive_id: null, workspace_id: "ws-1",
          chain_position: null, parent_execution_id: null,
          schedule_id: null, clone_name: null,
        })
      }

      const page1 = archiveDAO.listExecutionArchives({ org, page: 1, pageSize: 10 })
      expect(page1.data.length).toBe(10)
      expect(page1.total).toBe(25)
      expect(page1.page).toBe(1)

      const filtered = archiveDAO.listExecutionArchives({ org, page: 1, pageSize: 100, status: "failed" })
      expect(filtered.data.every(e => e.status === "failed")).toBe(true)
    })

    it("should aggregate by workflow with cost trends", () => {
      for (let i = 0; i < 10; i++) {
        archiveDAO.insertExecutionArchive({
          id: randomUUID(), org, workflow_ref: "wf-cost",
          workflow_name: "Cost Workflow", status: i < 7 ? "completed" : "failed",
          started_at: "2026-06-28T00:00:00Z", completed_at: "2026-06-28T00:01:00Z",
          duration_ms: 60000, node_summary: "[]", failed_nodes: null,
          error_message: null, total_input_tokens: 100, total_output_tokens: 50,
          total_cost_usd: 0.10, model_breakdown: "{}", vars_snapshot: "{}",
          lessons_learned: null, workspace_archive_id: null, workspace_id: "ws-1",
          chain_position: null, parent_execution_id: null,
          schedule_id: null, clone_name: null,
        })
      }

      const stats = archiveDAO.aggregateByWorkflow(org, 30)
      expect(stats.length).toBe(1)
      expect(stats[0].execution_count).toBe(10)
      expect(stats[0].success_count).toBe(7)
      expect(stats[0].failed_count).toBe(3)
      expect(stats[0].total_cost_usd).toBeCloseTo(1.0)
    })

    it("should track chain parent-child relationships (US-024)", () => {
      const parentId = randomUUID()
      const childId = randomUUID()

      archiveDAO.insertExecutionArchive({
        id: parentId, org, workflow_ref: "wf-parent",
        workflow_name: "Parent", status: "completed",
        started_at: "2026-06-28T00:00:00Z", completed_at: "2026-06-28T00:01:00Z",
        duration_ms: 60000, node_summary: "[]", failed_nodes: null,
        error_message: null, total_input_tokens: 0, total_output_tokens: 0,
        total_cost_usd: 0, model_breakdown: "{}", vars_snapshot: "{}",
        lessons_learned: null, workspace_archive_id: null, workspace_id: "ws-1",
        chain_position: 0, parent_execution_id: null,
        schedule_id: null, clone_name: null,
      })

      archiveDAO.insertExecutionArchive({
        id: childId, org, workflow_ref: "wf-child",
        workflow_name: "Child", status: "completed",
        started_at: "2026-06-28T00:01:00Z", completed_at: "2026-06-28T00:02:00Z",
        duration_ms: 60000, node_summary: "[]", failed_nodes: null,
        error_message: null, total_input_tokens: 0, total_output_tokens: 0,
        total_cost_usd: 0, model_breakdown: "{}", vars_snapshot: "{}",
        lessons_learned: null, workspace_archive_id: null, workspace_id: "ws-1",
        chain_position: 1, parent_execution_id: parentId,
        schedule_id: null, clone_name: null,
      })

      const child = archiveDAO.findExecutionArchiveById(childId)
      expect(child!.parent_execution_id).toBe(parentId)
      expect(child!.chain_position).toBe(1)
    })
  })

  // ── P2: Experience Index (US-006, US-019, US-021, US-022) ────────────

  describe("Experience DAO", () => {
    it("should insert and search experiences via FTS", () => {
      const id = randomUUID()
      experienceDAO.insert({
        id, org, archive_id: "arc-1", workflow_name: "wf-1",
        type: "bug", title: "Memory leak in connection pool",
        content: "The connection pool was not releasing idle connections after timeout",
        status: "active", resolved_at: null, resolved_by: null,
        project: "server", package: "db", file_pattern: "*.ts",
        keywords: "memory,leak,connection", relevance_score: 0.9, use_count: 0,
      })

      const results = experienceDAO.searchFTS("memory leak", { org, status: "active", limit: 5 })
      expect(results.length).toBeGreaterThan(0)
      expect(results[0].title).toContain("Memory leak")
    })

    it("should filter by active status only (US-019)", () => {
      const ids = [randomUUID(), randomUUID(), randomUUID()]
      const statuses = ["active", "resolved", "obsolete"]

      for (let i = 0; i < 3; i++) {
        experienceDAO.insert({
          id: ids[i], org, archive_id: `arc-${i}`, workflow_name: "wf-1",
          type: "bug", title: `Bug ${i}`, content: `Content ${i}`,
          status: statuses[i], resolved_at: null, resolved_by: null,
          project: "server", package: "db", file_pattern: "*.ts",
          keywords: "test", relevance_score: 0.5, use_count: 0,
        })
      }

      const active = experienceDAO.findByScope({ status: "active", limit: 10 })
      expect(active.length).toBe(1)
      expect(active[0].status).toBe("active")
    })

    it("should order by relevance_score DESC, use_count DESC (US-019)", () => {
      for (let i = 0; i < 5; i++) {
        experienceDAO.insert({
          id: randomUUID(), org, archive_id: "arc-1", workflow_name: "wf-1",
          type: "pattern", title: `Pattern ${i}`, content: `Content ${i}`,
          status: "active", resolved_at: null, resolved_by: null,
          project: "server", package: "api", file_pattern: "*.ts",
          keywords: "test", relevance_score: 0.1 * i, use_count: i,
        })
      }

      const results = experienceDAO.findByScope({ status: "active", limit: 10 })
      expect(results.length).toBe(5)
      // Highest relevance first
      expect(results[0].relevance_score).toBe(0.4)
      expect(results[4].relevance_score).toBe(0)
    })

    it("should decay stale experiences (US-021)", () => {
      const staleId = randomUUID()
      const freshId = randomUUID()

      // Stale: use_count=0 and old
      experienceDAO.insert({
        id: staleId, org, archive_id: "arc-1", workflow_name: "wf-1",
        type: "bug", title: "Stale bug", content: "Old content",
        status: "active", resolved_at: null, resolved_by: null,
        project: "server", package: "db", file_pattern: "*.ts",
        keywords: "stale", relevance_score: 0.5, use_count: 0,
        created_at: "2025-01-01T00:00:00Z",
      })

      // Fresh: use_count > 0
      experienceDAO.insert({
        id: freshId, org, archive_id: "arc-2", workflow_name: "wf-2",
        type: "bug", title: "Active bug", content: "Recent content",
        status: "active", resolved_at: null, resolved_by: null,
        project: "server", package: "db", file_pattern: "*.ts",
        keywords: "active", relevance_score: 0.5, use_count: 3,
      })

      const decayed = experienceDAO.decayStale(90)
      expect(decayed).toBe(1)

      const stale = experienceDAO.findById(staleId)
      expect(stale!.status).toBe("obsolete")

      const fresh = experienceDAO.findById(freshId)
      expect(fresh!.status).toBe("active")
    })

    it("should supersede old experiences by dimension (US-022)", () => {
      const oldId = randomUUID()
      const newId = randomUUID()

      experienceDAO.insert({
        id: oldId, org, archive_id: "arc-1", workflow_name: "wf-1",
        type: "bug", title: "Old bug pattern", content: "Old",
        status: "active", resolved_at: null, resolved_by: null,
        project: "server", package: "db", file_pattern: "dao.ts",
        keywords: "bug", relevance_score: 0.5, use_count: 0,
      })

      experienceDAO.insert({
        id: newId, org, archive_id: "arc-2", workflow_name: "wf-2",
        type: "bug", title: "New bug pattern", content: "New",
        status: "active", resolved_at: null, resolved_by: null,
        project: "server", package: "db", file_pattern: "dao.ts",
        keywords: "bug", relevance_score: 0.8, use_count: 0,
      })

      experienceDAO.supersedeByDimension("server", "dao.ts", "bug", newId)

      const old = experienceDAO.findById(oldId)
      expect(old!.status).toBe("superseded")

      const newer = experienceDAO.findById(newId)
      expect(newer!.status).toBe("active")
    })
  })

  // ── P5: Suggestion Engine (US-014, US-015) ───────────────────────────

  describe("Suggestion Engine — Jaccard similarity (US-014)", () => {
    it("should detect similar bugs via Jaccard > 0.6", () => {
      // Create 4 similar bugs (same tokens)
      for (let i = 0; i < 4; i++) {
        experienceDAO.insert({
          id: randomUUID(), org, archive_id: `arc-${i}`, workflow_name: "wf-1",
          type: "bug", title: "Null pointer exception in user service",
          content: "Cannot read property of undefined when accessing user profile data",
          status: "active", resolved_at: null, resolved_by: null,
          project: "server", package: "user", file_pattern: "*.ts",
          keywords: "null,pointer,exception", relevance_score: 0.5, use_count: 0,
        })
      }
      // Create 1 different bug
      experienceDAO.insert({
        id: randomUUID(), org, archive_id: "arc-diff", workflow_name: "wf-1",
        type: "bug", title: "CSS rendering issue in mobile viewport",
        content: "The layout breaks on small screens due to overflow hidden",
        status: "active", resolved_at: null, resolved_by: null,
        project: "web-app", package: "styles", file_pattern: "*.css",
        keywords: "css,mobile,rendering", relevance_score: 0.5, use_count: 0,
      })

      const results = experienceDAO.searchFTS("null pointer", { org, type: "bug", status: "active", limit: 100 })
      expect(results.length).toBeGreaterThanOrEqual(4)

      // Verify Jaccard similarity between similar bugs is high
      const tokenize = (text: string): Set<string> => {
        const words = text.toLowerCase().replace(/[^\w一-鿿]/g, " ").split(/\s+/).filter(w => w.length > 1)
        return new Set(words)
      }
      const jaccard = (a: Set<string>, b: Set<string>): number => {
        if (a.size === 0 && b.size === 0) return 1
        let intersection = 0
        for (const w of a) if (b.has(w)) intersection++
        const union = a.size + b.size - intersection
        return union === 0 ? 0 : intersection / union
      }

      const t1 = tokenize(`${results[0].title} ${results[0].content}`)
      const t2 = tokenize(`${results[1].title} ${results[1].content}`)
      expect(jaccard(t1, t2)).toBeGreaterThan(0.6)
    })
  })

  describe("Suggestion Engine — Failure clustering (US-015)", () => {
    it("should cluster failures by failed_nodes + error_message pattern", () => {
      // Create 5 failed executions with same error pattern
      for (let i = 0; i < 5; i++) {
        archiveDAO.insertExecutionArchive({
          id: randomUUID(), org, workflow_ref: "wf-failing",
          workflow_name: "Failing Workflow", status: "failed",
          started_at: "2026-06-28T00:00:00Z", completed_at: "2026-06-28T00:01:00Z",
          duration_ms: 60000, node_summary: "[]",
          failed_nodes: "build-step",
          error_message: "Error: Module not found: @octopus/missing-pkg",
          total_input_tokens: 100, total_output_tokens: 50,
          total_cost_usd: 0.01, model_breakdown: "{}", vars_snapshot: "{}",
          lessons_learned: null, workspace_archive_id: null, workspace_id: "ws-1",
          chain_position: null, parent_execution_id: null,
          schedule_id: null, clone_name: null,
        })
      }
      // Create 2 failed executions with different error
      for (let i = 0; i < 2; i++) {
        archiveDAO.insertExecutionArchive({
          id: randomUUID(), org, workflow_ref: "wf-failing",
          workflow_name: "Failing Workflow", status: "failed",
          started_at: "2026-06-28T00:00:00Z", completed_at: "2026-06-28T00:01:00Z",
          duration_ms: 60000, node_summary: "[]",
          failed_nodes: "deploy-step",
          error_message: "Timeout: deployment exceeded 5 minute limit",
          total_input_tokens: 100, total_output_tokens: 50,
          total_cost_usd: 0.01, model_breakdown: "{}", vars_snapshot: "{}",
          lessons_learned: null, workspace_archive_id: null, workspace_id: "ws-1",
          chain_position: null, parent_execution_id: null,
          schedule_id: null, clone_name: null,
        })
      }
      // Create 3 successful executions
      for (let i = 0; i < 3; i++) {
        archiveDAO.insertExecutionArchive({
          id: randomUUID(), org, workflow_ref: "wf-failing",
          workflow_name: "Failing Workflow", status: "completed",
          started_at: "2026-06-28T00:00:00Z", completed_at: "2026-06-28T00:01:00Z",
          duration_ms: 60000, node_summary: "[]",
          failed_nodes: null, error_message: null,
          total_input_tokens: 100, total_output_tokens: 50,
          total_cost_usd: 0.01, model_breakdown: "{}", vars_snapshot: "{}",
          lessons_learned: null, workspace_archive_id: null, workspace_id: "ws-1",
          chain_position: null, parent_execution_id: null,
          schedule_id: null, clone_name: null,
        })
      }

      const stats = archiveDAO.aggregateByWorkflow(org, 30)
      expect(stats.length).toBe(1)
      expect(stats[0].failed_count).toBe(7)
      expect(stats[0].execution_count).toBe(10)
      expect(stats[0].failed_count / stats[0].execution_count).toBeGreaterThan(0.3)

      // Verify clustering: group by failed_nodes + error_message
      const failed = archiveDAO.listExecutionArchives({ org, workflow: "wf-failing", status: "failed", page: 1, pageSize: 100 })
      const patternCounts = new Map<string, number>()
      for (const exec of failed.data) {
        const key = `${exec.failed_nodes}::${(exec.error_message ?? "").substring(0, 50)}`
        patternCounts.set(key, (patternCounts.get(key) ?? 0) + 1)
      }
      expect(patternCounts.size).toBe(2) // Two distinct patterns
      const counts = [...patternCounts.values()].sort((a, b) => b - a)
      expect(counts[0]).toBe(5) // build-step pattern
      expect(counts[1]).toBe(2) // deploy-step pattern
    })
  })

  // ── P3: Chain Trigger (US-023) ─────────────────────────────────────────

  describe("Chain Trigger (US-023)", () => {
    it("should track parent-child chain in archive", () => {
      const parentId = randomUUID()
      const childId = randomUUID()
      const grandchildId = randomUUID()

      // A → B → C chain
      for (const [id, pos, parentExecId] of [
        [parentId, 0, null], [childId, 1, parentId], [grandchildId, 2, childId],
      ] as [string, number, string | null][]) {
        archiveDAO.insertExecutionArchive({
          id, org, workflow_ref: `wf-chain-${pos}`,
          workflow_name: `Chain Step ${pos}`, status: "completed",
          started_at: "2026-06-28T00:00:00Z", completed_at: "2026-06-28T00:01:00Z",
          duration_ms: 60000, node_summary: "[]", failed_nodes: null,
          error_message: null, total_input_tokens: 0, total_output_tokens: 0,
          total_cost_usd: 0, model_breakdown: "{}", vars_snapshot: "{}",
          lessons_learned: null, workspace_archive_id: null, workspace_id: "ws-1",
          chain_position: pos, parent_execution_id: parentExecId,
          schedule_id: null, clone_name: null,
        })
      }

      const grandchild = archiveDAO.findExecutionArchiveById(grandchildId)
      expect(grandchild!.parent_execution_id).toBe(childId)
      expect(grandchild!.chain_position).toBe(2)

      const child = archiveDAO.findExecutionArchiveById(childId)
      expect(child!.parent_execution_id).toBe(parentId)
      expect(child!.chain_position).toBe(1)
    })
  })

  // ── P3: Lifecycle Service (US-020, US-021, US-022) ────────────────────

  describe("Experience Lifecycle", () => {
    it("should increment use_count when experiences are injected", () => {
      const id = randomUUID()
      experienceDAO.insert({
        id, org, archive_id: "arc-1", workflow_name: "wf-1",
        type: "pattern", title: "Test pattern", content: "Test content",
        status: "active", resolved_at: null, resolved_by: null,
        project: "server", package: "api", file_pattern: "*.ts",
        keywords: "test", relevance_score: 0.5, use_count: 0,
      })

      experienceDAO.incrementUseCount([id])
      const result = experienceDAO.findById(id)
      expect(result!.use_count).toBe(1)

      // SQL IN clause deduplicates, so [id, id] still increments by 1
      experienceDAO.incrementUseCount([id])
      experienceDAO.incrementUseCount([id])
      const result2 = experienceDAO.findById(id)
      expect(result2!.use_count).toBe(3)
    })

    it("should update status to resolved", () => {
      const id = randomUUID()
      experienceDAO.insert({
        id, org, archive_id: "arc-1", workflow_name: "wf-1",
        type: "bug", title: "Fix me", content: "Bug content",
        status: "active", resolved_at: null, resolved_by: null,
        project: "server", package: "db", file_pattern: "*.ts",
        keywords: "bug", relevance_score: 0.5, use_count: 0,
      })

      experienceDAO.updateStatus(id, "resolved", new Date().toISOString(), "PR #42")
      const result = experienceDAO.findById(id)
      expect(result!.status).toBe("resolved")
      expect(result!.resolved_by).toBe("PR #42")
    })
  })
})
