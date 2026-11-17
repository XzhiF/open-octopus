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
import { CabinService } from "../cabin-service"
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
/** listJobsView 的 agent_running 桩：模拟主线程 chat 流。 */
let streamingSessions: Set<string>

function insertCabin(id: string): void {
  cabinDAO.insert({
    id, name: `舱${id}`, path: path.join(tmpDir, id), workspace_id: "ws-1",
    main_session_id: "s-main", requirements: "", status: "active",
    mainline_strategy: "clean-main", org: "org", init_state: null, cockpit_prefs: null,
    version: 1, created_at: NOW, updated_at: NOW,
    last_active_at: NOW, archived_at: null, deleted_at: null,
  })
}

function insertTask(id: string, cabinId: string, status = "running"): void {
  db.prepare(`
    INSERT INTO tasks (id, repo_group, name, status, task_spec, cabin_id, created_at, updated_at)
    VALUES (?, 'repo-a', ?, ?, '{}', ?, ?, ?)
  `).run(id, `任务${id}`, status, cabinId, NOW, NOW)
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
  streamingSessions = new Set()
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
    isSessionStreaming: (sessionId: string) => streamingSessions.has(sessionId),
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

  it("多个任务并发提问 → 每条都进 answer，答掉一条不影响另一条", () => {
    insertTask("t1", "c1")
    insertTask("t2", "c1")
    const s1 = getSessionService().createSession({ cwd: tmpDir })
    const s2 = getSessionService().createSession({ cwd: tmpDir })
    agentSessionDAO.updateSession(s1.id, { cabin_id: "c1", title: "任务A" })
    agentSessionDAO.updateSession(s2.id, { cabin_id: "c1", title: "任务B" })
    db.prepare("UPDATE tasks SET source_chat_session_id = ? WHERE id = 't1'").run(s1.id)
    db.prepare("UPDATE tasks SET source_chat_session_id = ? WHERE id = 't2'").run(s2.id)

    agentSessionDAO.insertMessage({
      id: "ask-a", session_id: s1.id, role: "assistant", content: "问",
      metadata: JSON.stringify({ displayType: "ask_user_question", questions: [{ question: "A 的范围？" }] }),
      created_at: NOW,
    })
    agentSessionDAO.insertMessage({
      id: "ask-b", session_id: s2.id, role: "assistant", content: "问",
      metadata: JSON.stringify({ displayType: "ask_user_question", questions: [{ question: "B 的验收？" }] }),
      created_at: "2026-11-12T10:00:30.000Z",
    })

    let { view } = svc.getView("c1")
    const asks = view.attention.filter((a) => a.stage === "answer")
    expect(asks.map((a) => a.question)).toEqual(expect.arrayContaining(["A 的范围？", "B 的验收？"]))
    expect(asks).toHaveLength(2)

    // 只答 A：A 消失，B 仍在。
    agentSessionDAO.insertMessage({
      id: "ans-a", session_id: s1.id, role: "user",
      content: "用户回答了以下问题：A 的范围", created_at: "2026-11-12T10:01:00.000Z",
    })
    view = svc.getView("c1").view
    const left = view.attention.filter((a) => a.stage === "answer")
    expect(left).toHaveLength(1)
    expect(left[0].question).toBe("B 的验收？")
  })

  it("卡片 metadata 有 activity.decision（就地作答）→ 不再进「待回答」", () => {
    const session = getSessionService().createSession({ cwd: tmpDir })
    agentSessionDAO.updateSession(session.id, { cabin_id: "c1", title: "作者会话" })
    insertTask("t1", "c1")
    db.prepare("UPDATE tasks SET source_chat_session_id = ? WHERE id = 't1'").run(session.id)

    agentSessionDAO.insertMessage({
      id: "ask-decided", session_id: session.id, role: "assistant", content: "问",
      metadata: JSON.stringify({
        displayType: "ask_user_question",
        questions: [{ question: "确认吗？" }],
        activity: { decision: { id: "answer_author_ask", label: "已回答" } },
      }),
      created_at: NOW,
    })
    const { view } = svc.getView("c1")
    expect(view.attention.some((a) => a.stage === "answer")).toBe(false)
  })

  it("决策账本已答 → 作者线程原卡跨会话消项（不再一轮轮累积）", () => {
    const session = getSessionService().createSession({ cwd: tmpDir })
    agentSessionDAO.updateSession(session.id, { cabin_id: "c1", title: "作者会话" })
    insertTask("t1", "c1")
    db.prepare("UPDATE tasks SET source_chat_session_id = ? WHERE id = 't1'").run(session.id)

    // 作者线程原卡（tool_calls 形态）。
    agentSessionDAO.insertMessage({
      id: "ask-ledger", session_id: session.id, role: "assistant", content: "问",
      tool_calls: JSON.stringify({
        tool_calls: [{
          id: "tc-1", name: "AskUserQuestion", status: "done",
          input: { questions: [{ question: "账本题？" }] },
        }],
      }),
      created_at: NOW,
    })
    // 舱主会话里的镜像卡：同一 askId，指向原卡。
    agentSessionDAO.insertMessage({
      id: "mirror-1", session_id: "s-main", role: "assistant", content: "镜像",
      metadata: JSON.stringify({
        displayType: "ask_user_question",
        questions: [{ question: "账本题？" }],
        activity: { payload: { authorAsk: true, askMessageId: "ask-ledger", taskName: "任务t1" } },
      }),
      created_at: NOW,
    })

    let view = svc.getView("c1").view
    // 镜像卡和原卡是同一张提问：只投一次。
    expect(view.attention.filter((a) => a.stage === "answer")).toHaveLength(1)

    // cockpit 提交决策：账本先落，镜像卡与作者线程都不必再留「待回答」。
    db.prepare(`
      INSERT INTO cabin_job_events (id, job_id, cabin_id, kind, actor, payload, created_at)
      VALUES ('ev-ledger', 'job-1', 'c1', 'decision', 'human', ?, ?)
    `).run(JSON.stringify({ askId: "ask-ledger", choice: "确认" }), NOW)

    view = svc.getView("c1").view
    expect(view.attention.some((a) => a.stage === "answer")).toBe(false)
  })

  it("attention 带 ask 信封：决策 / 选项 / 建议 / 作者会话（design 26）", () => {
    const session = getSessionService().createSession({ cwd: tmpDir })
    agentSessionDAO.updateSession(session.id, { cabin_id: "c1", title: "作者会话" })
    insertTask("t1", "c1")
    db.prepare("UPDATE tasks SET source_chat_session_id = ? WHERE id = 't1'").run(session.id)

    // 作者线程原卡（只有 tool_calls，没有信封）。
    agentSessionDAO.insertMessage({
      id: "ask-env", session_id: session.id, role: "assistant", content: "问",
      tool_calls: JSON.stringify({
        tool_calls: [{
          id: "tc-1", name: "AskUserQuestion", status: "done",
          input: { questions: [{ question: "接哪个渠道？", options: [{ label: "支付宝", description: "账号现成" }] }] },
        }],
      }),
      created_at: NOW,
    })
    // 舱主会话镜像卡：同一 askId，带完整富化信封。
    agentSessionDAO.insertMessage({
      id: "mirror-env", session_id: "s-main", role: "user", content: "镜像",
      metadata: JSON.stringify({
        displayType: "event",
        activity: {
          payload: {
            authorAsk: true, askMessageId: "ask-env", authorSessionId: session.id,
            taskName: "任务t1", origin: "session",
            decision: "接哪个渠道", intent: "接通支付",
            options: [{ label: "支付宝", impact: "3 天" }],
            recommendation: { label: "支付宝", reason: "账号现成" },
            blocking: true, phase: { index: 2, round: 1 },
            questions: { questions: [{ question: "接哪个渠道？" }] },
          },
        },
      }),
      created_at: NOW,
    })

    const ask = svc.getView("c1").view.attention.find((a) => a.stage === "answer")
    expect(ask?.ask?.ask_id).toBe("ask-env")
    // 镜像卡优先：回执锚点指向主会话那张，而不是作者线程原卡。
    expect(ask?.ask?.message_id).toBe("mirror-env")
    expect(ask?.ask?.author_session_id).toBe(session.id)
    expect(ask?.ask?.decision).toBe("接哪个渠道")
    expect(ask?.ask?.options?.[0]).toEqual({ label: "支付宝", impact: "3 天" })
    expect(ask?.ask?.recommendation).toEqual({ label: "支付宝", reason: "账号现成" })
    expect(ask?.ask?.blocking).toBe(true)
    expect(ask?.ask?.phase).toEqual({ index: 2, round: 1 })
    expect(Array.isArray((ask?.ask?.questions as { questions?: unknown[] })?.questions)).toBe(true)
  })

  it("工作流 pending_interaction 不带 ask 票据（v1 不开问答窗）", () => {
    insertTask("t1", "c1")
    insertExecution("e-ask", "t1", "pending_interaction")
    db.prepare(`
      INSERT INTO interaction_messages (id, execution_id, node_id, role, type, content, metadata, created_at)
      VALUES ('im-1', 'e-ask', 'n1', 'assistant', 'question', '', ?, ?)
    `).run(JSON.stringify({
      displayType: "ask_user_question",
      questions: [{ question: "工作流问？" }],
    }), NOW)

    const ask = svc.getView("c1").view.attention.find((a) => a.stage === "answer")
    expect(ask?.question).toBe("工作流问？")
    expect(ask?.ask).toBeUndefined()
  })

  it("agent-chat 落库只有 tool_calls（无 displayType）→ 仍进「待回答」", () => {
    // design 23 §2：任务作者走 /api/agent/sessions/:id/chat，修好前 metadata
    // 没有 displayType；老行也必须能靠 tool_calls 兜住。
    const session = getSessionService().createSession({ cwd: tmpDir })
    agentSessionDAO.updateSession(session.id, { cabin_id: "c1", title: "作者会话" })
    insertTask("t1", "c1")
    db.prepare("UPDATE tasks SET source_chat_session_id = ? WHERE id = 't1'").run(session.id)

    agentSessionDAO.insertMessage({
      id: "ask-tc", session_id: session.id, role: "assistant", content: "问",
      tool_calls: JSON.stringify({
        tool_calls: [{
          id: "tc-1", name: "AskUserQuestion", status: "fail",
          input: { questions: [{ question: "走哪个通道？" }] },
        }],
      }),
      created_at: NOW,
    })
    const { view } = svc.getView("c1")
    const ask = view.attention.find((a) => a.stage === "answer")
    expect(ask?.question).toBe("走哪个通道？")
    expect(ask?.task_id).toBe("t1")
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

  it("person-first：待人的作业排在纯 attention 前，组内保持输入顺序", () => {
    insertTask("t1", "c1", "awaiting_review")
    insertTask("t2", "c1", "awaiting_review")
    svc.dispatchJob("c1", { kind: "task", ref_id: "t1", title: "先" })
    svc.dispatchJob("c1", { kind: "task", ref_id: "t2", title: "后" })
    const { view } = svc.getView("c1")
    expect(view.attention.map((a) => a.task_id)).toEqual(["t1", "t2"])
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

describe("claim 队列（P4-6）", () => {
  it("FIFO：按 created_at 升序领取", () => {
    insertTask("t-early", "c1")
    insertTask("t-mid", "c1")
    insertTask("t-late", "c1")
    insertExecution("e-late", "t-late", "pending", "2026-11-12T09:30:00.000Z")
    insertExecution("e-early", "t-early", "pending", "2026-11-12T08:00:00.000Z")
    insertExecution("e-mid", "t-mid", "pending", "2026-11-12T09:00:00.000Z")

    const rows = executionDAO.listClaimableTaskLaunches(10)
    expect(rows.map((r) => r.id)).toEqual(["e-early", "e-mid", "e-late"])
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
describe("listJobsView · agent_running（编队「作者在推进」）", () => {
  it("任务主线程在流式 → agent_running=true；生命周期 status 不被改写", () => {
    insertTask("t1", "c1", "ready")
    cabinDAO.insertJob({
      id: "j1", cabin_id: "c1", kind: "task", ref_id: "t1", session_id: "s-author",
      title: "作业一", mandate: null, prompt: null,
      created_at: NOW, ended_at: null,
    })

    const before = svc.listJobsView("c1")[0]
    expect(before.agent_running).toBe(false)
    expect(before.status).toBe("ready")

    streamingSessions.add("s-author")
    const after = svc.listJobsView("c1")[0]
    expect(after.agent_running).toBe(true)
    // 派生态只表达「主线程在跑」，不冒充任务开始执行（K3）。
    expect(after.status).toBe("ready")
  })
})

describe("gatherAsks · 旧卡 / 忽略 / 标题兜底（2026-11-16）", () => {
  const LATER = "2026-11-12T10:01:00.000Z"
  const toolCalls = JSON.stringify([{
    name: "AskUserQuestion",
    input: { questions: [{ question: "旧问题？", header: "q", multiSelect: false, options: [] }] },
  }])

  it("原生提问后又有 assistant 消息 → 视为旧账，不再进 attention", () => {
    agentSessionDAO.insertMessage({
      id: "ask-old", session_id: "s-main", role: "assistant", content: "问",
      created_at: NOW, tool_calls: toolCalls,
    })
    agentSessionDAO.insertMessage({
      id: "later", session_id: "s-main", role: "assistant", content: "继续推进",
      created_at: LATER,
    })
    const { view } = svc.getView("c1")
    expect(view.attention.some((a) => a.question === "旧问题？")).toBe(false)
  })

  it("没有后续 assistant → 仍待答；dismissAsk 写回 decision 后消项", () => {
    agentSessionDAO.insertMessage({
      id: "ask-live", session_id: "s-main", role: "assistant", content: "问",
      created_at: NOW, tool_calls: toolCalls,
    })
    let { view } = svc.getView("c1")
    const ask = view.attention.find((a) => a.question === "旧问题？")
    expect(ask?.ask?.ask_id).toBe("ask-live")

    expect(svc.dismissAsk("c1", "ask-live")).toEqual({ dismissed: 1 })
    ;({ view } = svc.getView("c1"))
    expect(view.attention.some((a) => a.question === "旧问题？")).toBe(false)
  })

  it("会话标题「undefined · 舱主对话」→ 展示名去掉占位前缀", () => {
    agentSessionDAO.updateSession("s-main", { title: "undefined · 舱主对话" })
    agentSessionDAO.insertMessage({
      id: "ask-title", session_id: "s-main", role: "assistant", content: "问",
      created_at: NOW, tool_calls: toolCalls,
    })
    const { view } = svc.getView("c1")
    const ask = view.attention.find((a) => a.question === "旧问题？")
    expect(ask?.title).toBe("舱主对话 · 待回答")
  })
})
