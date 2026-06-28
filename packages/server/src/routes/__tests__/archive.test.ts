import { describe, it, expect, beforeAll, afterAll } from "vitest"
import path from "path"
import os from "os"
import fs from "fs"
import { initDb, closeDb, getDb } from "../../db/connection"
import { applySchema } from "../../db/schema"
import { ArchiveDAO } from "../../db/dao/archive-dao"
import { ExperienceDAO } from "../../db/dao/experience-dao"
import { createArchiveRoutes } from "../archive"

const TEST_DB = path.join(os.tmpdir(), `archive-route-test-${Date.now()}.db`)

let archiveDAO: ArchiveDAO
let experienceDAO: ExperienceDAO
let app: ReturnType<typeof createArchiveRoutes>

beforeAll(() => {
  const db = initDb(TEST_DB)
  applySchema(db)

  archiveDAO = new ArchiveDAO(db)
  experienceDAO = new ExperienceDAO(db)

  // Seed archive data
  const now = new Date().toISOString()
  const yesterday = new Date(Date.now() - 86400000).toISOString()

  archiveDAO.insertArchive({
    execution_id: "exec-001",
    workflow_ref: "wf-1.yaml",
    workflow_name: "Test Workflow",
    status: "completed",
    started_at: yesterday,
    completed_at: now,
    duration_ms: 5000,
    total_input_tokens: 1000,
    total_output_tokens: 500,
    total_cost_usd: 0.05,
    node_summary: JSON.stringify([{ id: "n1", status: "completed" }]),
    failed_nodes: null,
    error_message: null,
    model_breakdown: JSON.stringify({ "claude-sonnet": 0.05 }),
    vars_snapshot: JSON.stringify({ key: "value" }),
    lessons_learned: "Lesson 1",
    workspace_id: "ws-1",
    workspace_archive_id: null,
    parent_execution_id: null,
    chain_position: null,
    created_at: now,
  })

  archiveDAO.insertArchive({
    execution_id: "exec-002",
    workflow_ref: "wf-2.yaml",
    workflow_name: "Another Workflow",
    status: "failed",
    started_at: yesterday,
    completed_at: now,
    duration_ms: 3000,
    total_input_tokens: 800,
    total_output_tokens: 200,
    total_cost_usd: 0.03,
    node_summary: JSON.stringify([{ id: "n1", status: "failed" }]),
    failed_nodes: JSON.stringify(["n1"]),
    error_message: "Node n1 failed",
    model_breakdown: null,
    vars_snapshot: JSON.stringify({}),
    lessons_learned: null,
    workspace_id: "ws-1",
    workspace_archive_id: null,
    parent_execution_id: null,
    chain_position: null,
    created_at: now,
  })

  // Seed experience data
  experienceDAO.insert({
    type: "bug",
    title: "Null pointer in parser",
    content: "The YAML parser throws null pointer when input is empty",
    project: "open-octopus",
    package: "shared",
    file_pattern: "*.ts",
    keywords: "parser null",
    workflow_name: "Test Workflow",
    status: "active",
    relevance_score: 0.9,
    use_count: 3,
  })

  experienceDAO.insert({
    type: "pattern",
    title: "Retry pattern",
    content: "Use exponential backoff for API retries",
    project: "open-octopus",
    package: "engine",
    file_pattern: "*.ts",
    keywords: "retry backoff",
    workflow_name: "Test Workflow",
    status: "active",
    relevance_score: 0.8,
    use_count: 5,
  })

  experienceDAO.insert({
    type: "cost",
    title: "High token usage",
    content: "Agent node consumed 100k tokens due to large context",
    project: "open-octopus",
    package: null,
    file_pattern: null,
    keywords: "token cost",
    workflow_name: "Another Workflow",
    status: "active",
    relevance_score: 0.7,
    use_count: 1,
  })

  // Build the Hono app
  app = createArchiveRoutes({ archiveDAO, experienceDAO })
})

afterAll(() => {
  closeDb()
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB)
})

describe("Archive Routes", () => {
  // ── GET /stats ──────────────────────────────────────────

  it("GET /stats returns aggregate data", async () => {
    const res = await app.request("/stats")
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data).toHaveProperty("total_executions")
    expect(data).toHaveProperty("total_cost_usd")
    expect(data).toHaveProperty("success_rate")
    expect(data).toHaveProperty("today_cost_usd")
    expect(data).toHaveProperty("week_cost_usd")
    expect(data).toHaveProperty("month_cost_usd")
    expect(data).toHaveProperty("top_workflows")
    expect(Array.isArray(data.top_workflows)).toBe(true)
    expect(data.total_executions).toBe(2)
  })

  // ── GET /executions ──────────────────────────────────────

  it("GET /executions returns paginated list", async () => {
    const res = await app.request("/executions")
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data).toHaveProperty("items")
    expect(data).toHaveProperty("total")
    expect(data).toHaveProperty("page")
    expect(data).toHaveProperty("limit")
    expect(Array.isArray(data.items)).toBe(true)
    expect(data.items.length).toBe(2)
    expect(data.total).toBe(2)
    expect(data.page).toBe(1)
  })

  it("GET /executions respects pagination", async () => {
    const res = await app.request("/executions?page=1&limit=1")
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.items.length).toBe(1)
    expect(data.total).toBe(2)
    expect(data.limit).toBe(1)
  })

  it("GET /executions filters by status", async () => {
    const res = await app.request("/executions?status=failed")
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.items.length).toBe(1)
    expect(data.items[0].status).toBe("failed")
  })

  it("GET /executions filters by workflow_ref", async () => {
    const res = await app.request("/executions?workflow_ref=wf-1.yaml")
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.items.length).toBe(1)
    expect(data.items[0].workflow_ref).toBe("wf-1.yaml")
  })

  it("GET /executions rejects invalid sort parameter", async () => {
    const res = await app.request("/executions?sort=invalid_field")
    expect(res.status).toBe(400)
  })

  it("GET /executions rejects invalid order parameter", async () => {
    const res = await app.request("/executions?order=sideways")
    expect(res.status).toBe(400)
  })

  it("GET /executions rejects invalid date_from format", async () => {
    const res = await app.request("/executions?date_from=not-a-date")
    expect(res.status).toBe(400)
  })

  it("GET /executions rejects invalid date_to format", async () => {
    const res = await app.request("/executions?date_to=2024/01/01")
    expect(res.status).toBe(400)
  })

  // ── GET /executions/:id ──────────────────────────────────

  it("GET /executions/:id returns detail with related experiences", async () => {
    const res = await app.request("/executions/exec-001")
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.id).toBe("exec-001")
    expect(data.workflow_name).toBe("Test Workflow")
    expect(data.status).toBe("completed")
    expect(data.total_cost_usd).toBe(0.05)
    expect(data.lessons_learned).toBe("Lesson 1")
    // node_summary is parsed from JSON
    expect(Array.isArray(data.node_summary)).toBe(true)
    // model_breakdown is parsed from JSON
    expect(data.model_breakdown).toHaveProperty("claude-sonnet")
    // experiences should be related (same workflow_name)
    expect(Array.isArray(data.experiences)).toBe(true)
    expect(data.experiences.length).toBeGreaterThan(0)
  })

  it("GET /executions/:id returns 404 for missing archive", async () => {
    const res = await app.request("/executions/nonexistent-id")
    expect(res.status).toBe(404)
    const data = await res.json()
    expect(data.error).toBe("Archive not found")
  })

  // ── GET /cost-trends ──────────────────────────────────────

  it("GET /cost-trends returns day aggregation with trend direction", async () => {
    const res = await app.request("/cost-trends?days=30")
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data).toHaveProperty("trends")
    expect(Array.isArray(data.trends)).toBe(true)
    expect(data).toHaveProperty("summary")
    expect(data.summary).toHaveProperty("total_cost_usd")
    expect(data.summary).toHaveProperty("avg_daily_cost_usd")
    expect(data.summary).toHaveProperty("trend")
    expect(["up", "down", "stable"]).toContain(data.summary.trend)
  })

  it("GET /cost-trends rejects days > 365", async () => {
    const res = await app.request("/cost-trends?days=400")
    expect(res.status).toBe(400)
  })

  it("GET /cost-trends rejects days < 1", async () => {
    const res = await app.request("/cost-trends?days=0")
    expect(res.status).toBe(400)
  })

  // ── GET /lessons ──────────────────────────────────────────

  it("GET /lessons?q=xxx returns FTS search results", async () => {
    const res = await app.request("/lessons?q=parser")
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data).toHaveProperty("items")
    expect(data).toHaveProperty("total")
    expect(Array.isArray(data.items)).toBe(true)
    expect(data.items.length).toBeGreaterThan(0)
    // Items should have expected fields
    const item = data.items[0]
    expect(item).toHaveProperty("id")
    expect(item).toHaveProperty("type")
    expect(item).toHaveProperty("title")
    expect(item).toHaveProperty("content")
    expect(item).toHaveProperty("relevance_score")
    expect(item).toHaveProperty("use_count")
  })

  it("GET /lessons without q returns 400", async () => {
    const res = await app.request("/lessons")
    expect(res.status).toBe(400)
    const data = await res.json()
    expect(data.error).toBe("Query parameter 'q' is required")
  })

  // ── GET /leaderboard ──────────────────────────────────────

  it("GET /leaderboard returns ranked entries", async () => {
    const res = await app.request("/leaderboard?dimension=cost&days=30&limit=5")
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data).toHaveProperty("dimension")
    expect(data.dimension).toBe("cost")
    expect(data).toHaveProperty("entries")
    expect(Array.isArray(data.entries)).toBe(true)
    if (data.entries.length > 0) {
      expect(data.entries[0]).toHaveProperty("rank")
      expect(data.entries[0]).toHaveProperty("workflow_ref")
      expect(data.entries[0]).toHaveProperty("value")
    }
  })

  it("GET /leaderboard rejects invalid dimension", async () => {
    const res = await app.request("/leaderboard?dimension=invalid")
    expect(res.status).toBe(400)
    const data = await res.json()
    expect(data.error).toBe("Invalid parameter: dimension")
  })

  it("GET /leaderboard supports speed dimension", async () => {
    const res = await app.request("/leaderboard?dimension=speed")
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.dimension).toBe("speed")
  })

  it("GET /leaderboard supports success_rate dimension", async () => {
    const res = await app.request("/leaderboard?dimension=success_rate")
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.dimension).toBe("success_rate")
  })
})
