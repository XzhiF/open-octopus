// P1 B4 票2B-1：analytics 路由经 registry lazyDAO 的 TokenUsageDAO（已迁 PG）—— 无注册
// PG 池时全链 500（票2A 姿势①）。本文件补 setupRegisteredPgSchema；app 全局 SQLite 面
// （WorkspaceDAO/ExecutionDAO，B5 批）仍走 initDb(TEST_DB)。转 describePg 双模式口径：
// PG 模式全绿，SQLite 模式 skip（不回归红 —— 生产侧 B4 起该链路本就依赖 PG）。
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import path from "path"
import os from "os"
import fs from "fs"
import { initDb, closeDb } from "../../db/connection"
import { applySchema } from "../../db/schema"
import { randomUUID } from "crypto"
import { describePg, pgTestEnabledOn, setupRegisteredPgSchema, type PgFixture } from "../../db/pg/__tests__/dao-fixture"

const TEST_DB = path.join(os.tmpdir(), `analytics-route-test-${Date.now()}.db`)
const WS_ID = randomUUID()
const ORG = "xzf"

let pg: PgFixture | null = null

beforeAll(async () => {
  if (!pgTestEnabledOn()) return // 顶层 hook 在 describe.skip 下仍会执行 —— 必须门住
  pg = await setupRegisteredPgSchema()
  const db = initDb(TEST_DB)
  applySchema(db)
  // Seed workspace
  const now = new Date().toISOString()
  db.prepare("INSERT INTO workspaces (id, name, org, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(WS_ID, "test-ws", ORG, "/tmp/test-ws", now, now)
})

afterAll(async () => {
  if (!pgTestEnabledOn()) return
  closeDb()
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB)
  await pg?.close()
  pg = null
})

import app from "../../index"

describePg("Analytics Routes", () => {
  it("GET health-summary returns summary object", async () => {
    const res = await app.request(`/api/workspaces/${WS_ID}/analytics/health-summary`)
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data).toHaveProperty("totalExecutions")
    expect(data).toHaveProperty("successRate")
    expect(data).toHaveProperty("dailyTrend")
  })

  it("GET alerts returns array", async () => {
    const res = await app.request(`/api/workspaces/${WS_ID}/analytics/alerts`)
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(Array.isArray(data)).toBe(true)
  })

  it("GET alerts respects limit parameter", async () => {
    const res = await app.request(`/api/workspaces/${WS_ID}/analytics/alerts?limit=5`)
    expect(res.status).toBe(200)
  })

  it("GET alerts rejects days > 365", async () => {
    const res = await app.request(`/api/workspaces/${WS_ID}/analytics/alerts?days=400`)
    expect(res.status).toBe(400)
  })

  it("GET failure-patterns returns patterns object", async () => {
    const res = await app.request(`/api/workspaces/${WS_ID}/analytics/failure-patterns`)
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data).toHaveProperty("errorCategories")
    expect(data).toHaveProperty("fragilityRanking")
    expect(data).toHaveProperty("failureChains")
  })

  it("GET anomalies returns anomalies object", async () => {
    const res = await app.request(`/api/workspaces/${WS_ID}/analytics/anomalies`)
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data).toHaveProperty("durationAnomalies")
    expect(data).toHaveProperty("consecutiveFailures")
    expect(data).toHaveProperty("costAnomalies")
  })

  it("GET cost-analysis returns cost object", async () => {
    const res = await app.request(`/api/workspaces/${WS_ID}/analytics/cost-analysis`)
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data).toHaveProperty("costTrend")
    expect(data).toHaveProperty("tokenDistribution")
    expect(data).toHaveProperty("costByWorkflow")
  })

  it("GET execution logs returns log context", async () => {
    const res = await app.request(`/api/workspaces/${WS_ID}/analytics/execution/nonexistent/logs`)
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data).toHaveProperty("contextLines")
    expect(data.contextLines).toEqual([])
  })

  it("returns 404 for nonexistent workspace", async () => {
    const res = await app.request("/api/workspaces/nonexistent-ws/analytics/health-summary")
    expect(res.status).toBe(404)
  })

})
