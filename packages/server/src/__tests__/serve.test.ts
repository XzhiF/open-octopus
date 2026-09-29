import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { initDb, closeDb } from "../db/connection"
import { applySchema } from "../db/schema"
import { WorkspaceDAO } from '../db/dao'
import path from "path"
import os from "os"
import fs from "fs"
import { describePg, pgTestEnabledOn, setupRegisteredPgSchema, type PgFixture } from "../db/pg/__tests__/dao-fixture"

// Initialize isolated test database BEFORE importing index.ts
// P1 B4 票2B-3：dashboard/stats 的 tokenUsage 走 registry lazyDAO → pgSql()，
// PG 模式下必须先注册随机池（2B-2 tasks 域样板）；无 env 模式无池可注册，
// 该用例随 describePg 门 skip（生产降级逻辑不动 —— 路由对 PG 依赖是 B4 事实）。
const TEST_DB = path.join(os.tmpdir(), `serve-test-${Date.now()}.db`)
let pg: PgFixture | null = null
beforeAll(async () => {
  const db = initDb(TEST_DB)
  applySchema(db)
  if (pgTestEnabledOn()) pg = await setupRegisteredPgSchema()
})
afterAll(async () => {
  if (pg) {
    await pg.close()
    pg = null
  }
  closeDb()
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB)
})

import app from "../index"

describe("Server serve", () => {
  it("exports Hono app with fetch method", () => {
    expect(app).toBeDefined()
    expect(app.fetch).toBeDefined()
  })

  it("does not call serve() in test environment", () => {
    expect(process.env.VITEST).toBeDefined()
  })
})

describePg("Server serve (PG pool)", () => {
  it("responds to dashboard stats", async () => {
    const res = await app.fetch(new Request("http://localhost:3001/api/dashboard/stats"))
    expect(res.status).toBe(200)
  })
})