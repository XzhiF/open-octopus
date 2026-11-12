// Cabin P4：迭代 CRUD（解绑级联）+ attention gather（C4）+ usage 聚合（C7 防双算）
// + claim 优先级/聚焦排序（C8）+ autonomy gate（C5）。真实 DB（applySchema）。
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import Database from "better-sqlite3"
import fs from "fs"
import path from "path"
import os from "os"
import { applySchema } from "../../../db/schema"
import {
  CabinDAO, WorkspaceDAO, AgentSessionDAO, TaskDAO, ExecutionDAO, AcceptanceDAO,
} from "../../../db/dao"
import { TokenUsageDAO } from "../../../db/dao/token-usage-dao"
import { ExecutionLinkDAO } from "../../../db/dao/execution-link-dao"
import { IncidentStore } from "../../supervision/incident-store"
import { initSessionService, getSessionService } from "../../agent/session-service"
import { CabinService, CabinNotFoundError } from "../cabin-service"
import { clearCabinFindingScopeCache } from "../cabin-knowledge"
import { cabinAutonomy, cabinDispatchDecision } from "../../chat/cabin-tools"
import type { FindingOpsService } from "../../knowledge/findings"
import type { TasksService } from "../../tasks/tasks-service"
import type { FindingRow } from "../../../db/dao/findings-dao"

const NOW = "2026-11-12T10:00:00.000Z"

let db: Database.Database
let cabinDAO: CabinDAO
let taskDAO: TaskDAO
let executionDAO: ExecutionDAO
let agentSessionDAO: AgentSessionDAO
let incidentStore: IncidentStore
let svc: CabinService
let tmpDir: string
let findingsStub: FindingRow[]

function insertCabin(id: string): void {
  cabinDAO.insert({
    id, name: `舱${id}`, path: path.join(tmpDir, id), workspace_id: "ws-1",
    main_session_id: "s-main", requirements: "", status: "active",
    mainline_strategy: "clean-main", org: "org", init_state: null, cockpit_prefs: null,
    focused_job_id: null, version: 1, created_at: NOW, updated_at: NOW,
    last_active_at: NOW, archived_at: null,
  })
}

function insertTask(id: string, cabinId: string, status = "running", iterationId: string | null = null): void {
  db.prepare(`
    INSERT INTO tasks (id, repo_group, name, status, task_spec, cabin_id, iteration_id, created_at, updated_at)
    VALUES (?, 'repo-a', ?, ?, '{}', ?, ?, ?, ?)
  `).run(id, `任务${id}`, status, cabinId, iterationId, NOW, NOW)
}

function insertExecution(id: string, taskId: string | null, status: string, createdAt = NOW): void {
  db.prepare(`
    INSERT INTO executions (id, workspace_id, workflow_ref, workflow_name, status, task_id, created_at, updated_at)
    VALUES (?, 'ws-1', 'wf', 'WF', ?, ?, ?, ?)
  `).run(id, status, taskId, createdAt, createdAt)
}

function insertLlmCall(id: string, sessionId: string | null, executionId: string | null, input: number, output: number): void {
  db.prepare(`
    INSERT INTO llm_calls (id, session_id, execution_id, turn_index, call_index, timestamp, duration_ms, input_tokens, output_tokens)
    VALUES (?, ?, ?, 0, 0, ?, 100, ?, ?)
  `).run(id, sessionId, executionId, Date.parse(NOW), input, output)
}

beforeEach(() => {
  db = new Database(":memory:")
  applySchema(db)
  cabinDAO = new CabinDAO(db)
  taskDAO = new TaskDAO(db)
  executionDAO = new ExecutionDAO(db)
  agentSessionDAO = new AgentSessionDAO(db)
  incidentStore = new IncidentStore(db)
  initSessionService(agentSessionDAO)
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cabin-p4-test-"))
  findingsStub = []
  clearCabinFindingScopeCache()
  svc = new CabinService(cabinDAO)
  svc.bindInfra({
    workspaceService: { create: vi.fn() } as never,
    workspaceDAO: new WorkspaceDAO(db),
    agentSessionDAO,
    taskDAO,
    executionDAO,
    acceptanceDAO: new AcceptanceDAO(db),
    incidentStore,
    findingOps: {
      root: tmpDir,
      list: (status?: string) => findingsStub.filter((f) => !status || f.status === status),
    } as unknown as FindingOpsService,
    tokenUsageDAO: new TokenUsageDAO(db),
    execLinks: new ExecutionLinkDAO(db),
    tasksService: {
      taskUsage: (taskId: string) => {
        // 真实 taskUsage 内部已在 tasks-service 测试覆盖；这里给确定摘要验证舱级合并。
        const calls = db.prepare(
          "SELECT COUNT(*) n FROM llm_calls WHERE session_id IN (SELECT source_chat_session_id FROM tasks WHERE id = ?) AND execution_id IS NULL",
        ).get(taskId) as { n: number }
        return {
          summary: {
            totalCalls: calls.n,
            usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheCreationTokens: 0 },
            totals: { tokens: 150, cost: { usd: null, complete: false }, cacheHitRate: null },
          },
          timing: { duration_ms: 1000 },
        }
      },
    } as unknown as TasksService,
  })
  db.prepare(`
    INSERT INTO workspaces (id, name, repo_group, path, source, status, created_at, updated_at)
    VALUES ('ws-1', '舱测试工作区', 'repo-a', ?, 'user', 'active', ?, ?)
  `).run(tmpDir, NOW, NOW)
  db.prepare(`
    INSERT INTO sessions (id, title, cwd, cabin_id, created_at, updated_at)
    VALUES ('s-main', '舱主会话', ?, 'c1', ?, ?), ('s-author', '作者会话', ?, NULL, ?, ?)
  `).run(tmpDir, NOW, NOW, tmpDir, NOW, NOW)
  insertCabin("c1")
})

afterEach(() => {
  db.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe("迭代 CRUD（P4-1）", () => {
  it("create → update（改名/计划态/重排）→ delete 解绑成员任务", () => {
    const it1 = svc.createIteration("c1", { code: "M1", name: "渠道接入" })
    const it2 = svc.createIteration("c1", { code: "M2", name: "对账", sort_order: 1 })
    insertTask("t1", "c1", "running", it1.id)
    insertTask("t2", "c1", "done", it1.id)

    const updated = svc.updateIteration("c1", it1.id, { name: "渠道接入 v2", status: "active" })
    expect(updated.name).toBe("渠道接入 v2")
    expect(updated.status).toBe("active")

    // 进度派生自成员任务（K3）
    const { view } = svc.getView("c1")
    const m1 = view.iterations.find((i) => i.id === it1.id)!
    expect(m1.task_count).toBe(2)
    expect(m1.progress).toBe(50)

    const res = svc.deleteIteration("c1", it1.id)
    expect(res.unbound).toBe(2)
    expect(taskDAO.getById("t1")!.iteration_id).toBeNull()
    expect(taskDAO.getById("t2")!.iteration_id).toBeNull()
    expect(svc.listIterations("c1").map((i) => i.id)).toEqual([it2.id])
  })

  it("跨舱操作迭代 → CabinNotFoundError（所有权守卫）", () => {
    insertCabin("c2")
    const it1 = svc.createIteration("c1", { code: "M1", name: "x" })
    expect(() => svc.updateIteration("c2", it1.id, { name: "y" })).toThrow(CabinNotFoundError)
    expect(() => svc.deleteIteration("c2", it1.id)).toThrow(CabinNotFoundError)
  })
})

describe("attention gather（P4-3 / C4）", () => {
  it("pending_approval 执行 → approval；waiting_human incident → blocked", () => {
    // ux_exec_task_active：一任务至多一条活执行，两个信号分属两任务。
    insertTask("t1", "c1")
    insertTask("t2", "c1")
    insertExecution("e1", "t1", "pending_approval")
    insertExecution("e2", "t2", "running")
    const inc = incidentStore.open({
      executionId: "e2", workspaceId: "ws-1", nodeId: "n1",
      phase: "before_retry", severity: "warning", kind: "stupid_retry",
      summary: "同一错误反复", evidence: [], contextRef: "execution:e2/node:n1",
      allowedActions: ["proceed", "retry", "escalate"],
    })
    incidentStore.markWaitingHuman(inc.id, "human")

    const { view } = svc.getView("c1")
    const stages = view.attention.map((a) => `${a.stage}:${a.id}`)
    expect(stages).toContain("approval:approval-e1")
    expect(stages).toContain(`blocked:incident-${inc.id}`)
    expect(view.attention.every((a) => a.awaiting === "person")).toBe(true)
  })

  it("pending_interaction 执行 → answer（带问题文本）", () => {
    insertTask("t1", "c1")
    insertExecution("e1", "t1", "pending_interaction")
    db.prepare(`
      INSERT INTO interaction_messages (id, execution_id, node_id, role, content, metadata, created_at)
      VALUES ('m1', 'e1', 'n1', 'assistant', '问', ?, ?)
    `).run(JSON.stringify({ displayType: "ask_user_question", questions: [{ question: "用哪个渠道？" }] }), NOW)

    const { view } = svc.getView("c1")
    const ask = view.attention.find((a) => a.stage === "answer")
    expect(ask).toBeTruthy()
    expect(ask!.question).toBe("用哪个渠道？")
    expect(ask!.task_id).toBe("t1")
  })

  it("舱会话末条未答 ask → answer；其后有用户回答 → 消失", () => {
    const session = getSessionService().createSession({ cwd: tmpDir })
    agentSessionDAO.updateSession(session.id, { cabin_id: "c1", title: "作者会话" })
    insertTask("t1", "c1")
    db.prepare("UPDATE tasks SET source_chat_session_id = ? WHERE id = 't1'").run(session.id)

    agentSessionDAO.insertMessage({
      id: "ask1", session_id: session.id, role: "assistant", content: "问",
      metadata: JSON.stringify({ displayType: "ask_user_question", questions: [{ question: "确认吗？" }] }),
      created_at: NOW,
    })
    let { view } = svc.getView("c1")
    expect(view.attention.some((a) => a.stage === "answer" && a.question === "确认吗？")).toBe(true)

    agentSessionDAO.insertMessage({
      id: "ans1", session_id: session.id, role: "user",
      content: "用户回答了以下问题：确认", created_at: "2026-11-12T10:01:00.000Z",
    })
    view = svc.getView("c1").view
    expect(view.attention.some((a) => a.stage === "answer")).toBe(false)
  })

  it("open findings（G4 scoped）→ adjudicate + open_findings 计数", () => {
    fs.mkdirSync(path.join(tmpDir, "raw", "archives"), { recursive: true })
    fs.writeFileSync(
      path.join(tmpDir, "raw", "archives", "f1.md"),
      "---\norigin: task-archive:t1\n---\nbody\n", "utf-8",
    )
    insertTask("t1", "c1")
    findingsStub = [{
      id: "f1", kind: "contradiction", status: "open", title: "口径矛盾",
      detail: "{}", pages: "[]", raw_ref: "archives/f1.md", source: "compile",
      created_at: NOW, updated_at: NOW,
    }]
    const { view } = svc.getView("c1")
    expect(view.open_findings).toBe(1)
    const adj = view.attention.find((a) => a.stage === "adjudicate")
    expect(adj?.deep_link).toBe("finding:f1")
  })

  it("person-first + priority 排序：高优先作业排前", () => {
    insertTask("t1", "c1", "awaiting_review")
    insertTask("t2", "c1", "awaiting_review")
    svc.dispatchJob("c1", { kind: "task", ref_id: "t2", title: "高优先", priority: 5 })
    const { view } = svc.getView("c1")
    expect(view.attention[0].task_id).toBe("t2")
    expect(view.attention[0].priority).toBe(5)
  })
})

describe("usage 聚合（P4-5 / C7）", () => {
  it("chat execution_id IS NULL 防双算 + byJob + 子代理单列 + grand 各算一次", () => {
    // 主会话：chat 行（计入）+ 带 execution_id 的行（chat 口径排除）
    insertLlmCall("l1", "s-main", null, 100, 50)
    insertLlmCall("l2", "s-main", "e-x", 999, 999)
    // 任务 t1：作者会话 chat + 执行
    insertTask("t1", "c1")
    db.prepare("UPDATE tasks SET source_chat_session_id = 's-author' WHERE id = 't1'").run()
    insertExecution("e1", "t1", "completed")
    insertLlmCall("l3", "s-author", null, 10, 5)
    insertLlmCall("l4", "s-author", "e1", 200, 100)
    // workflow 作业
    insertExecution("e-wf", null, "completed")
    svc.dispatchJob("c1", { kind: "workflow", ref_id: "e-wf", title: "对账流" })
    insertLlmCall("l5", null, "e-wf", 30, 20)
    // 子代理（主会话派生）
    db.prepare(`
      INSERT INTO subagent_runs (id, session_id, agent_type, description, status, model, started_at,
        input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, created_at, updated_at)
      VALUES ('r1', 's-main', 'explore', '调研', 'completed', 'm', ?, 30, 20, 0, 0, ?, ?)
    `).run(NOW, NOW, NOW)

    const u = svc.usage("c1")
    // 主对话 chat 口径：只 l1（l2 带 execution_id 被排除）
    const chat = u.byJob.find((j) => j.kind === "chat")!
    expect(chat.totalCalls).toBe(1)
    expect(chat.totals.tokens).toBe(150)
    // task 行来自 taskUsage 摘要（stub 150）
    const task = u.byJob.find((j) => j.kind === "task")!
    expect(task.totals.tokens).toBe(150)
    // workflow 行：l5
    const wf = u.byJob.find((j) => j.kind === "workflow")!
    expect(wf.totals.tokens).toBe(50)
    // 子代理单列：50 tok，不进 llm_calls 口径
    expect(u.subagents.count).toBe(1)
    expect(u.subagents.tokens).toBe(50)
    expect(u.summary.totals.tokens).toBe(350) // 150+150+50
    // grand = llm + 子代理（各一次）
    expect(u.grand.totals.tokens).toBe(400)
    expect(u.grand.totalCalls).toBe(4) // 3 llm + 1 subagent
    expect(u.timing.duration_ms).toBe(1000)
  })

  it("无 infra 数据时诚实空形（不伪造）", () => {
    const u = svc.usage("c1")
    expect(u.grand.totals.tokens).toBe(0)
    expect(u.byJob.find((j) => j.kind === "chat")?.totalCalls).toBe(0)
    expect(u.subagents.count).toBe(0)
  })
})

describe("claim 优先级 + 聚焦（P4-6 / C8）", () => {
  it("priority DESC 优先，同级 FIFO；无舱作业行为同旧", () => {
    insertTask("t-low", "c1")
    insertTask("t-high", "c1")
    insertTask("t-plain", "c1")
    svc.dispatchJob("c1", { kind: "task", ref_id: "t-low", title: "低", priority: 1 })
    svc.dispatchJob("c1", { kind: "task", ref_id: "t-high", title: "高", priority: 9 })
    insertExecution("e-low", "t-low", "pending", "2026-11-12T09:00:00.000Z")
    insertExecution("e-high", "t-high", "pending", "2026-11-12T09:30:00.000Z")
    insertExecution("e-plain", "t-plain", "pending", "2026-11-12T08:00:00.000Z")

    const rows = executionDAO.listClaimableTaskLaunches(10)
    expect(rows.map((r) => r.id)).toEqual(["e-high", "e-low", "e-plain"])
  })

  it("聚焦作业最先 + focusedClaimableTaskLaunch 命中", () => {
    insertTask("t1", "c1")
    insertTask("t2", "c1")
    const j1 = svc.dispatchJob("c1", { kind: "task", ref_id: "t1", title: "一", priority: 9 })
    svc.dispatchJob("c1", { kind: "task", ref_id: "t2", title: "二", priority: 0 })
    insertExecution("e1", "t1", "pending", "2026-11-12T09:00:00.000Z")
    insertExecution("e2", "t2", "pending", "2026-11-12T08:00:00.000Z")

    svc.setFocus("c1", 1, j1.id)
    // e2 虽早且无聚焦，但聚焦的 e1 排最前（即使 priority 低于其他聚焦外作业也抢占）
    const rows = executionDAO.listClaimableTaskLaunches(10)
    expect(rows[0].id).toBe("e1")
    expect(executionDAO.focusedClaimableTaskLaunch()?.id).toBe("e1")

    svc.setFocus("c1", 2, null)
    expect(executionDAO.focusedClaimableTaskLaunch()).toBeNull()
    expect(executionDAO.listClaimableTaskLaunches(10)[0].id).toBe("e1") // priority 9 仍最先
  })
})

describe("autonomy gate（P4-4 / C5）", () => {
  it("cockpit_prefs.autonomy 解析：缺省 auto / 坏 JSON auto", () => {
    expect(cabinAutonomy(null)).toBe("auto")
    expect(cabinAutonomy("{}")).toBe("auto")
    expect(cabinAutonomy('{"autonomy":"observe"}')).toBe("observe")
    expect(cabinAutonomy('{"autonomy":"off"}')).toBe("off")
    expect(cabinAutonomy('{"autonomy":"weird"}')).toBe("auto")
    expect(cabinAutonomy("not-json")).toBe("auto")
  })

  it("决策矩阵：explicit 恒派发；inferred auto 派发 / observe 确认 / off 阻断", () => {
    expect(cabinDispatchDecision("auto", "explicit")).toBe("dispatch")
    expect(cabinDispatchDecision("observe", "explicit")).toBe("dispatch")
    expect(cabinDispatchDecision("off", "explicit")).toBe("dispatch")
    expect(cabinDispatchDecision("auto", "inferred")).toBe("dispatch")
    expect(cabinDispatchDecision("observe", "inferred")).toBe("needs_confirmation")
    expect(cabinDispatchDecision("off", "inferred")).toBe("blocked")
  })
})