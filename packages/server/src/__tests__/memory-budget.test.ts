/**
 * Memory HTTP routes — long-term write budget + conflict detail.
 *
 * Pins the contract that replaced the deleted maintenance chain:
 *   · long-term writes over memory.long_term_max_tokens → 413 with exact counts
 *   · writes at/under budget succeed and report the same token_count GET returns
 *   · MEMORY_CONFLICT keeps its 409 + details.server_content (the UI merges on it)
 *   · daily / session writes are not budgeted; safe mode still wins over budget
 *   · rebuild-fts stays available
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import path from "path"
import os from "os"

const MOCK_AGENT_DIR = vi.hoisted(() => {
  const p = require("path") as typeof import("path")
  const o = require("os") as typeof import("os")
  return p.join(o.tmpdir(), `octopus-test-memory-budget-${process.pid}`)
})

vi.mock("../services/agent/paths", async () => {
  const p = require("path") as typeof import("path")
  const actual = await vi.importActual<typeof import("../services/agent/paths")>(
    "../services/agent/paths",
  )
  return {
    ...actual,
    getAgentDir: () => MOCK_AGENT_DIR,
    getAgentMemoryDir: () => p.join(MOCK_AGENT_DIR, "memory"),
    getDailyMemoryDir: () => p.join(MOCK_AGENT_DIR, "memory", "daily"),
    getLongTermMemoryPath: () => p.join(MOCK_AGENT_DIR, "memory", "long-term.md"),
    getAgentConfigPath: () => p.join(MOCK_AGENT_DIR, "config.yaml"),
  }
})

import fs from "fs"
import { Hono } from "hono"
import { initDb, closeDb, getDb } from "../db/connection"
import { AgentSessionDAO } from "../db/dao"
import { initMemoryService } from "../services/agent/memory-service"
import { getConfigManager } from "../services/agent/config-manager"
import { createMemoryRoutes } from "../routes/agent/memory"
import { createMiscRoutes } from "../routes/agent/misc-routes"

const ORG = "test-memory-budget"
const MEMORY_DIR = path.join(MOCK_AGENT_DIR, "memory")
const DAILY_DIR = path.join(MEMORY_DIR, "daily")
const LONG_TERM = path.join(MEMORY_DIR, "long-term.md")

/** N ASCII words → N*0.75 tokens under MemoryService.estimateTokens. */
function asciiWords(n: number): string {
  return Array.from({ length: n }, () => "word").join(" ")
}

function newApp(): Hono {
  const app = new Hono()
  app.route("/api/agent", createMemoryRoutes())
  app.route("/api/agent", createMiscRoutes({ safetyDAO: {} as never }))
  return app
}

function post(url: string, body?: unknown) {
  return newApp().request(`/api/agent${url}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Octopus-Org": ORG },
    body: JSON.stringify(body ?? {}),
  })
}

function get(url: string) {
  return newApp().request(`/api/agent${url}`, {
    headers: { "X-Octopus-Org": ORG },
  })
}

function setConfig(yaml: string): void {
  fs.mkdirSync(MOCK_AGENT_DIR, { recursive: true })
  fs.writeFileSync(path.join(MOCK_AGENT_DIR, "config.yaml"), yaml, "utf-8")
  getConfigManager().clearCache()
}

describe("memory routes — long-term budget", () => {
  beforeEach(() => {
    if (fs.existsSync(MOCK_AGENT_DIR)) fs.rmSync(MOCK_AGENT_DIR, { recursive: true, force: true })
    fs.mkdirSync(DAILY_DIR, { recursive: true })
    getConfigManager().clearCache()

    initDb(":memory:")
    initMemoryService(new AgentSessionDAO(getDb()))
  })

  afterEach(() => {
    closeDb()
    getConfigManager().clearCache()
    if (fs.existsSync(MOCK_AGENT_DIR)) fs.rmSync(MOCK_AGENT_DIR, { recursive: true, force: true })
  })

  it("rejects over-budget long-term writes with 413 + exact counts, file untouched", async () => {
    fs.writeFileSync(LONG_TERM, "old content", "utf-8")

    const res = await post("/memory", { layer: "long-term", content: asciiWords(2001) })
    expect(res.status).toBe(413)
    const body = (await res.json()) as {
      error: { code: string; details: { token_count: number; max_tokens: number } }
    }
    expect(body.error.code).toBe("MEMORY_BUDGET_EXCEEDED")
    expect(body.error.details).toEqual({ token_count: 1501, max_tokens: 1500 })
    expect(fs.readFileSync(LONG_TERM, "utf-8")).toBe("old content")
  })

  it("accepts a within-budget write and reports the same token_count as GET", async () => {
    const content = asciiWords(1500) // 1125 tokens
    const write = await post("/memory", { layer: "long-term", content })
    expect(write.status).toBe(200)
    const written = (await write.json()) as { ok: boolean; token_count: number }
    expect(written.ok).toBe(true)

    const read = await get("/memory/long-term")
    expect(read.status).toBe(200)
    const readBody = (await read.json()) as { token_count: number; content: string }
    expect(readBody.token_count).toBe(written.token_count)
    expect(readBody.content).toBe(content)
  })

  it("returns 409 MEMORY_CONFLICT with details.server_content", async () => {
    fs.writeFileSync(LONG_TERM, "server-side content", "utf-8")

    const res = await post("/memory", {
      layer: "long-term",
      content: "my content",
      expected_last_modified: "2000-01-01T00:00:00.000Z",
    })
    expect(res.status).toBe(409)
    const body = (await res.json()) as {
      error: { code: string; details: { server_content: string } }
    }
    expect(body.error.code).toBe("MEMORY_CONFLICT")
    expect(body.error.details.server_content).toBe("server-side content")
  })

  it("does not budget daily memory", async () => {
    const res = await post("/memory", { layer: "daily", content: asciiWords(4000) })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; token_count: number }
    expect(body.ok).toBe(true)
    expect(body.token_count).toBeGreaterThan(1500)
  })

  it("does not budget session memory", async () => {
    const res = await post("/memory", { layer: "session", content: asciiWords(4000) })
    expect(res.status).toBe(200)
  })

  it("safe mode wins over the budget (409 before 413)", async () => {
    setConfig("safe_mode:\n  enabled: true\n")

    const res = await post("/memory", { layer: "long-term", content: asciiWords(2001) })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe("SAFE_MODE_READONLY")
  })

  it("honours a custom budget from config.yaml", async () => {
    setConfig("memory:\n  long_term_max_tokens: 200\n")

    const over = await post("/memory", { layer: "long-term", content: asciiWords(267) }) // 201 tokens
    expect(over.status).toBe(413)

    const within = await post("/memory", { layer: "long-term", content: asciiWords(200) }) // 150 tokens
    expect(within.status).toBe(200)
  })

  it("POST /memory/rebuild-fts still works", async () => {
    const res = await post("/memory/rebuild-fts")
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; rebuilt: boolean; indexed_count: number }
    expect(body.ok).toBe(true)
    expect(body.rebuilt).toBe(true)
    expect(typeof body.indexed_count).toBe("number")
  })
})
