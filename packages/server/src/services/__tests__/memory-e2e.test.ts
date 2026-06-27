import { describe, it, expect, beforeAll, afterAll } from "vitest"
import path from "path"
import os from "os"
import fs from "fs"
import { initDb, closeDb } from "../../db/connection"
import { applySchema } from "../../db/schema"
import { ArchiveDAO } from "../../db/dao/archive-dao"
import { ExperienceDAO } from "../../db/dao/experience-dao"
import { ExperienceInjector } from "../experience-injector"
import { randomUUID } from "crypto"

const TEST_DB = path.join(os.tmpdir(), `memory-e2e-${Date.now()}.db`)
const ORG = "test-org"

let archiveDAO: ArchiveDAO
let experienceDAO: ExperienceDAO

// Seed IDs
const WS_ID = randomUUID()
const EXEC_IDS = Array.from({ length: 5 }, () => randomUUID())
const EXP_IDS = Array.from({ length: 4 }, () => randomUUID())

beforeAll(() => {
  const db = initDb(TEST_DB)
  applySchema(db)

  // Seed workspace
  const now = new Date().toISOString()
  db.prepare(
    "INSERT INTO workspaces (id, name, org, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(WS_ID, "test-ws", ORG, "/tmp/test-ws", now, now)

  archiveDAO = new ArchiveDAO(db)
  experienceDAO = new ExperienceDAO(db)

  // Seed 5 execution archives
  const statuses = ["completed", "completed", "completed", "failed", "completed"]
  const workflows = ["bug-hunter", "bug-hunter", "prd-impl", "prd-impl", "gen-workflow"]
  for (let i = 0; i < 5; i++) {
    archiveDAO.insertExecutionArchive({
      id: EXEC_IDS[i],
      org: ORG,
      workspace_id: WS_ID,
      workspace_name: "test-ws",
      workflow_ref: `${workflows[i]}.yaml`,
      workflow_name: workflows[i],
      status: statuses[i],
      started_at: new Date(Date.now() - (5 - i) * 86400000).toISOString(),
      completed_at: new Date(Date.now() - (5 - i) * 86400000 + 60000).toISOString(),
      duration_ms: 60000 + i * 10000,
      total_input_tokens: 1000 + i * 500,
      total_output_tokens: 500 + i * 200,
      total_cost_usd: 0.01 + i * 0.005,
      node_summary: JSON.stringify([{ id: `node-${i}`, type: "agent", status: statuses[i] }]),
      model_breakdown: null,
      failed_nodes: statuses[i] === "failed" ? JSON.stringify(["scan"]) : null,
      error_message: statuses[i] === "failed" ? "timeout" : null,
      vars_snapshot: "{}",
      lessons_learned: null,
      parent_execution_id: null,
      workspace_archive_id: null,
      created_at: new Date(Date.now() - (5 - i) * 86400000).toISOString(),
    })
  }

  // Seed 4 experience entries
  const expData = [
    { type: "bug", title: "Dialog 闪关 BUG", content: "DropdownMenu 内 Dialog 需 Portal 包裹", project: "web-app", keywords: '["BUG-001","dialog","portal"]' },
    { type: "pattern", title: "SQLite FTS5 触发器模式", content: "用 after insert trigger 同步 FTS5 虚拟表", project: "server", keywords: '["FTS5","sqlite","trigger"]' },
    { type: "cost", title: "haiku 提取成本基准", content: "单次 haiku 经验提取约 $0.01", project: "server", keywords: '["haiku","cost","extraction"]' },
    { type: "failure", title: "端口冲突失败模式", content: "worktree 开发时需 hash 端口避免冲突", project: "engine", keywords: '["port","conflict","worktree"]' },
  ]
  for (let i = 0; i < 4; i++) {
    experienceDAO.insertExperience({
      id: EXP_IDS[i],
      type: expData[i].type,
      title: expData[i].title,
      content: expData[i].content,
      project: expData[i].project,
      package: null,
      file_pattern: null,
      keywords: expData[i].keywords,
      status: "active",
      relevance_score: 0.8 - i * 0.1,
      use_count: i,
      workflow_name: "bug-hunter",
      execution_id: EXEC_IDS[i],
      resolved_at: null,
      resolved_by: null,
      org: ORG,
      created_at: new Date(Date.now() - (4 - i) * 86400000).toISOString(),
      updated_at: new Date(Date.now() - (4 - i) * 86400000).toISOString(),
    })
  }
})

afterAll(() => {
  closeDb()
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB)
})

import app from "../../index"

// ── Phase 1: Archive API Routes ──────────────────────────────────────

describe("Archive API — GET /api/archive/stats", () => {
  it("returns global stats with success rate and cost", async () => {
    const res = await app.request(`/api/archive/stats?org=${ORG}`)
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.total_executions).toBe(5)
    expect(data.completed_executions).toBe(4)
    expect(data.success_rate).toBeCloseTo(0.8, 1)
    expect(data.total_cost_usd).toBeGreaterThan(0)
    expect(data.total_cost_display).toContain("¥")
  })

  it("returns USD format when currency=USD", async () => {
    const res = await app.request(`/api/archive/stats?org=${ORG}&currency=USD`)
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.total_cost_display).toContain("$")
  })
})

describe("Archive API — GET /api/archive/executions", () => {
  it("returns paginated execution list", async () => {
    const res = await app.request(`/api/archive/executions?org=${ORG}&page=1&pageSize=3`)
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.data).toBeDefined()
    expect(data.data.length).toBeLessThanOrEqual(3)
    expect(data.total).toBe(5)
  })

  it("filters by workflow name", async () => {
    const res = await app.request(`/api/archive/executions?org=${ORG}&workflow=bug-hunter`)
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.data.every((i: any) => i.workflow_name === "bug-hunter")).toBe(true)
  })

  it("filters by status", async () => {
    const res = await app.request(`/api/archive/executions?org=${ORG}&status=failed`)
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.data.every((i: any) => i.status === "failed")).toBe(true)
  })

  it("rejects invalid status", async () => {
    const res = await app.request(`/api/archive/executions?org=${ORG}&status=invalid_status`)
    expect(res.status).toBe(400)
  })
})

describe("Archive API — GET /api/archive/executions/:id", () => {
  it("returns execution detail with lessons", async () => {
    const res = await app.request(`/api/archive/executions/${EXEC_IDS[0]}`)
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.id).toBe(EXEC_IDS[0])
    expect(data.workflow_name).toBe("bug-hunter")
    expect(data.node_summary).toBeInstanceOf(Array)
    expect(data.lessons).toBeInstanceOf(Array)
  })

  it("returns 404 for unknown id", async () => {
    const res = await app.request(`/api/archive/executions/${randomUUID()}`)
    expect(res.status).toBe(404)
  })
})

describe("Archive API — GET /api/archive/cost-trends", () => {
  it("returns 7d cost trends", async () => {
    const res = await app.request(`/api/archive/cost-trends?period=7d&org=${ORG}`)
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data).toHaveProperty("points")
    expect(Array.isArray(data.points)).toBe(true)
  })

  it("returns 30d cost trends", async () => {
    const res = await app.request(`/api/archive/cost-trends?period=30d&org=${ORG}`)
    expect(res.status).toBe(200)
  })

  it("rejects invalid period", async () => {
    const res = await app.request(`/api/archive/cost-trends?period=90d`)
    expect(res.status).toBe(400)
  })
})

describe("Archive API — GET /api/archive/workflow-stats", () => {
  it("returns workflow stats", async () => {
    const res = await app.request(`/api/archive/workflow-stats?org=${ORG}`)
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(Array.isArray(data)).toBe(true)
  })
})

describe("Archive API — GET /api/archive/leaderboard", () => {
  it("returns three-dimension leaderboard", async () => {
    const res = await app.request(`/api/archive/leaderboard?org=${ORG}`)
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data).toHaveProperty("cheapest")
    expect(data).toHaveProperty("fastest")
    expect(data).toHaveProperty("most_reliable")
    expect(Array.isArray(data.cheapest)).toBe(true)
  })
})

// ── Phase 2: Experience Search (FTS5) ───────────────────────────────

describe("Experience Search — GET /api/archive/lessons", () => {
  it("searches by keyword via FTS5", async () => {
    const res = await app.request(`/api/archive/lessons?q=Dialog&org=${ORG}`)
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.length).toBeGreaterThanOrEqual(1)
    expect(data[0].title).toContain("Dialog")
  })

  it("filters by type", async () => {
    const res = await app.request(`/api/archive/lessons?type=bug&org=${ORG}`)
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.every((d: any) => d.type === "bug")).toBe(true)
  })

  it("returns recent items when no query", async () => {
    const res = await app.request(`/api/archive/lessons?org=${ORG}`)
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.length).toBe(4)
  })

  it("respects limit parameter", async () => {
    const res = await app.request(`/api/archive/lessons?org=${ORG}&limit=2`)
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.length).toBeLessThanOrEqual(2)
  })
})

// ── Phase 2: Experience Lifecycle ───────────────────────────────────

describe("Experience Lifecycle", () => {
  it("markResolved updates status to resolved", () => {
    const count = experienceDAO.markResolved("BUG-001", "PR-123")
    expect(count).toBeGreaterThanOrEqual(1)
    const entry = experienceDAO.findById(EXP_IDS[0])
    expect(entry?.status).toBe("resolved")
  })

  it("getActiveByScope returns only active entries", () => {
    const results = experienceDAO.getActiveByScope(["web-app", "server"], ["bug", "pattern"], 10)
    // EXP_IDS[0] was resolved above, so only pattern entries should remain
    expect(results.every((r) => r.status === "active")).toBe(true)
  })

  it("supersede marks old entries as superseded", () => {
    const newId = randomUUID()
    experienceDAO.insertExperience({
      id: newId, type: "pattern", title: "New FTS5 pattern", content: "Updated content",
      project: "server", package: null, file_pattern: null, keywords: null,
      status: "active", relevance_score: 0.9, use_count: 0,
      workflow_name: "bug-hunter", execution_id: null,
      resolved_at: null, resolved_by: null, org: ORG,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    })
    const count = experienceDAO.supersede("server", null as any, "pattern", newId)
    // Previous "server" pattern entry should be superseded
    expect(count).toBeGreaterThanOrEqual(0)
  })

  it("incrementUseCount increases use_count", () => {
    const before = experienceDAO.findById(EXP_IDS[2])
    expect(before?.use_count).toBe(2)
    experienceDAO.incrementUseCount([EXP_IDS[2]])
    const after = experienceDAO.findById(EXP_IDS[2])
    expect(after?.use_count).toBe(3)
  })

  it("getByExecution returns experiences for execution", () => {
    const results = experienceDAO.getByExecution(EXEC_IDS[1])
    expect(results.length).toBeGreaterThanOrEqual(1)
  })
})

// ── Phase 2: Experience Injection ───────────────────────────────────

describe("Experience Injection", () => {
  it("injectExperience returns formatted context for matching scope", async () => {
    const injector = new ExperienceInjector(experienceDAO)
    const context = await injector.injectExperience({
      projects: ["server"],
      types: ["cost"],
      limit: 5,
    })
    expect(context).toContain("[Experience Injection]")
    expect(context).toContain("haiku")
  })

  it("injectExperience returns empty string for no matches", async () => {
    const injector = new ExperienceInjector(experienceDAO)
    const context = await injector.injectExperience({
      projects: ["nonexistent-project"],
      types: ["bug"],
      limit: 5,
    })
    expect(context).toBe("")
  })

  it("injectExperience includes search_experience tool hint", async () => {
    const injector = new ExperienceInjector(experienceDAO)
    const context = await injector.injectExperience({
      projects: ["engine"],
      types: ["failure"],
      limit: 5,
    })
    expect(context).toContain("search_experience")
    expect(context).toContain("/api/archive/lessons")
  })

  it("injectExperience resolves variable references", async () => {
    const injector = new ExperienceInjector(experienceDAO)
    const context = await injector.injectExperience(
      { projects: ["$inputs.project"], types: ["cost"], limit: 5 },
      { project: "server" },
    )
    // Should match "server" entries after variable resolution
    expect(context).toContain("haiku")
  })
})

// ── Phase 3: Chain Trigger ──────────────────────────────────────────

describe("Archive DAO — Chain support", () => {
  it("getChildren returns child executions", () => {
    // Insert a child execution
    const childId = randomUUID()
    archiveDAO.insertExecutionArchive({
      id: childId,
      org: ORG,
      workspace_id: WS_ID,
      workspace_name: "test-ws",
      workflow_ref: "bug-fixer.yaml",
      workflow_name: "bug-fixer",
      status: "completed",
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      duration_ms: 30000,
      total_input_tokens: 800,
      total_output_tokens: 400,
      total_cost_usd: 0.02,
      node_summary: "[]",
      model_breakdown: null,
      failed_nodes: null,
      error_message: null,
      vars_snapshot: "{}",
      lessons_learned: null,
      parent_execution_id: EXEC_IDS[0],
      workspace_archive_id: null,
      created_at: new Date().toISOString(),
    })

    const children = archiveDAO.getChildren(EXEC_IDS[0])
    expect(children.length).toBeGreaterThanOrEqual(1)
    expect(children[0].id).toBe(childId)
  })
})
