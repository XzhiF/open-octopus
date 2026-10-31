// packages/server/src/__tests__/session-usage-aggregate.test.ts
//
// 2026-10-31 消耗窗通用化 — GET /api/sessions/:id/usage：
//   对话行（execution_id IS NULL）+ 本会话发起的全部任务执行轮；
//   对话耗时按调用区间并集（重复上报/并行只算一次），工作流按实跑段。
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import Database from "better-sqlite3"
import fs from "fs"
import os from "os"
import path from "path"
import { applySchema } from "../db/schema"
import { AgentSessionDAO } from "../db/dao"
import { SSEService } from "../services/sse"
import { TasksService } from "../services/tasks/tasks-service"
import { TaskHomeService } from "../services/tasks/task-home-service"

const ORG = "e2e-session-usage-aggregate"
const NOW = new Date().toISOString()
const MIN = 60_000

let db: Database.Database
let tmp: string
let service: TasksService
let seq = 0

function insertSession(id: string): void {
  db.prepare(`
    INSERT INTO sessions (id, org, title, clone_name, session_type, is_active, is_deleted, created_at, updated_at)
    VALUES (?, ?, 'T', NULL, 'main', 1, 0, ?, ?)
  `).run(id, ORG, NOW, NOW)
}

function insertTask(id: string, source: string | null, status = "done"): void {
  db.prepare(`
    INSERT INTO tasks (id, repo_group, name, status, source_chat_session_id, task_spec, created_at, updated_at, workspace_id)
    VALUES (?, ?, ?, ?, ?, '{"format":"v4"}', ?, ?, 'ws-u')
  `).run(id, ORG, `任务 ${id}`, status, source, NOW, NOW)
}

function insertExec(opts: {
  id: string
  taskId: string
  startedAt: string | null
  completedAt: string | null
  status?: string
}): void {
  db.prepare(`
    INSERT INTO executions (id, workspace_id, parent_id, org, workflow_ref, workflow_name, status,
      task_id, phase_index, round_index, start_commit_id, end_commit_id, started_at, completed_at, created_at, updated_at)
    VALUES (?, 'ws-u', '0', ?, 'built-in/task-dev', 'dev', ?, ?, 1, 1, '{}', '{}', ?, ?, ?, ?)
  `).run(
    opts.id,
    ORG,
    opts.status ?? "completed",
    opts.taskId,
    opts.startedAt,
    opts.completedAt,
    NOW,
    NOW,
  )
}

function insertNode(execId: string, nodeId: string, durationMs: number, type = "agent"): void {
  db.prepare(`
    INSERT INTO node_executions (id, execution_id, node_id, node_type, status, retry_count,
      duration, started_at, completed_at)
    VALUES (?, ?, ?, ?, 'completed', 0, ?, ?, ?)
  `).run(`${execId}-${nodeId}`, execId, nodeId, type, durationMs, NOW, NOW)
}

function insertCall(opts: {
  sessionId?: string | null
  executionId?: string | null
  timestamp: number
  durationMs: number
  input: number
  output: number
  model?: string
}): void {
  db.prepare(`
    INSERT INTO llm_calls (id, execution_id, turn_index, call_index, model, timestamp, duration_ms,
      input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, org, session_id)
    VALUES (?, ?, 0, 0, ?, ?, ?, ?, ?, 0, 0, ?, ?)
  `).run(
    `call-${seq++}`,
    opts.executionId ?? null,
    opts.model ?? "claude-opus-5",
    opts.timestamp,
    opts.durationMs,
    opts.input,
    opts.output,
    ORG,
    opts.sessionId ?? null,
  )
}

beforeAll(() => {
  db = new Database(":memory:")
  applySchema(db)
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "session-usage-aggregate-"))
  db.prepare(`
    INSERT INTO workspaces (id, name, repo_group, path, created_at, updated_at)
    VALUES ('ws-u','ws',?,?,?,?)
  `).run(ORG, tmp, NOW, NOW)
  service = new TasksService(
    db,
    new SSEService(),
    new AgentSessionDAO(db),
    new TaskHomeService(tmp),
    undefined,
    { get: () => null } as never,
  )
})

afterAll(() => {
  db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe("sessionUsage", () => {
  it("对话区间并集 + 工作流实跑段 + agent 工时", () => {
    insertSession("s-1")
    insertTask("t-1", "s-1")
    insertExec({
      id: "e-1",
      taskId: "t-1",
      startedAt: "2026-10-31T05:00:00.000Z",
      completedAt: "2026-10-31T05:20:00.000Z",
    })
    insertNode("e-1", "n1", 12 * MIN)
    insertCall({ executionId: "e-1", timestamp: 1000, durationMs: 60_000, input: 300, output: 30 })

    // 对话：重复上报（同 ts 同时长）×2 + 与首条重叠的一条 + 一条独立的。
    const t0 = 1_000_000
    insertCall({ sessionId: "s-1", timestamp: t0, durationMs: 10_000, input: 100, output: 10 })
    insertCall({ sessionId: "s-1", timestamp: t0, durationMs: 10_000, input: 100, output: 10, model: "claude-haiku-5-5" })
    insertCall({ sessionId: "s-1", timestamp: t0 + 5_000, durationMs: 5_000, input: 50, output: 5 })
    insertCall({ sessionId: "s-1", timestamp: t0 + 20_000, durationMs: 3_000, input: 25, output: 2 })

    const usage = service.sessionUsage("s-1")
    expect(usage.session_id).toBe("s-1")

    // 对话并集 = [t0, t0+10s] ∪ [t0+20s, t0+23s] = 13s
    expect(usage.timing.conversation_ms).toBe(13_000)
    expect(usage.timing.workflow_ms).toBe(20 * MIN)
    expect(usage.timing.duration_ms).toBe(13_000 + 20 * MIN)
    // 工时 = 全部对话行时长合计（10+10+5+3 = 28s）+ agent 节点 12m
    expect(usage.timing.agent_duration_ms).toBe(28_000 + 12 * MIN)

    expect(usage.workflows).toHaveLength(1)
    expect(usage.workflows[0]).toMatchObject({
      task_id: "t-1",
      name: "任务 t-1",
      status: "done",
      duration_ms: 20 * MIN,
      total_calls: 1,
      tokens: 330,
    })

    // 合计 = 4 条对话行 + 1 条执行行（账本不去重）
    expect(usage.summary.totalCalls).toBe(5)
    expect(usage.summary.usage.inputTokens).toBe(100 + 100 + 50 + 25 + 300)
    expect(Object.keys(usage.summary.modelBreakdown).sort()).toEqual([
      "claude-haiku-5-5",
      "claude-opus-5",
    ])
  })

  it("多个工作流按耗时降序；没跑过的草稿不占列表", () => {
    insertSession("s-2")
    insertTask("t-slow", "s-2")
    insertTask("t-fast", "s-2")
    insertTask("t-draft", "s-2", "draft")
    insertExec({
      id: "e-slow",
      taskId: "t-slow",
      startedAt: "2026-10-31T06:00:00.000Z",
      completedAt: "2026-10-31T06:30:00.000Z",
    })
    insertExec({
      id: "e-fast",
      taskId: "t-fast",
      startedAt: "2026-10-31T07:00:00.000Z",
      completedAt: "2026-10-31T07:10:00.000Z",
    })
    insertCall({ executionId: "e-slow", timestamp: 1000, durationMs: 1_000, input: 10, output: 1 })
    insertCall({ executionId: "e-fast", timestamp: 2000, durationMs: 1_000, input: 20, output: 2 })

    const usage = service.sessionUsage("s-2")
    expect(usage.workflows.map((w) => w.task_id)).toEqual(["t-slow", "t-fast"])
    expect(usage.workflows[0].duration_ms).toBe(30 * MIN)
    expect(usage.workflows[1].duration_ms).toBe(10 * MIN)
    expect(usage.timing.workflow_ms).toBe(40 * MIN)
    expect(usage.timing.conversation_ms).toBe(0)
  })

  it("会话行带 execution_id 时不进会话账（防双计）", () => {
    insertSession("s-3")
    insertCall({ sessionId: "s-3", timestamp: 5000, durationMs: 2_000, input: 10, output: 1 })
    insertCall({ sessionId: "s-3", executionId: "e-ghost", timestamp: 6000, durationMs: 9_000, input: 999, output: 99 })

    const usage = service.sessionUsage("s-3")
    expect(usage.summary.totalCalls).toBe(1)
    expect(usage.summary.usage.inputTokens).toBe(10)
    expect(usage.timing.conversation_ms).toBe(2_000)
    expect(usage.workflows).toEqual([])
    expect(usage.timing.workflow_ms).toBe(0)
  })

  it("空会话 → 全零、无工作流", () => {
    insertSession("s-4")
    const usage = service.sessionUsage("s-4")
    expect(usage.summary.totalCalls).toBe(0)
    expect(usage.summary.totals.tokens).toBe(0)
    expect(usage.timing).toEqual({
      conversation_ms: 0,
      workflow_ms: 0,
      duration_ms: 0,
      agent_duration_ms: 0,
    })
    expect(usage.workflows).toEqual([])
  })
})
