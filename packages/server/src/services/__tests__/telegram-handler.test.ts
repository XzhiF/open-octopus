// packages/server/src/services/__tests__/telegram-handler.test.ts
// Tests for TelegramCommandHandler: scan, unknown, status, report, experience,
// register, stop, develop commands.
import { describe, it, expect, beforeEach, vi } from "vitest"
import Database from "better-sqlite3"
import { ArchiveDAO } from "../../db/dao/archive-dao"
import { ExperienceDAO } from "../../db/dao/experience-dao"
import { ExecutionDAO } from "../../db/dao/execution-dao"
import { ScheduleConfigDAO } from "../../db/dao/schedule-config-dao"
import { TelegramCommandHandler } from "../agent/telegram-command-handler"
import { randomUUID } from "crypto"
import { readFileSync } from "fs"
import { resolve } from "path"

const SCHEMA_SQL = readFileSync(resolve(__dirname, "../../db/schema.sql"), "utf-8")

function createTestDb(): Database.Database {
  const db = new Database(":memory:")
  db.pragma("journal_mode = WAL")
  db.pragma("foreign_keys = ON")
  db.exec(SCHEMA_SQL)
  // Add current_node column referenced by findAllActiveExecutions but missing from schema.sql
  try {
    db.exec("ALTER TABLE executions ADD COLUMN current_node TEXT")
  } catch {
    // Column may already exist
  }
  return db
}

function seedWorkspace(db: Database.Database, id = "ws-1", name = "test-ws", org = "test-org") {
  db.prepare(
    `INSERT OR IGNORE INTO workspaces (id, name, org, path, status, created_at, updated_at)
     VALUES (?, ?, ?, '/tmp/ws', 'active', datetime('now'), datetime('now'))`
  ).run(id, name, org)
}

function seedExecution(db: Database.Database, id: string, status: string, workflowName = "Test Workflow") {
  seedWorkspace(db)
  db.prepare(
    `INSERT INTO executions (id, workspace_id, workflow_ref, workflow_name, status, org, parent_id, created_at, updated_at)
     VALUES (?, 'ws-1', 'wf-test', ?, ?, 'test-org', '0', datetime('now'), datetime('now'))`
  ).run(id, workflowName, status)
}

function seedArchive(db: Database.Database, id: string, org: string, cost: number, days: number = 0) {
  const date = new Date(Date.now() - days * 86400000).toISOString()
  db.prepare(
    `INSERT INTO execution_archive (id, org, workflow_ref, workflow_name, status, started_at, completed_at, duration_ms, total_cost_usd, created_at)
     VALUES (?, ?, 'wf-test', 'Test', 'completed', ?, ?, 60000, ?, ?)`
  ).run(id, org, date, date, cost, date)
}

function seedExperience(db: Database.Database, opts: {
  id?: string; title?: string; content?: string; keywords?: string;
  type?: string; status?: string; org?: string; project?: string
}) {
  const id = opts.id || randomUUID()
  db.prepare(
    `INSERT INTO experience_index (id, org, type, status, title, content, project, keywords, relevance_score, use_count, workflow_name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'test-project', ?, 1.0, 0, 'wf', datetime('now'), datetime('now'))`
  ).run(id, opts.org || "test-org", opts.type || "bug", opts.status || "active", opts.title || `Bug ${id}`, opts.content || "test content", opts.keywords || "")
  return id
}

describe("TelegramCommandHandler", () => {
  let db: Database.Database
  let archiveDAO: ArchiveDAO
  let experienceDAO: ExperienceDAO
  let executionDAO: ExecutionDAO
  let scheduleDAO: ScheduleConfigDAO
  let handler: TelegramCommandHandler

  beforeEach(() => {
    db = createTestDb()
    archiveDAO = new ArchiveDAO(db)
    experienceDAO = new ExperienceDAO(db)
    executionDAO = new ExecutionDAO(db)
    scheduleDAO = new ScheduleConfigDAO(db)
    handler = new TelegramCommandHandler({
      archiveDAO,
      experienceDAO,
      executionDAO,
      scheduleDAO,
      org: "test-org",
    })
  })

  // TC-040: scan command
  it("TC-040: handle scan command returns rocket emoji and started text", async () => {
    const result = await handler.handle({ type: "scan", scope: "全量" }, 12345)
    expect(result).toContain("🚀")
    expect(result).toContain("已启动")
    expect(result).toContain("全量")
  })

  // TC-041: unknown command
  it("TC-041: handle unknown command lists supported commands", async () => {
    const result = await handler.handle({ type: "unknown", text: "blah" }, 12345)
    expect(result).toContain("❓ 未识别的指令")
    expect(result).toContain("/扫描")
    expect(result).toContain("/开发")
    expect(result).toContain("/状态")
    expect(result).toContain("/报告")
    expect(result).toContain("/经验")
    expect(result).toContain("/注册")
    expect(result).toContain("/停止")
  })

  // TC-042: status and report commands
  describe("TC-042: status and report commands", () => {
    it("status with running executions lists them", async () => {
      const execId = randomUUID()
      seedExecution(db, execId, "running")

      const result = await handler.handle({ type: "status" }, 12345)
      expect(result).toContain("📊")
      expect(result).toContain("Test Workflow")
      expect(result).toContain(execId.substring(0, 8))
    })

    it("status with no running executions shows empty message", async () => {
      const result = await handler.handle({ type: "status" }, 12345)
      expect(result).toContain("📊")
      expect(result).toContain("当前没有正在运行的执行")
    })

    it("report shows 7-day summary with cost info", async () => {
      seedArchive(db, randomUUID(), "test-org", 0.5, 1)
      seedArchive(db, randomUUID(), "test-org", 1.5, 2)

      const result = await handler.handle({ type: "report" }, 12345)
      expect(result).toContain("7天报告")
      expect(result).toContain("总执行")
      expect(result).toContain("总成本")
      expect(result).toContain("$")
    })
  })

  // TC-043: experience search with FTS match
  it("TC-043: handle experience command returns matching results", async () => {
    seedExperience(db, {
      title: "CORS error on API gateway",
      content: "Fix CORS by adding Access-Control-Allow-Origin header",
      keywords: "CORS",
    })

    const result = await handler.handle({ type: "experience", query: "CORS" }, 12345)
    expect(result).toContain("📝")
    expect(result).toContain("CORS")
  })

  it("TC-043b: experience command with empty query asks for keyword", async () => {
    const result = await handler.handle({ type: "experience", query: "" }, 12345)
    expect(result).toContain("请提供搜索关键词")
  })

  it("TC-043c: experience command with no matches shows not-found", async () => {
    const result = await handler.handle({ type: "experience", query: "nonexistentkeyword" }, 12345)
    expect(result).toContain("未找到匹配")
  })

  // TC-049: register command with scheduleDAO
  it("TC-049: handle register command inserts schedule and confirms", async () => {
    const spy = vi.spyOn(scheduleDAO, "insertAgentSchedule")

    const result = await handler.handle({ type: "register", workflow: "bug-hunter", cronDesc: "每天2点" }, 12345)
    expect(result).toContain("已注册")
    expect(result).toContain("bug-hunter")
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy).toHaveBeenCalledWith(
      expect.any(String),
      "test-org",
      "tg-bug-hunter",
      expect.any(String), // cron expression
      "workflow_run",
      expect.stringContaining("bug-hunter"),
      expect.any(String), // ISO timestamp
    )
  })

  // TC-050: register with empty/invalid workflow
  it("TC-050: handle register with empty workflow returns error", async () => {
    const result = await handler.handle({ type: "register", workflow: "", cronDesc: "" }, 12345)
    expect(result).toContain("❌")
    expect(result).toContain("请提供工作流名称")
  })

  it("TC-050b: register with nonexistent workflow still inserts (no validation)", async () => {
    // The handler does NOT validate workflow existence — it just inserts into schedules
    const spy = vi.spyOn(scheduleDAO, "insertAgentSchedule")
    const result = await handler.handle({ type: "register", workflow: "nonexistent-wf", cronDesc: "" }, 12345)
    expect(result).toContain("已注册")
    expect(spy).toHaveBeenCalledTimes(1)
  })

  // TC-051: stop command with executionId
  it("TC-051: handle stop with valid running executionId cancels it", async () => {
    const execId = randomUUID()
    seedExecution(db, execId, "running")

    const result = await handler.handle({ type: "stop", executionId: execId }, 12345)
    expect(result).toContain("🛑")
    expect(result).toContain("已取消")
    expect(result).toContain(execId)

    // Verify DB status changed
    const updated = executionDAO.findById(execId)
    expect(updated).not.toBeNull()
    expect(updated!.status).toBe("cancelled")
  })

  it("TC-051b: stop with nonexistent executionId reports not found", async () => {
    const result = await handler.handle({ type: "stop", executionId: "nonexistent-id" }, 12345)
    expect(result).toContain("🛑")
    expect(result).toContain("执行不存在")
  })

  it("TC-051c: stop with already completed execution reports ended", async () => {
    const execId = randomUUID()
    seedExecution(db, execId, "completed")

    const result = await handler.handle({ type: "stop", executionId: execId }, 12345)
    expect(result).toContain("🛑")
    expect(result).toContain("已结束")
    expect(result).toContain("completed")
  })

  // TC-052: stop without executionId falls through to status
  it("TC-052: handle stop without executionId shows running executions", async () => {
    const execId = randomUUID()
    seedExecution(db, execId, "running")

    const result = await handler.handle({ type: "stop" }, 12345)
    // Falls through to handleStatus which lists running executions
    expect(result).toContain("📊")
    expect(result).toContain("Test Workflow")
    expect(result).toContain(execId.substring(0, 8))
  })

  it("TC-052b: stop without executionId and no running executions shows empty status", async () => {
    const result = await handler.handle({ type: "stop" }, 12345)
    expect(result).toContain("📊")
    expect(result).toContain("当前没有正在运行的执行")
  })

  // TC-053: develop command
  it("TC-053: handle develop command with workflowService and scheduleDAO", async () => {
    const mockWorkflowService = {
      getWorkflow: vi.fn().mockReturnValue({ ref: "feat-dev", name: "Feature Dev" }),
    }
    const devHandler = new TelegramCommandHandler({
      archiveDAO,
      experienceDAO,
      executionDAO,
      scheduleDAO,
      workflowService: mockWorkflowService as any,
      org: "test-org",
    })

    const spy = vi.spyOn(scheduleDAO, "insertAgentSchedule")
    const result = await devHandler.handle({ type: "develop", description: "用户注册功能" }, 12345)
    expect(result).toContain("🚀")
    expect(result).toContain("已启动")
    expect(result).toContain("用户注册功能")
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it("TC-053b: develop with empty description returns error", async () => {
    const result = await handler.handle({ type: "develop", description: "" }, 12345)
    expect(result).toContain("❌")
    expect(result).toContain("请提供开发任务描述")
  })

  it("TC-053c: develop without workflowService returns recorded request", async () => {
    const noServiceHandler = new TelegramCommandHandler({
      archiveDAO,
      experienceDAO,
      executionDAO,
      org: "test-org",
    })
    const result = await noServiceHandler.handle({ type: "develop", description: "test feature" }, 12345)
    expect(result).toContain("🚀")
    expect(result).toContain("已记录开发请求")
    expect(result).toContain("test feature")
  })

  it("TC-053d: develop with workflowService returning null workflow", async () => {
    const mockWorkflowService = {
      getWorkflow: vi.fn().mockReturnValue(null),
    }
    const devHandler = new TelegramCommandHandler({
      archiveDAO,
      experienceDAO,
      executionDAO,
      workflowService: mockWorkflowService as any,
      org: "test-org",
    })

    const result = await devHandler.handle({ type: "develop", description: "test" }, 12345)
    expect(result).toContain("🚀")
    expect(result).toContain("已记录开发请求")
    expect(result).toContain("未找到")
  })

  // Register without scheduleDAO
  it("register without scheduleDAO returns fallback message", async () => {
    const noSchedHandler = new TelegramCommandHandler({
      archiveDAO,
      experienceDAO,
      executionDAO,
      org: "test-org",
    })
    const result = await noSchedHandler.handle({ type: "register", workflow: "test-wf", cronDesc: "每天" }, 12345)
    expect(result).toContain("✅")
    expect(result).toContain("已记录调度请求")
    expect(result).toContain("ScheduleDAO 未配置")
  })

  // Stop with EnginePool mock
  it("stop with enginePool cancel returns immediate confirmation", async () => {
    const mockPool = { cancel: vi.fn().mockReturnValue(true) }
    const poolHandler = new TelegramCommandHandler({
      archiveDAO,
      experienceDAO,
      executionDAO,
      enginePool: mockPool as any,
      org: "test-org",
    })

    const result = await poolHandler.handle({ type: "stop", executionId: "some-exec-id" }, 12345)
    expect(result).toContain("🛑")
    expect(result).toContain("已取消")
    expect(mockPool.cancel).toHaveBeenCalledWith("some-exec-id")
  })

  // Positional constructor
  it("works with positional constructor arguments", async () => {
    const positionalHandler = new TelegramCommandHandler(archiveDAO, experienceDAO, executionDAO)
    const result = await positionalHandler.handle({ type: "scan", scope: "test" }, 12345)
    expect(result).toContain("🚀")
    expect(result).toContain("已启动")
  })
})
