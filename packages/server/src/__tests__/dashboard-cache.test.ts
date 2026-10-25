// Prompt-cache observability: /api/dashboard/cache aggregates the llm_calls
// ledger by source_path with the single ADR-0027 hit-rate formula.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest"
import Database from "better-sqlite3"
import { Hono } from "hono"
import { applySchema } from "../db/schema"
import { TokenUsageDAO } from "../db/dao/token-usage-dao"
import { createDashboardRoutes } from "../routes/dashboard"

let db: Database.Database
let tokenDao: TokenUsageDAO

function insertCall(
  id: string,
  sourcePath: string,
  input: number,
  read: number,
  creation: number,
  timestamp: number,
) {
  db.prepare(`
    INSERT INTO llm_calls (
      id, turn_index, call_index, timestamp, duration_ms,
      input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, source_path
    ) VALUES (?, 1, 1, ?, 0, ?, 0, ?, ?, ?)
  `).run(id, timestamp, input, read, creation, sourcePath)
}

function app() {
  const a = new Hono()
  a.route("/api/dashboard", createDashboardRoutes(
    { list: () => [] } as never,
    { getLeaderboard: () => ({}) } as never,
    {} as never,
    tokenDao,
  ))
  return a
}

beforeAll(() => {
  db = new Database(":memory:")
  applySchema(db)
  tokenDao = new TokenUsageDAO(db)
})

afterAll(() => {
  db.close()
})

beforeEach(() => {
  db.prepare("DELETE FROM llm_calls").run()
})

describe("dashboard cache stats", () => {
  it("groups by source and uses cacheRead/(input+read+creation)", () => {
    const now = Date.now()
    insertCall("c1", "global_chat", 100, 300, 600, now)   // 300/1000 = 0.3
    insertCall("c2", "global_chat", 0, 0, 1000, now)      // 0/1000 = 0
    insertCall("c3", "workflow", 0, 500, 500, now)        // 500/1000 = 0.5
    insertCall("c4", "clone_chat", 0, 0, 0, now)          // denominator 0 → null

    const stats = tokenDao.cacheStatsBySource(now - 60_000)
    expect(stats).toEqual([
      { sourcePath: "clone_chat", calls: 1, inputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, hitRate: null },
      { sourcePath: "global_chat", calls: 2, inputTokens: 100, cacheReadTokens: 300, cacheCreationTokens: 1600, hitRate: 300 / 2000 },
      { sourcePath: "workflow", calls: 1, inputTokens: 0, cacheReadTokens: 500, cacheCreationTokens: 500, hitRate: 0.5 },
    ])
  })

  it("excludes calls outside the requested window", async () => {
    const now = Date.now()
    insertCall("recent", "global_chat", 0, 100, 100, now)
    insertCall("old", "global_chat", 0, 900, 0, now - 8 * 24 * 60 * 60 * 1000)

    const res = await app().request("/api/dashboard/cache?days=7")
    expect(res.status).toBe(200)
    const body = await res.json() as {
      window_days: number
      sources: Array<{ sourcePath: string; calls: number; hitRate: number | null }>
    }
    expect(body.window_days).toBe(7)
    expect(body.sources).toHaveLength(1)
    expect(body.sources[0]).toMatchObject({ sourcePath: "global_chat", calls: 1, hitRate: 0.5 })
  })

  it("clamps the window to 1..90 days", async () => {
    const low = await (await app().request("/api/dashboard/cache?days=0")).json() as { window_days: number }
    const high = await (await app().request("/api/dashboard/cache?days=999")).json() as { window_days: number }
    expect(low.window_days).toBe(1)
    expect(high.window_days).toBe(90)
  })
})
