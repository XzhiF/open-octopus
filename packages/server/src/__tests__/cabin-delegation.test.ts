// design 25 §4.2：独立委派实体 —— 创建 / 状态迁移 / 读侧归一化。
//
// 重点不是「多一张表」，而是「两种工作实体在编队 / attention 里共存」：
// 任务用 #N、委派用 DN；委派的 waiting_input 要变成 answer attention，
// failed 要变成 blocked；done 进 notice（完成回流，人可确认无需回复收项）。
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest"
import Database from "better-sqlite3"
import { applySchema } from "../db/schema"
import { CabinDAO } from "../db/dao/cabin-dao"
import { CabinDelegationDAO } from "../db/dao/cabin-delegation-dao"
import { AgentSessionDAO, TaskDAO } from "../db/dao"
import { initSessionService } from "../services/agent/session-service"
import { CabinService, type CabinInfra } from "../services/cabin/cabin-service"
import { CabinDelegationService } from "../services/cabin/cabin-delegation-service"
import type { CabinCommService } from "../services/cabin/cabin-comm-service"
import { deriveCabinView } from "../services/cabin/derive-cabin-view"
import { buildCabinSummaryReminder } from "../services/chat/cabin-tools"
import type { CabinDecisionService } from "../services/cabin/cabin-decision-service"

const NOW = "2026-11-16T10:00:00.000Z"
const CABIN = "c1"

let db: Database.Database
let dao: CabinDAO
let delegations: CabinDelegationService
let service: CabinService
const appended: Array<{ sessionId: string; workspaceId: string | null }> = []

beforeAll(() => {
  db = new Database(":memory:")
  applySchema(db)
  db.prepare(`
    INSERT INTO cabins (id, name, path, status, main_session_id, workspace_id, org, version, created_at, updated_at)
    VALUES (?, '测试舱', '/tmp/cabin-delegation', 'active', 's-main', 'ws-cabin', 'org', 1, ?, ?)
  `).run(CABIN, NOW, NOW)
  db.prepare(`
    INSERT INTO sessions (id, org, title, session_type, is_active, is_deleted, workspace_id, created_at, updated_at)
    VALUES ('s-main', 'org', 'main', 'main', 1, 0, 'ws-cabin', ?, ?)
  `).run(NOW, NOW)

  dao = new CabinDAO(db)
  const sessionDAO = new AgentSessionDAO(db)
  initSessionService(sessionDAO)
  service = new CabinService(dao)

  const delegationDAO = new CabinDelegationDAO(db)
  service.bindInfra({
    agentSessionDAO: sessionDAO,
    taskDAO: new TaskDAO(db),
    cabinDelegationDAO: delegationDAO,
  } as unknown as CabinInfra)

  delegations = new CabinDelegationService({
    cabin: dao,
    delegations: delegationDAO,
    service,
    comm: { wakeSessionPublic: async () => {} } as unknown as CabinCommService,
    onAppend: (sessionId, workspaceId) => appended.push({ sessionId, workspaceId }),
  })
})

afterAll(() => db.close())

beforeEach(() => {
  db.prepare("DELETE FROM cabin_delegations").run()
  db.prepare("DELETE FROM messages").run()
  appended.length = 0
})

describe("CabinDelegationService：一份 brief + 一个 doer 会话", () => {
  it("创建即 running，doer 会话被绑定到舱（点开看过程 = 证据面）", () => {
    const row = delegations.delegate(CABIN, {
      title: "三方案对比",
      intent: "帮我把这三个方案对比一下",
      brief: { goal: "给出选型建议", done_when: ["一句话结论"], autonomy: "hands-off" },
      noWake: true,
    })
    expect(row.state).toBe("running")
    expect(row.autonomy).toBe("hands-off")
    expect(row.doer_session_id).toBeTruthy()
    expect(JSON.parse(row.brief!)).toMatchObject({ goal: "给出选型建议" })

    const session = db.prepare("SELECT cabin_id, title FROM sessions WHERE id = ?")
      .get(row.doer_session_id) as { cabin_id: string; title: string }
    expect(session.cabin_id).toBe(CABIN)
    expect(session.title).toContain("三方案对比")
  })

  it("状态迁移：waiting_input → running → done（带一句话结论）", () => {
    const row = delegations.delegate(CABIN, { title: "t", intent: "i", noWake: true })
    delegations.markWaitingInput(row.id)
    expect(delegations.get(row.id)?.state).toBe("waiting_input")
    delegations.markRunning(row.id)
    expect(delegations.get(row.id)?.state).toBe("running")
    const done = delegations.finish(row.id, "结论：选 B", true)
    expect(done?.state).toBe("done")
    expect(done?.result_summary).toBe("结论：选 B")
    expect(done?.ended_at).toBeTruthy()
  })

  it("委派完成 → 主会话回执落库并通知打开着的对话刷新", () => {
    const row = delegations.delegate(CABIN, { title: "三方案对比", intent: "对比一下", noWake: true })
    appended.length = 0
    delegations.finish(row.id, "结论：选 B", true)
    // 修复前只写库不通知，主对话要等下一次轮询 / F5 才看得到回执。
    expect(appended).toEqual([{ sessionId: "s-main", workspaceId: "ws-cabin" }])
    const msg = db.prepare("SELECT content FROM messages WHERE session_id = 's-main'").get() as
      { content: string } | undefined
    expect(msg?.content).toContain("三方案对比")
    expect(msg?.content).toContain("结论：选 B")
  })

  it("failed / cancelled 终态不再被 ask 回调改回 running", () => {
    const row = delegations.delegate(CABIN, { title: "t", intent: "i", noWake: true })
    delegations.finish(row.id, "没做成", false)
    delegations.markRunning(row.id)
    expect(delegations.get(row.id)?.state).toBe("failed")
    delegations.cancel(row.id)
    expect(delegations.get(row.id)?.state).toBe("cancelled")
  })

  // 2026-11-19 用户 #9：完成回流先进 inbox（notice），人可确认「无需回复」收项。
  it("done 委派进 attention notice；ack 只收项，不再写消息/唤醒", () => {
    const row = delegations.delegate(CABIN, { title: "完成态", intent: "i", noWake: true })
    delegations.finish(row.id, "结论：OK", true)
    const noticeId = `done-delegation-${row.id}`
    expect(service.getView(CABIN).view.attention.find(a => a.id === noticeId)?.stage).toBe("notice")

    const before = (db.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n
    expect(service.ackAttention(CABIN, noticeId)).toEqual({ acked: true })
    expect(service.getView(CABIN).view.attention.some(a => a.id === noticeId)).toBe(false)
    const after = (db.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n
    expect(after).toBe(before)
    // 幂等：重复收项不报错
    expect(service.ackAttention(CABIN, noticeId)).toEqual({ acked: true })
  })

  it("找不到 doer 会话时返回 undefined（不猜）", () => {
    expect(delegations.findByDoerSession("s-nope")).toBeUndefined()
  })
})

describe("读侧归一化：listWorkView 里任务与委派共存", () => {
  it("委派有自己的段位 D1，不占任务的 #1", () => {
    const a = delegations.delegate(CABIN, { title: "A", intent: "a", noWake: true })
    const b = delegations.delegate(CABIN, { title: "B", intent: "b", noWake: true })
    const works = service.listWorkView(CABIN)
    expect(works.map((w) => `${w.kind}:${w.handle}`)).toEqual([
      "delegation:D1", "delegation:D2",
    ])
    expect(works[0].id).toBe(a.id)
    expect(works[1].id).toBe(b.id)
    // 颜色是 id hash，稳定且不随状态变。
    expect(works[0].color).toBeGreaterThanOrEqual(0)
    expect(works[0].color).toBeLessThan(6)
  })
})

describe("编队摘要（design 25 §6.3）：汐音知道自己管着几条线", () => {
  it("含 handle / 状态 / 待转达队列 + 新纪律（不让人切线程）", () => {
    const row = delegations.delegate(CABIN, {
      title: "方案对比", intent: "帮我对比", noWake: true,
    })
    delegations.markWaitingInput(row.id)
    const fakeDecisions = {
      pendingRelays: () => ([{
        decisionId: "d-1", askId: "ask_1", subject: { kind: "delegation", id: row.id },
        handle: "D1", taskName: "方案对比", choice: "A 自建", source: "card",
        submittedAt: NOW, stage: "decided",
      }]),
      listDecisions: () => [],
      listAskCards: () => ([{
        askId: "ask_2", handle: "D1", title: "方案对比",
        subject: { kind: "delegation", id: row.id }, question: "选哪个？",
      }]),
    } as unknown as CabinDecisionService

    const text = buildCabinSummaryReminder(service, CABIN, fakeDecisions)!
    expect(text).toContain("[编队]")
    expect(text).toContain("D1 方案对比")
    expect(text).toContain("待你 1")
    expect(text).toContain("待你拍板")
    expect(text).toContain("待转达（已答未送达）")
    expect(text).toContain("ask=ask_1")
    expect(text).toContain("cabin_relay_decision")
    expect(text).toContain("不要让人切线程")
    // 旧纪律（把人送去任务线程）必须已经消失。
    expect(text).not.toContain("把用户送去任务线程")
  })
})

describe("deriveCabinView：委派进入同一套 attention", () => {
  const base = {
    cabin: { id: CABIN, status: "active" as const },
    tasks: [], executions: [], incidents: [], asks: [], findings: [], jobs: [], maxWorkers: 4,
  }

  it("waiting_input → answer / failed → blocked / done → notice", () => {
    const view = deriveCabinView({
      ...base,
      delegations: [
        { id: "d1", title: "方案对比", state: "waiting_input", handle: "D1", color: 2 },
        { id: "d2", title: "调研", state: "failed", handle: "D2", color: 3 },
        { id: "d3", title: "周报", state: "done", handle: "D3", color: 4 },
      ],
    })
    expect(view.attention.map((a) => `${a.handle}:${a.stage}`)).toEqual([
      "D1:answer", "D2:blocked", "D3:notice",
    ])
    for (const item of view.attention) {
      expect(item.subject?.kind).toBe("delegation")
    }
  })

  it("任务 attention 也带 subject / handle（两种实体同形）", () => {
    const view = deriveCabinView({
      ...base,
      tasks: [{ id: "t1", name: "支付回调", status: "awaiting_review", handle: "#1", color: 1 }],
      jobs: [{ id: "j1", kind: "task", ref_id: "t1", title: "支付回调" }],
    })
    expect(view.attention[0]).toMatchObject({
      handle: "#1", color: 1, subject: { kind: "task", id: "t1" },
    })
  })
})
