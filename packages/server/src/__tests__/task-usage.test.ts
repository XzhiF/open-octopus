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
  })

  it("unknown task → 404-shaped error", () => {
    expect(() => service.taskUsage("nope")).toThrow()
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
