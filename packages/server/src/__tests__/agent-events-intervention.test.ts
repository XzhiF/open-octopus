// packages/server/src/__tests__/agent-events-intervention.test.ts
//
// 票 06 ⚑ 行的读取面契约 —— GET /api/workspaces/:id/executions/:execId/agent-events
// 把 resume(intervention) 落的 agent_events 'intervention' 行暴露成一等事件
// {event:"intervention", nodeId, data:{nodeId,nodeName,prompt}, timestamp}。
// 任务控制台的 ⚑ 高亮行（节点 · 原文 · 时间）与 LIVE 卡 ⚑ 干预×N 都从这条既有
// 路径读 —— 前端零新端点。期望形状来自票面文案，不是实现自证。
//
// 先例：tasks-v4-pause-resume.test.ts 的 registry stub（真 dao + 真 Hono 路由，
// JSONL 补充源置空 —— SQLite 是被测面）。

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import Database from "better-sqlite3"
import { Hono } from "hono"
import { applySchema } from "../db/schema"
import { SSEService } from "../services/sse"
import { ObservabilityService } from "../services/observability"
import { PrivacyFilter } from "../services/privacy-filter"
import { ExecutionDAO, TokenUsageDAO } from "../db/dao"
import executionRoutes, { setExecutionDependencies } from "../routes/execution"

const WS = "ws-iv-1"
const EXEC = "exec-iv-1"

const stubService = vi.hoisted(() => ({
  getAgentEvents: vi.fn(() => [] as unknown[]),          // JSONL 补充置空：SQLite 是被测面
  getLoopIterationSummary: vi.fn(() => ({})),
}))

vi.mock("../services/execution-service-registry", () => ({
  initExecutionServiceRegistry: () => {},
  getService: (_wsId: string) => ({ service: stubService, wsPath: "/tmp/ws-iv" }),
}))

let db: Database.Database
let app: Hono

beforeEach(() => {
  db = new Database(":memory:")
  applySchema(db)
  const dao = new ExecutionDAO(db)
  setExecutionDependencies(new SSEService(), new ObservabilityService(db, new PrivacyFilter(), dao), dao, new TokenUsageDAO(db))

  db.prepare(
    `INSERT INTO workspaces (id, name, org, path, source, status, created_at, updated_at)
     VALUES (?, 'ws-iv', 'org-iv', '/tmp/ws-iv', 'task', 'active', datetime('now'), datetime('now'))`,
  ).run(WS)
  db.prepare(
    `INSERT INTO executions (id, workspace_id, parent_id, child_index, workflow_ref, workflow_name,
       status, input_values, var_pool, org, created_at, updated_at)
     VALUES (?, ?, '0', 0, 'built-in/flow', 'flow', 'running', '{}', '{}', 'org-iv', datetime('now'), datetime('now'))`,
  ).run(EXEC, WS)
  db.prepare(
    `INSERT INTO node_executions (id, execution_id, node_id, node_type, status)
     VALUES (?, ?, 'step1', 'agent', 'paused')`,
  ).run(`${EXEC}-step1`, EXEC)

  app = new Hono().route("/api/workspaces/:id/executions", executionRoutes)
})

afterEach(() => { db.close() })

function seedEvent(row: Partial<{ node_execution_id: string; event_type: string; content: string | null; timestamp: number }>) {
  const ts = row.timestamp ?? Date.now()
  db.prepare(
    `INSERT INTO agent_events (node_execution_id, event_order, turn_index, event_type, timestamp,
       content, content_length, tool_is_error)
     VALUES (?, ?, 0, ?, ?, ?, ?, 0)`,
  ).run(
    row.node_execution_id ?? `${EXEC}-step1`,
    ts,
    row.event_type ?? "intervention",
    ts,
    row.content ?? null,
    (row.content ?? "").length,
  )
}

async function getEvents() {
  const res = await app.request(`/api/workspaces/${WS}/executions/${EXEC}/agent-events`)
  expect(res.status).toBe(200)
  return res.json() as Promise<{ events: Array<Record<string, unknown>> }>
}

describe("GET agent-events — ⚑ intervention 暴露面（票 06）", () => {
  it("surfaces a stored intervention row as a first-class intervention event (verbatim prompt)", async () => {
    const prompt = "别动 Dialog 尺寸逻辑，直接换固定壳；保留 1.5px 边框语言"
    seedEvent({ content: JSON.stringify({ nodeId: "step1", nodeName: "实现节点", prompt }) })

    const body = await getEvents()
    const iv = body.events.find((e) => e.event === "intervention")
    // 期望形状独立于实现：文案三要素 = 目标节点名 + 原文 + 时间（票 06 ⚑ 行）。
    expect(iv).toBeTruthy()
    expect(iv!.nodeId).toBe("step1")
    expect(iv!.data).toMatchObject({ nodeId: "step1", nodeName: "实现节点", prompt })
    expect(typeof iv!.timestamp).toBe("string")
    expect(Number.isNaN(Date.parse(String(iv!.timestamp)))).toBe(false)
  })

  it("plain-text legacy content falls back to {prompt: content} without breaking the event", async () => {
    seedEvent({ content: "纯文本干预" })
    const body = await getEvents()
    const iv = body.events.find((e) => e.event === "intervention")
    expect(iv).toBeTruthy()
    expect(iv!.data).toMatchObject({ prompt: "纯文本干预" })
  })

  it("the result twin keeps its own shape — intervention_result mapping untouched", async () => {
    const t0 = Date.now()
    seedEvent({ content: JSON.stringify({ nodeId: "step1", nodeName: "实现节点", prompt: "指路" }), timestamp: t0 })
    seedEvent({ event_type: "intervention_result", content: "好的，已按指示调整", timestamp: t0 + 5000 })
    const body = await getEvents()
    const res = body.events.find((e) => e.event === "intervention_result")
    expect(res).toBeTruthy()
    expect(res!.data).toMatchObject({ result: "好的，已按指示调整" })
    expect(body.events.filter((e) => e.event === "intervention")).toHaveLength(1)
  })

  it("executions without interventions are unaffected (no phantom ⚑ rows)", async () => {
    seedEvent({ event_type: "heartbeat", content: JSON.stringify({ step: 1 }) })
    const body = await getEvents()
    expect(body.events.filter((e) => e.event === "intervention")).toHaveLength(0)
  })
})
