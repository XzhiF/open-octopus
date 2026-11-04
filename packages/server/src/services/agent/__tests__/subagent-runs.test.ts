import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import Database from "better-sqlite3"
import fs from "fs"
import path from "path"
import os from "os"
import { applySchema } from "../../../db/schema"
import { SubagentRunService } from "../subagent-runs"

const mockGetSubagentMessages = vi.fn(async () => [] as unknown[])
vi.mock("@octopus/providers", () => ({
  getSubagentMessages: (...args: unknown[]) => mockGetSubagentMessages(...(args as [])),
}))

let db: Database.Database
let dbPath: string
const SESSION = "sess-1"

beforeEach(() => {
  dbPath = path.join(os.tmpdir(), `test-subagent-runs-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`)
  db = new Database(dbPath)
  db.pragma("foreign_keys = ON")
  applySchema(db)
  db.prepare(`INSERT INTO sessions (id, created_at, updated_at) VALUES (?, ?, ?)`)
    .run(SESSION, new Date().toISOString(), new Date().toISOString())
  mockGetSubagentMessages.mockReset()
  mockGetSubagentMessages.mockResolvedValue([])
})

afterEach(() => {
  db.close()
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath)
})

describe("SubagentRunService", () => {
  it("records started → progress → log → completed as one row", () => {
    const service = new SubagentRunService(db)
    service.applyEvent(SESSION, {
      id: "agent-1", parentToolUseId: "tu-1", agentType: "general-purpose",
      description: "审查登录模块", prompt: "审查登录模块的鉴权边界",
      phase: "started", status: "running", sdkSessionId: "sdk-1",
    }, { cwd: "/work" })

    service.applyEvent(SESSION, {
      id: "agent-1", phase: "progress", description: "正在审查",
      toolUses: 2, durationMs: 1200,
    })

    service.applyEvent(SESSION, {
      id: "agent-1", phase: "log",
      blocks: [
        { kind: "thinking", text: "先看入口" },
        { kind: "tool_use", toolName: "Grep", toolUseId: "t1", input: { pattern: "auth" } },
        { kind: "tool_result", toolUseId: "t1", content: "src/auth.ts" },
      ],
    })

    const running = service.find(SESSION, "agent-1")!
    expect(running).toMatchObject({
      id: "agent-1",
      status: "running",
      agent_type: "general-purpose",
      description: "正在审查",
      prompt: "审查登录模块的鉴权边界",
      cwd: "/work",
      sdk_session_id: "sdk-1",
      tool_uses: 2,
      step_count: 3,
    })
    expect(running.steps?.map((s) => s.kind)).toEqual(["thinking", "tool_use", "tool_result"])

    service.applyEvent(SESSION, {
      id: "agent-1", phase: "completed", status: "completed",
      summary: "鉴权边界正常", toolUses: 2, durationMs: 3000,
    })

    const done = service.find(SESSION, "agent-1")!
    expect(done.status).toBe("completed")
    expect(done.summary).toBe("鉴权边界正常")
    expect(done.ended_at).toBeTruthy()
    // 日志不因完成而丢。
    expect(done.step_count).toBe(3)
  })

  it("lists newest first and keeps summary rows free of steps", () => {
    const service = new SubagentRunService(db)
    service.applyEvent(SESSION, { id: "agent-old", phase: "started", description: "旧的" })
    service.applyEvent(SESSION, { id: "agent-new", phase: "started", description: "新的" })
    // started_at 精度到毫秒，同一 tick 时用显式时间差区分先后。
    db.prepare(`UPDATE subagent_runs SET started_at = ? WHERE id = ?`).run("2020-01-01T00:00:00.000Z", "agent-old")

    const rows = service.list(SESSION)
    expect(rows.map((r) => r.id)).toEqual(["agent-new", "agent-old"])
    expect(rows[0]).not.toHaveProperty("steps")
  })

  it("backfills per-agent tokens from the SDK transcript", async () => {
    mockGetSubagentMessages.mockResolvedValue([
      { message: { model: "deepseek-v4-flash[1m]", usage: { input_tokens: 21_323, output_tokens: 65, cache_read_input_tokens: 384 } } },
      { message: { usage: { input_tokens: 483, output_tokens: 9, cache_read_input_tokens: 21_632 } } },
    ])
    const service = new SubagentRunService(db)
    service.applyEvent(SESSION, {
      id: "agent-1", phase: "started", description: "带 token 的子代理",
      sdkSessionId: "sdk-1",
    }, { cwd: "/work" })

    service.find(SESSION, "agent-1")
    // refreshUsage 是 fire-and-forget —— 等它把结果写回。
    await vi.waitFor(() => {
      const row = service.find(SESSION, "agent-1")!
      if (row.input_tokens !== 21_806) throw new Error("usage not refreshed yet")
    })

    const row = service.find(SESSION, "agent-1")!
    expect(row).toMatchObject({
      input_tokens: 21_806,
      output_tokens: 74,
      cache_read_tokens: 22_016,
      model: "deepseek-v4-flash[1m]",
    })
    expect(mockGetSubagentMessages).toHaveBeenCalledWith("sdk-1", "agent-1", { dir: "/work" })
  })

  it("ignores runs belonging to another session", () => {
    const service = new SubagentRunService(db)
    service.applyEvent(SESSION, { id: "agent-1", phase: "started" })
    expect(service.find("other-session", "agent-1")).toBeNull()
    expect(service.list("other-session")).toEqual([])
  })
})
