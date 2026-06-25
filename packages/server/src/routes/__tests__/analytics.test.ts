import { describe, it, expect, beforeAll, afterAll } from "vitest"
import path from "path"
import os from "os"
import fs from "fs"
import { initDb, closeDb } from "../../db/connection"
import { applySchema } from "../../db/schema"
import { randomUUID } from "crypto"

const TEST_DB = path.join(os.tmpdir(), `analytics-route-test-${Date.now()}.db`)
const WS_ID = randomUUID()
const ORG = "xzf"

beforeAll(() => {
  const db = initDb(TEST_DB)
  applySchema(db)
  // Seed workspace
  const now = new Date().toISOString()
  db.prepare("INSERT INTO workspaces (id, name, org, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(WS_ID, "test-ws", ORG, "/tmp/test-ws", now, now)
})

afterAll(() => {
  closeDb()
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB)
})

import app from "../../index"

describe("Analytics Routes", () => {
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

  it("TC-P1-004: GET swarm-replay returns replay data with messages/experts/consensus", async () => {
    // Create mock log data
    const execId = "test-replay-exec"
    const logDir = path.join("/tmp/test-ws", "logs", execId)
    fs.mkdirSync(logDir, { recursive: true })
    const logLines = [
      JSON.stringify({ event: "expert_message", timestamp: "2024-01-01T00:00:01Z", eventData: { role: "reviewer", round: 1, content: "LGTM", timestamp: 1000 } }),
      JSON.stringify({ event: "expert_message", timestamp: "2024-01-01T00:00:02Z", eventData: { role: "critic", round: 1, content: "needs work", timestamp: 2000 } }),
      JSON.stringify({ event: "expert_complete", timestamp: "2024-01-01T00:00:03Z", eventData: { role: "reviewer", status: "completed", round: 1 } }),
      JSON.stringify({ event: "expert_complete", timestamp: "2024-01-01T00:00:04Z", eventData: { role: "critic", status: "completed", round: 1 } }),
      JSON.stringify({ event: "consensus_check", timestamp: "2024-01-01T00:00:05Z", eventData: { round: 1, score: 0.75, shouldContinue: true } }),
    ].join("\n")
    fs.writeFileSync(path.join(logDir, "swarm-1.jsonl"), logLines)

    const res = await app.request(`/api/workspaces/${WS_ID}/analytics/swarm-replay/${execId}`)
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.executionId).toBe(execId)
    expect(Array.isArray(data.messages)).toBe(true)
    expect(data.messages.length).toBeGreaterThan(0)
    expect(data.messages[0]).toHaveProperty("from")
    expect(data.messages[0]).toHaveProperty("round")
    expect(data.messages[0]).toHaveProperty("content")
    expect(Array.isArray(data.experts)).toBe(true)
    expect(data.experts.length).toBeGreaterThan(0)
    expect(Array.isArray(data.consensus_history)).toBe(true)
    expect(data.consensus_history[0]).toHaveProperty("score")

    // Cleanup
    fs.rmSync(logDir, { recursive: true, force: true })
  })
})
