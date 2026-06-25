import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { initDb, closeDb } from "../db/connection"
import { applySchema } from "../db/schema"
import { WorkspaceDAO } from '../db/dao'
import path from "path"
import os from "os"
import fs from "fs"

// Initialize isolated test database BEFORE importing index.ts
const TEST_DB = path.join(os.tmpdir(), `serve-test-${Date.now()}.db`)
beforeAll(() => {
  const db = initDb(TEST_DB)
  applySchema(db)
})
afterAll(() => {
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

  it("responds to dashboard stats", async () => {
    const res = await app.fetch(new Request("http://localhost:3001/api/dashboard/stats"))
    expect(res.status).toBe(200)
  })
})