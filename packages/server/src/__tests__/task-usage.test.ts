// packages/server/src/__tests__/task-usage.test.ts
//
// M3-1 — GET /:id/usage: the whole lifecycle (main thread + legacy doer chat +
// every execution), with the execution_id IS NULL double-count guard.
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

const ORG = "e2e-task-usage"
const NOW = new Date().toISOString()
const MIN = 60_000

let db: Database.Database
let tmp: string
let service: TasksService

function insertSession(id: string): void {
  db.prepare(`
    INSERT INTO sessions (id, org, title, clone_name, session_type, is_active, is_deleted, created_at, updated_at)
    VALUES (?, ?, 'T', NULL, 'main', 1, 0, ?, ?)
  `).run(id, ORG, NOW, NOW)
}

function insertTask(id: string, source: string | null, doer: string | null): void {
  db.prepare(`
    INSERT INTO tasks (id, repo_group, name, status, source_chat_session_id, doer_session_id, task_spec, created_at, updated_at, workspace_id)
    VALUES (?, ?, ?, 'running', ?, ?, '{"format":"v4"}', ?, ?, 'ws-u')
  `).run(id, ORG, `任务 ${id}`, source, doer, NOW, NOW)
}

function insertExec(id: string, taskId: string): void {
  db.prepare(`
    INSERT INTO executions (id, workspace_id, org, workflow_ref, workflow_name, status,
      task_id, phase_index, round_index, start_commit_id, end_commit_id, started_at, created_at, updated_at)
    VALUES (?, 'ws-u', ?, 'built-in/matt-spec-dev', 'dev', 'completed', ?, 1, 1, '{}', '{}', ?, ?, ?)
  `).run(id, ORG, taskId, NOW, NOW, NOW)
}

/** Timed execution row — timing 用例要真实的 started_at / completed_at。 */
function insertTimedExec(opts: {
  id: string
  taskId: string
  startedAt: string | null
  completedAt: string | null
  status?: string
  phase?: number | null
  round?: number | null
  parentId?: string
}): void {
  db.prepare(`
    INSERT INTO executions (id, workspace_id, parent_id, org, workflow_ref, workflow_name, status,
      task_id, phase_index, round_index, start_commit_id, end_commit_id, started_at, completed_at, created_at, updated_at)
    VALUES (?, 'ws-u', ?, ?, 'built-in/task-dev', 'dev', ?, ?, ?, ?, '{}', '{}', ?, ?, ?, ?)
  `).run(
    opts.id,
    opts.parentId ?? "0",
    ORG,
    opts.status ?? "completed",
    opts.taskId,
    opts.phase === undefined ? 1 : opts.phase,
    opts.round === undefined ? 1 : opts.round,
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

let seq = 0
function insertCall(opts: {
  sessionId?: string | null
  executionId?: string | null
  input: number
  output: number
  cacheRead?: number
  model?: string
}): void {
  db.prepare(`
    INSERT INTO llm_calls (id, execution_id, turn_index, call_index, model, timestamp, duration_ms,
      input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, org, session_id)
    VALUES (?, ?, 0, 0, ?, ?, 1, ?, ?, ?, 0, ?, ?)
  `).run(
    `call-${seq++}`,
    opts.executionId ?? null,
    opts.model ?? "claude-opus-5",
    Date.now(),
    opts.input,
    opts.output,
    opts.cacheRead ?? 0,
    ORG,
    opts.sessionId ?? null,
  )
}

beforeAll(() => {
  db = new Database(":memory:")
  applySchema(db)
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "task-usage-"))
  db.prepare(`
    INSERT INTO workspaces (id, name, repo_group, path, created_at, updated_at)
    VALUES ('ws-u','ws',?,?,?,?)
  `).run(ORG, tmp, NOW, NOW)
  insertSession("s-main")
  insertSession("s-doer")
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

describe("taskUsage", () => {
  it("merges chat (execution_id IS NULL) + every execution, with no double count", () => {
    insertTask("t-1", "s-main", "s-doer")
    insertExec("e-1", "t-1")
    // main chat: 2 calls
    insertCall({ sessionId: "s-main", input: 100, output: 10 })
    insertCall({ sessionId: "s-main", input: 200, output: 20, cacheRead: 1000 })
    // legacy doer chat: 1 call
    insertCall({ sessionId: "s-doer", input: 50, output: 5 })
    // execution: 2 calls
    insertCall({ executionId: "e-1", sessionId: "s-main", input: 300, output: 30 })
    insertCall({ executionId: "e-1", input: 400, output: 40 })

    const usage = service.taskUsage("t-1")
    expect(usage.task_id).toBe("t-1")
    expect(usage.breakdown).toHaveLength(3)
    const chat = usage.breakdown.find((p) => p.kind === "chat" && p.session_id === "s-main")!
    expect(chat.label).toBe("主对话")
    expect(chat.totalCalls).toBe(2) // the row carrying execution_id is NOT here
    expect(chat.usage.inputTokens).toBe(300)
    const legacy = usage.breakdown.find((p) => p.kind === "chat" && p.session_id === "s-doer")!
    expect(legacy.label).toBe("旧执行对话")
    const exec = usage.breakdown.find((p) => p.kind === "execution")!
    expect(exec.label).toBe("P1 · R1")
    expect(exec.totalCalls).toBe(2)
    expect(exec.usage.inputTokens).toBe(700)
    expect(usage.summary.totalCalls).toBe(5)
    expect(usage.summary.usage.inputTokens).toBe(1050)
    expect(usage.summary.usage.outputTokens).toBe(105)
  })

  it("summary 附带按模型分解（2026-10-29）：口径同 breakdown，执行行不会算进会话侧", () => {
    insertSession("s-model")
    insertTask("t-model", "s-model", null)
    insertExec("e-model", "t-model")
    insertCall({ sessionId: "s-model", input: 100, output: 10, model: "claude-opus-5" })
    insertCall({ executionId: "e-model", input: 300, output: 30, model: "claude-haiku-5-5" })
    // 带 execution_id 的会话行：只走 execution 趟，不许再进 session 趟（防双计）
    insertCall({ executionId: "e-model", sessionId: "s-model", input: 999, output: 99, model: "claude-opus-5" })

    const usage = service.taskUsage("t-model")
    const models = usage.summary.modelBreakdown
    expect(Object.keys(models).sort()).toEqual(["claude-haiku-5-5", "claude-opus-5"])
    expect(models["claude-opus-5"].calls).toBe(2)
    expect(models["claude-opus-5"].inputTokens).toBe(1099)
    expect(models["claude-haiku-5-5"].calls).toBe(1)
    expect(models["claude-haiku-5-5"].outputTokens).toBe(30)
    // 测试库没有价表 → 未定价 = null（不焊 0）
    expect(models["claude-opus-5"].costUsd).toBeNull()
  })

  it("empty task → zero totals, empty breakdown", () => {
    insertTask("t-empty", null, null)
    const usage = service.taskUsage("t-empty")
    expect(usage.breakdown).toEqual([])
    expect(usage.summary.totalCalls).toBe(0)
    expect(usage.summary.totals.tokens).toBe(0)
    expect(usage.summary.modelBreakdown).toEqual({})
    expect(usage.timing).toEqual({ count: 0, duration_ms: 0, agent_duration_ms: 0 })
  })

  it("unknown task → 404-shaped error", () => {
    expect(() => service.taskUsage("nope")).toThrow()
  })
})

describe("taskUsage · timing（消耗窗总耗时）", () => {
  it("Σ 实跑段与 agent 工时；每轮挂 duration / agent_duration_ms，bash 节点不算 agent", () => {
    insertTask("t-time", null, null)
    insertTimedExec({
      id: "e-time1", taskId: "t-time",
      startedAt: "2026-10-31T09:00:00.000Z", completedAt: "2026-10-31T10:00:00.000Z",
      phase: 1, round: 1,
    })
    insertTimedExec({
      id: "e-time2", taskId: "t-time",
      startedAt: "2026-10-31T10:20:00.000Z", completedAt: "2026-10-31T10:32:00.000Z",
      phase: 1, round: 2,
    })
    insertNode("e-time1", "a1", 20 * MIN)
    insertNode("e-time1", "a2", 25 * MIN)
    insertNode("e-time2", "a3", 10 * MIN)
    insertNode("e-time2", "b1", 5 * MIN, "bash") // 非 agent 不进工时
    insertCall({ executionId: "e-time1", input: 10, output: 1 })
    insertCall({ executionId: "e-time2", input: 10, output: 1 })

    const usage = service.taskUsage("t-time")
    expect(usage.timing.count).toBe(2)
    expect(usage.timing.duration_ms).toBe(72 * MIN)
    expect(usage.timing.agent_duration_ms).toBe(55 * MIN)
    const p1 = usage.breakdown.find((p) => p.execution_id === "e-time1")!
    expect(p1.duration_ms).toBe(60 * MIN)
    expect(p1.agent_duration_ms).toBe(45 * MIN)
    const p2 = usage.breakdown.find((p) => p.execution_id === "e-time2")!
    expect(p2.duration_ms).toBe(12 * MIN)
    expect(p2.agent_duration_ms).toBe(10 * MIN)
  })

  it("运行中的轮计到本刻；暂停的轮不进总耗时（工时仍按实际发生计）", () => {
    insertTask("t-live", null, null)
    insertTimedExec({
      id: "e-live", taskId: "t-live",
      startedAt: new Date(Date.now() - 5 * MIN).toISOString(), completedAt: null,
      status: "running", phase: 1, round: 1,
    })
    insertNode("e-live", "a1", 4 * MIN)
    insertCall({ executionId: "e-live", input: 10, output: 1 })

    const live = service.taskUsage("t-live").timing
    expect(live.count).toBe(1)
    expect(live.duration_ms).toBeGreaterThanOrEqual(5 * MIN)
    expect(live.duration_ms).toBeLessThan(6 * MIN)
    expect(live.agent_duration_ms).toBe(4 * MIN)

    // ux_exec_task_active 只允许一个非终态实例 —— 暂停轮放另一条任务上验。
    insertTask("t-paused", null, null)
    insertTimedExec({
      id: "e-paused", taskId: "t-paused",
      startedAt: new Date(Date.now() - 60 * MIN).toISOString(), completedAt: null,
      status: "paused", phase: 1, round: 1,
    })
    insertNode("e-paused", "a2", 30 * MIN)
    insertCall({ executionId: "e-paused", input: 10, output: 1 })

    const paused = service.taskUsage("t-paused").timing
    expect(paused.count).toBe(0) // 暂停期不算墙钟
    expect(paused.duration_ms).toBe(0)
    expect(paused.agent_duration_ms).toBe(30 * MIN) // 但 agent 确实跑了 30 分钟
  })

  it("fan-out arm 有自己的时长行，但不叠进总耗时；主对话没有起止不计时长", () => {
    insertTask("t-arm", "s-main", null)
    insertTimedExec({
      id: "e-root", taskId: "t-arm",
      startedAt: "2026-10-31T09:00:00.000Z", completedAt: "2026-10-31T09:30:00.000Z",
      phase: 1, round: 1,
    })
    insertTimedExec({
      id: "e-arm", taskId: "t-arm", parentId: "e-root", phase: null, round: null,
      startedAt: "2026-10-31T09:05:00.000Z", completedAt: "2026-10-31T09:15:00.000Z",
    })
    insertNode("e-root", "a1", 20 * MIN)
    insertNode("e-arm", "a2", 9 * MIN)
    insertCall({ sessionId: "s-main", input: 10, output: 1 })
    insertCall({ executionId: "e-root", input: 10, output: 1 })
    insertCall({ executionId: "e-arm", input: 10, output: 1 })

    const usage = service.taskUsage("t-arm")
    expect(usage.timing.count).toBe(1) // arm 的跨度在根轮里，不再叠一次
    expect(usage.timing.duration_ms).toBe(30 * MIN)
    // 工时口径不过滤 arm：并行子单元的 agent 时间也是「干了多少活」
    expect(usage.timing.agent_duration_ms).toBe(29 * MIN)

    const arm = usage.breakdown.find((p) => p.execution_id === "e-arm")!
    expect(arm.duration_ms).toBe(10 * MIN)
    expect(arm.agent_duration_ms).toBe(9 * MIN)
    const chat = usage.breakdown.find((p) => p.kind === "chat")!
    expect(chat.duration_ms).toBeUndefined()
    expect(chat.agent_duration_ms).toBeUndefined()
  })
})

describe("readArchive", () => {
  it("returns state.json + report.md when present, nulls when not", () => {
    insertTask("t-arch", null, null)
    db.prepare("UPDATE tasks SET status='archiving' WHERE id='t-arch'").run()
    const home = path.join(tmp, "tasks", "t-arch", "archive")
    fs.mkdirSync(home, { recursive: true })
    fs.writeFileSync(path.join(home, "state.json"), JSON.stringify({ date: "2026-10-28", projects: { app: { ok: true } } }))
    fs.writeFileSync(path.join(home, "report.md"), "# 归档报告\n\n全部成功")

    const archive = service.readArchive("t-arch")
    expect(archive.status).toBe("archiving")
    expect(archive.in_flight).toBe(false)
    expect(archive.state).toMatchObject({ date: "2026-10-28" })
    expect(archive.report_md).toContain("全部成功")

    insertTask("t-noarchive", null, null)
    const empty = service.readArchive("t-noarchive")
    expect(empty.state).toBeNull()
    expect(empty.report_md).toBeNull()
  })
})
