// design 25 §7.1 / §9.7：决策端点与委派端点的路由形状。
//
// 浏览器不再直接对 doer 发流：提交走 POST /api/cabins/:id/decisions，
// 服务端校验票据 + 落库 + 排队唤醒 + 返回 receipt。
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import Database from "better-sqlite3"
import fs from "fs"
import path from "path"
import os from "os"
import { Hono } from "hono"
import { randomUUID } from "crypto"
import { applySchema } from "../../db/schema"
import {
  CabinDAO, WorkspaceDAO, AgentSessionDAO, TaskDAO, ExecutionDAO, AcceptanceDAO,
} from "../../db/dao"
import { CabinDelegationDAO } from "../../db/dao/cabin-delegation-dao"
import { WorkspaceService } from "../../services/workspace"
import { initSessionService } from "../../services/agent/session-service"
import { SSEService } from "../../services/sse"
import { CabinService } from "../../services/cabin/cabin-service"
import { CabinInitService } from "../../services/cabin/cabin-init-service"
import { CabinCommService } from "../../services/cabin/cabin-comm-service"
import { CabinDecisionService } from "../../services/cabin/cabin-decision-service"
import { CabinDelegationService } from "../../services/cabin/cabin-delegation-service"
import { createCabinRoutes } from "../cabins"

const NOW = "2026-11-16T10:00:00.000Z"

describe("/api/cabins decisions + delegations", () => {
  let db: Database.Database
  let app: Hono
  let tmpDir: string
  let cabinId: string

  const post = (url: string, body: unknown) =>
    app.request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })

  function askCard(askId: string): void {
    const activity = {
      kind: "cabin.author_ask", severity: "info", title: "#1 支付回调 在问你",
      message: "走哪个通道？", workspaceId: null, taskId: null, status: "awaiting_input",
      payload: {
        authorAsk: true, askMessageId: askId, authorSessionId: "s-doer",
        cabinId, taskId: null, taskName: "支付回调",
        subject: { kind: "delegation", id: "d-ask" },
        handle: "D1", blocking: true,
        options: [{ label: "短信" }, { label: "邮件" }],
        questions: { questions: [{ question: "走哪个通道？", header: "通道", options: [{ label: "短信" }, { label: "邮件" }] }] },
      },
    }
    db.prepare(
      "INSERT INTO messages (id, session_id, role, content, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(randomUUID(), "s-main", "user", "提问", JSON.stringify({ displayType: "event", activity }), NOW)
  }

  beforeEach(() => {
    db = new Database(":memory:")
    applySchema(db)
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cabin-dec-routes-"))
    cabinId = "c1"
    db.prepare(`
      INSERT INTO cabins (id, name, path, status, main_session_id, org, version, created_at, updated_at)
      VALUES (?, '路由舱', ?, 'active', 's-main', 'org', 1, ?, ?)
    `).run(cabinId, tmpDir, NOW, NOW)
    db.prepare(`
      INSERT INTO sessions (id, org, title, session_type, is_active, is_deleted, created_at, updated_at)
      VALUES ('s-main', 'org', 'main', 'main', 1, 0, ?, ?)
    `).run(NOW, NOW)
    db.prepare(`
      INSERT INTO sessions (id, org, title, session_type, is_active, is_deleted, created_at, updated_at)
      VALUES ('s-doer', 'org', 'doer', 'main', 1, 0, ?, ?)
    `).run(NOW, NOW)

    const dao = new CabinDAO(db)
    const sse = new SSEService()
    const agentSessionDAO = new AgentSessionDAO(db)
    initSessionService(agentSessionDAO)
    const svc = new CabinService(dao)
    const initService = new CabinInitService({ cabin: dao, sse, runOrchestratorTurn: vi.fn(async () => {}) })
    const delegationDAO = new CabinDelegationDAO(db)
    svc.bindInfra({
      workspaceService: new WorkspaceService(new WorkspaceDAO(db)),
      workspaceDAO: new WorkspaceDAO(db),
      agentSessionDAO,
      taskDAO: new TaskDAO(db),
      executionDAO: new ExecutionDAO(db),
      acceptanceDAO: new AcceptanceDAO(db),
      initService,
      cabinDelegationDAO: delegationDAO,
    })
    const comm = new CabinCommService({
      cabin: dao,
      taskDAO: new TaskDAO(db),
      agentSessionDAO,
      tasksService: {} as never,
    })
    const decisions = new CabinDecisionService({
      cabin: dao, service: svc, watchdogMs: 10_000, isBusy: () => false,
    })
    const delegations = new CabinDelegationService({
      cabin: dao, delegations: delegationDAO, service: svc, comm,
    })
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true, status: 200,
      body: { getReader: () => ({ read: async () => ({ done: true }) }) },
    })))
    app = new Hono()
    app.route("/api/cabins", createCabinRoutes(svc, initService, sse, comm, decisions, delegations))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    db.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("缺 askId / choice → 400（归属必须自带票据）", async () => {
    const res = await post(`/api/cabins/${cabinId}/decisions`, { choice: "短信" })
    expect(res.status).toBe(400)
  })

  it("askId 不在本舱 → 404", async () => {
    const res = await post(`/api/cabins/${cabinId}/decisions`, { askId: "ask_x", choice: "短信" })
    expect(res.status).toBe(404)
  })

  it("choice 不在 options → 400 且带正确映射", async () => {
    askCard("ask_1")
    const res = await post(`/api/cabins/${cabinId}/decisions`, { askId: "ask_1", choice: "电话" })
    expect(res.status).toBe(400)
    const body = await res.json() as { error: string; detail: { choices: string[] } }
    expect(body.error).toContain("不在")
    expect(body.detail.choices).toEqual(["短信", "邮件"])
  })

  it("合法提交 → decision + receipt（提交即回执，不等转达）", async () => {
    askCard("ask_1")
    const res = await post(`/api/cabins/${cabinId}/decisions`, { askId: "ask_1", choice: "短信", note: "只做通道验证" })
    expect(res.status).toBe(200)
    const body = await res.json() as {
      decision: { choice: string; stage: string; handle: string }
      already: boolean
      receipt: { line: string }
    }
    expect(body.decision.choice).toBe("短信")
    expect(body.decision.stage).toBe("decided")
    expect(body.decision.handle).toBe("D1")
    expect(body.already).toBe(false)
    expect(body.receipt.line).toContain("汐音正在转达")

    // 重复提交 → 幂等
    const again = await post(`/api/cabins/${cabinId}/decisions`, { askId: "ask_1", choice: "短信" })
    expect((await again.json() as { already: boolean }).already).toBe(true)
  })

  it("GET /decisions → 账本 + pending + asks", async () => {
    askCard("ask_1")
    await post(`/api/cabins/${cabinId}/decisions`, { askId: "ask_1", choice: "短信" })
    const res = await app.request(`/api/cabins/${cabinId}/decisions`)
    const body = await res.json() as {
      decisions: Array<{ askId: string; stage: string }>
      pending: Array<{ askId: string }>
      asks: Array<{ askId: string }>
    }
    expect(body.decisions).toHaveLength(1)
    expect(body.pending.map((p) => p.askId)).toEqual(["ask_1"])
    // 镜像卡已写回 decision → 不再算「待答」
    expect(body.asks).toHaveLength(0)
  })

  it("委派端点：创建 → 列表（带 handle）→ 取消", async () => {
    const created = await post(`/api/cabins/${cabinId}/delegations`, {
      title: "方案对比", intent: "帮我对比三个方案", autonomy: "hands-off",
    })
    expect(created.status).toBe(201)
    const row = (await created.json() as { delegation: { id: string; state: string } }).delegation
    expect(row.state).toBe("running")

    const list = await app.request(`/api/cabins/${cabinId}/delegations`)
    const body = await list.json() as { delegations: Array<{ id: string; handle: string | null }> }
    expect(body.delegations).toHaveLength(1)
    expect(body.delegations[0].handle).toBe("D1")

    const cancel = await post(`/api/cabins/${cabinId}/delegations/${row.id}/cancel`, {})
    expect((await cancel.json() as { delegation: { state: string } }).delegation.state).toBe("cancelled")
  })
})
