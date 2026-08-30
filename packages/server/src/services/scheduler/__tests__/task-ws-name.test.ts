// task-ws-name — 任务启动 workspace 命名（task:{任务标题}）单元测试 + executor 集成
// (2026-08-29: 取代 taskpool-{scheduleId}-{ts} 的展示名)
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import Database from "better-sqlite3"
import { applySchema } from "../../../db/schema"
import { ScheduleConfigDAO, ScheduleRunDAO, ExecutionDAO, TaskDAO } from "../../../db/dao"
import { WorkflowExecutor } from "../executors/workflow-executor"
import type { SchedulerJob, WorkflowConfig } from "@octopus/shared"
import { taskDisplayTitle, taskWorkspaceName } from "../task-ws-name"

const FIXED = new Date(2026, 7, 29, 16, 45, 12) // 2026-08-29 16:45:12 本地时间

describe("taskDisplayTitle / taskWorkspaceName", () => {
  it("用户改过名 → 直接用 name，带 task: 前缀 + 时间尾缀", () => {
    const name = taskWorkspaceName({ name: "token计费", task_spec: '{"goal":"g"}' }, { date: FIXED })
    expect(name).toBe("task:token计费-0829-164512")
  })

  it("默认名 → 从 goal 生成 chatbot 同款标题（前 20 字 / 换行转空格）", () => {
    const goal = "实现 token 用量跟踪与费用预估：所有\nLLM 调用在 provider 层单一收口记录（含来源）"
    const title = taskDisplayTitle({ name: "Untitled task", task_spec: JSON.stringify({ goal }) })
    expect(title).toBe(goal.slice(0, 20).replace(/\n/g, " ").trim())
    expect([...title].length).toBeLessThanOrEqual(20)
  })

  it("默认名且 goal 空 → null（调用方回退 taskpool 命名）", () => {
    expect(taskWorkspaceName({ name: "Untitled task", task_spec: '{"goal":""}' }, { date: FIXED })).toBeNull()
  })

  it("默认名且 task_spec 坏 JSON → null，不抛", () => {
    expect(taskWorkspaceName({ name: "Untitled task", task_spec: "{oops" }, { date: FIXED })).toBeNull()
  })

  it("子单元名拼接 task:{标题}·{子单元}", () => {
    const name = taskWorkspaceName({ name: "重构网关", task_spec: "{}" }, { subName: "su-a", date: FIXED })
    expect(name).toBe("task:重构网关·su-a-0829-164512")
  })

  it("文件系统保留字符被剥离（name 即目录名）", () => {
    const name = taskWorkspaceName({ name: 'a/b\\c*d?e"f<g>h|i', task_spec: "{}" }, { date: FIXED })
    expect(name).toBe("task:abcdefghi-0829-164512")
  })
})

// ── WorkflowExecutor 集成：task-origin schedule → createFromSpec 收到新名 ──

describe("WorkflowExecutor task:{标题} 命名", () => {
  let db: Database.Database
  const schedId = "nm-s-1"
  const taskId = "nm-task-1"
  const execId = "nm-e-1"
  const mockSSE = { emit: vi.fn() } as never
  const createFromSpecSpy = vi.fn(() => ({ id: "nm-ws", name: "x" }))
  const mockWorkspaceService = { createFromSpec: createFromSpecSpy, delete: vi.fn() } as never

  function seed(taskName: string, goal: string) {
    db.prepare(`
      INSERT INTO tasks (id, org, name, status, task_spec, created_at, updated_at)
      VALUES (?, 'test', ?, 'running', ?, datetime('now'), datetime('now'))
    `).run(taskId, taskName, JSON.stringify({ goal }))
    db.prepare(`
      INSERT INTO schedules (
        id, org, name, cron_expression, timezone, enabled, timeout_seconds, notify_on_failure,
        created_at, updated_at, job_type, config, parallel_policy, version, consecutive_failures,
        max_retain, origin_type, origin_id, status
      ) VALUES (?, 'test', 'sched', NULL, 'UTC', 1, 3600, 0, datetime('now'), datetime('now'),
        'workflow', ?, 'skip', 1, 0, 10, 'task', ?, 'running')
    `).run(schedId, JSON.stringify({
      schema_version: "1.0", type: "workflow",
      workspace_spec: { org: "test", branch_prefix: "taskpool-x", projects: [] },
      workflow_chain: [{ workflow_ref: "wf" }],
    }), taskId)
    db.prepare(`
      INSERT INTO schedule_executions (id, schedule_id, status, trigger_type, triggered_at,
        timezone_offset, timezone_iana, created_at)
      VALUES (?, ?, 'running', 'scheduled', datetime('now'), '+00:00', 'UTC', datetime('now'))
    `).run(execId, schedId)
  }

  function buildJob(): SchedulerJob {
    return {
      id: schedId, name: "sched", job_type: "workflow", cron_expression: null, timezone: "UTC",
      enabled: true, org: "test",
      config: {
        schema_version: "1.0", type: "workflow",
        workspace_spec: { org: "test", branch_prefix: "taskpool-x", projects: [] },
        workflow_chain: [{ workflow_ref: "wf" }],
      } as WorkflowConfig,
      parallel_policy: "skip", timeout_seconds: 3600, notify_on_failure: false,
      version: 1, consecutive_failures: 0, next_trigger_at: null, deleted_at: null,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      status: "running", trigger_source: "requirement",
      origin_type: "task", origin_id: taskId, claimed_at: null, source_chat_session_id: null,
    } as unknown as SchedulerJob
  }

  async function runNaming() {
    const executor = new WorkflowExecutor(
      mockSSE, new ScheduleConfigDAO(db), new ScheduleRunDAO(db), new ExecutionDAO(db),
      mockWorkspaceService, undefined, new TaskDAO(db),
    )
    // 让 execute 走到 createFromSpec 后自然失败（无注册 ExecutionService）即可断言捕获名
    await executor.execute(buildJob(), execId).catch(() => undefined)
    expect(createFromSpecSpy).toHaveBeenCalled()
    return createFromSpecSpy.mock.calls[0][0] as { name: string; branch_prefix: string }
  }

  beforeEach(() => {
    db = new Database(":memory:")
    applySchema(db)
    db.pragma("foreign_keys = OFF")
    createFromSpecSpy.mockClear()
  })
  afterEach(() => db.close())

  it("用户改过名 → task:{name}-{时间}", async () => {
    seed("监控agent context优化", "ignored goal")
    const spec = await runNaming()
    expect(spec.name).toMatch(/^task:监控agent context优化-\d{4}-\d{6}$/)
    // branch_prefix 保持确定性 taskpool-{scheduleId}（git 追溯不变）
    expect(spec.branch_prefix).toBe(`taskpool-${schedId}`)
  })

  it("默认名 → task:{goal前20字}-{时间}", async () => {
    seed("Untitled task", "构建 CLI 工具 cc-context-audit 来诊断上下文膨胀")
    const spec = await runNaming()
    expect(spec.name).toMatch(/^task:构建 CLI 工具 cc-context-\d{4}-\d{6}$/)
  })

  it("无 taskDAO（旧 6 参构造）→ 回退 taskpool-{scheduleId}-{ts}", async () => {
    seed("监控agent context优化", "g")
    const executor = new WorkflowExecutor(
      mockSSE, new ScheduleConfigDAO(db), new ScheduleRunDAO(db), new ExecutionDAO(db),
      mockWorkspaceService,
    )
    await executor.execute(buildJob(), execId).catch(() => undefined)
    expect(createFromSpecSpy).toHaveBeenCalled()
    const spec = createFromSpecSpy.mock.calls[0][0] as { name: string }
    expect(spec.name).toMatch(new RegExp(`^taskpool-${schedId}-\\d{14}-`))
  })

  it("cron 来源（origin_type=cron）→ 不受影响，用 workspace_spec.branch_prefix", async () => {
    db.prepare(`
      INSERT INTO schedules (
        id, org, name, cron_expression, timezone, enabled, timeout_seconds, notify_on_failure,
        created_at, updated_at, job_type, config, parallel_policy, version, consecutive_failures,
        max_retain, origin_type, status
      ) VALUES (?, 'test', 'sched', '0 9 * * *', 'UTC', 1, 3600, 0, datetime('now'), datetime('now'),
        'workflow', ?, 'skip', 1, 0, 10, 'cron', 'running')
    `).run(schedId, JSON.stringify({
      schema_version: "1.0", type: "workflow",
      workspace_spec: { org: "test", branch_prefix: "cron-pfx", projects: [] },
      workflow_chain: [{ workflow_ref: "wf" }],
    }))
    db.prepare(`
      INSERT INTO schedule_executions (id, schedule_id, status, trigger_type, triggered_at,
        timezone_offset, timezone_iana, created_at)
      VALUES (?, ?, 'running', 'scheduled', datetime('now'), '+00:00', 'UTC', datetime('now'))
    `).run(execId, schedId)
    const job = {
      ...buildJob(),
      trigger_source: "cron",
      origin_type: "cron",
      origin_id: null,
      config: {
        schema_version: "1.0", type: "workflow",
        workspace_spec: { org: "test", branch_prefix: "cron-pfx", projects: [] },
        workflow_chain: [{ workflow_ref: "wf" }],
      } as unknown as WorkflowConfig,
    } as unknown as SchedulerJob
    const executor = new WorkflowExecutor(
      mockSSE, new ScheduleConfigDAO(db), new ScheduleRunDAO(db), new ExecutionDAO(db),
      mockWorkspaceService, undefined, new TaskDAO(db),
    )
    await executor.execute(job, execId).catch(() => undefined)
    expect(createFromSpecSpy).toHaveBeenCalled()
    const spec = createFromSpecSpy.mock.calls[0][0] as { name: string }
    expect(spec.name).toMatch(/^cron-pfx-\d{14}-/)
  })
})
