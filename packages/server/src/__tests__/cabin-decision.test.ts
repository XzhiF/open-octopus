// design 25 §7 / §7.1 决策票据 / 账本 / 转达 / watchdog 的服务端测试。
//
// 三条必须钉住的不变式：
//   1. 归属只认票据（askId），焦点只做诊断；
//   2. 账本幂等，重复提交不重复转达；
//   3. 20s 未转达 → 机械转发，**绝不丢答案**。
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest"
import Database from "better-sqlite3"
import { randomUUID } from "crypto"
import { applySchema } from "../db/schema"
import { CabinDAO } from "../db/dao/cabin-dao"
import { CabinService } from "../services/cabin/cabin-service"
import { CabinDecisionService, CabinDecisionError } from "../services/cabin/cabin-decision-service"

const NOW = "2026-11-16T10:00:00.000Z"
const CABIN = "c1"
const MAIN = "s-main"
const TASK_THREAD = "s-task"
const TASK = "t-1"

let db: Database.Database
let dao: CabinDAO
let service: CabinService
let decisions: CabinDecisionService
let fetchMock: ReturnType<typeof vi.fn>
let posts: Array<{ url: string; message: string }>

function insertSession(id: string, cabinId: string | null = CABIN): void {
  db.prepare(`
    INSERT INTO sessions (id, org, title, clone_name, session_type, is_active, is_deleted, created_at, updated_at, cabin_id)
    VALUES (?, 'org', ?, NULL, 'main', 1, 0, ?, ?, ?)
  `).run(id, id, NOW, NOW, cabinId)
}

function insertAskCard(askId: string, opts: {
  handle?: string
  taskName?: string
  choices?: string[]
  subject?: { kind: "task" | "delegation"; id: string }
  answered?: boolean
} = {}): void {
  const choices = opts.choices ?? ["短信", "邮件"]
  const activity = {
    kind: "cabin.author_ask",
    severity: "info",
    title: `${opts.handle ?? "#1"} ${opts.taskName ?? "支付回调"} 在问你`,
    message: "回调失败后用什么通道重试？",
    workspaceId: null,
    taskId: TASK,
    status: "awaiting_input",
    payload: {
      authorAsk: true,
      askMessageId: askId,
      authorSessionId: TASK_THREAD,
      cabinId: CABIN,
      taskId: TASK,
      taskName: opts.taskName ?? "支付回调",
      subject: opts.subject ?? { kind: "task", id: TASK },
      handle: opts.handle ?? "#1",
      decision: "回调失败后用什么通道重试？",
      options: choices.map((label) => ({ label, impact: `${label} 的影响` })),
      blocking: true,
      questions: {
        questions: [{
          question: "回调失败后用什么通道重试？", header: "通道", multiSelect: false,
          options: choices.map((label) => ({ label, description: `${label} 的影响` })),
        }],
      },
      ...(opts.answered ? {} : {}),
    },
    ...(opts.answered ? { decision: { id: "d-old", label: choices[0], at: NOW } } : {}),
  }
  db.prepare(
    "INSERT INTO messages (id, session_id, role, content, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(randomUUID(), MAIN, "user", "提问", JSON.stringify({ displayType: "event", activity }), NOW)
}

function messages(sessionId: string): Array<{ role: string; content: string; metadata: string | null }> {
  return db.prepare("SELECT role, content, metadata FROM messages WHERE session_id = ? ORDER BY rowid")
    .all(sessionId) as Array<{ role: string; content: string; metadata: string | null }>
}

function decisionEvents(): Array<Record<string, unknown>> {
  return (db.prepare(
    "SELECT payload FROM cabin_job_events WHERE cabin_id = ? AND kind = 'decision' ORDER BY rowid",
  ).all(CABIN) as Array<{ payload: string }>).map((r) => JSON.parse(r.payload) as Record<string, unknown>)
}

beforeAll(() => {
  db = new Database(":memory:")
  applySchema(db)
  db.prepare(`
    INSERT INTO cabins (id, name, path, status, main_session_id, org, version, created_at, updated_at)
    VALUES (?, '测试舱', '/tmp/cabin-decision', 'active', ?, 'org', 1, ?, ?)
  `).run(CABIN, MAIN, NOW, NOW)
  insertSession(MAIN)
  insertSession(TASK_THREAD)
  db.prepare(`
    INSERT INTO tasks (id, repo_group, name, status, source_chat_session_id, task_spec, cabin_id, created_at, updated_at)
    VALUES (?, 'org', '支付回调', 'running', ?, '{"format":"v4"}', ?, ?, ?)
  `).run(TASK, TASK_THREAD, CABIN, NOW, NOW)
  db.prepare(`
    INSERT INTO cabin_jobs (id, cabin_id, kind, ref_id, session_id, title, created_at)
    VALUES ('j-1', ?, 'task', ?, ?, '支付回调', ?)
  `).run(CABIN, TASK, TASK_THREAD, NOW)

  dao = new CabinDAO(db)
  service = new CabinService(dao)
  decisions = new CabinDecisionService({
    cabin: dao,
    service,
    watchdogMs: 30,
    isBusy: () => false,
  })
})

afterAll(() => db.close())

beforeEach(() => {
  db.prepare("DELETE FROM messages").run()
  db.prepare("DELETE FROM cabin_job_events").run()
  posts = []
  fetchMock = vi.fn(async (url: string, init?: { body?: string }) => {
    const body = init?.body ? JSON.parse(init.body) as { message?: string } : {}
    posts.push({ url: String(url), message: body.message ?? "" })
    return {
      ok: true,
      status: 200,
      body: { getReader: () => ({ read: async () => ({ done: true }) }) },
    }
  })
  vi.stubGlobal("fetch", fetchMock)
})

describe("submitDecision：票据 / 账本 / 幂等", () => {
  it("合法提交 → decided 账本 + 卡片立刻只读 + 结构化用户消息", async () => {
    insertAskCard("ask_1")
    const { record, already } = await decisions.submitDecision(CABIN, {
      askId: "ask_1", choice: "短信", source: "card",
    })
    expect(already).toBe(false)
    expect(record.stage).toBe("decided")
    expect(record.handle).toBe("#1")
    expect(record.subject).toEqual({ kind: "task", id: TASK })

    const card = JSON.parse(messages(MAIN)[0].metadata!) as {
      activity: { decision?: { label?: string } }
    }
    expect(card.activity.decision?.label).toBe("短信")

    const decisionMessage = messages(MAIN).find((m) => m.content.startsWith("[决策 ·"))
    expect(decisionMessage?.content).toContain("[决策 · #1 支付回调 · ask_1] 短信")
    expect(decisionMessage?.content).toContain("（逐字）短信")
  })

  it("作答同步写回作者线程原卡（跨会话同一张提问）", async () => {
    insertAskCard("ask_1")
    // 作者线程原卡：id 就是 askId（chat-routes 的契约）。
    db.prepare(
      "INSERT INTO messages (id, session_id, role, content, metadata, created_at) VALUES (?, ?, 'assistant', '问', ?, ?)",
    ).run(
      "ask_1", TASK_THREAD,
      JSON.stringify({
        displayType: "ask_user_question",
        questions: [{ question: "回调失败后用什么通道重试？" }],
      }),
      NOW,
    )

    await decisions.submitDecision(CABIN, { askId: "ask_1", choice: "短信" })

    const original = db.prepare("SELECT metadata FROM messages WHERE id = ? AND session_id = ?")
      .get("ask_1", TASK_THREAD) as { metadata: string }
    const meta = JSON.parse(original.metadata) as {
      displayType?: string
      activity?: { decision?: { label?: string } }
    }
    expect(meta.displayType).toBe("ask_user_question")
    expect(meta.activity?.decision?.label).toBe("短信")
  })

  it("重复提交幂等：只有一条 decided 事件，返回 already", async () => {
    insertAskCard("ask_1")
    await decisions.submitDecision(CABIN, { askId: "ask_1", choice: "短信" })
    const second = await decisions.submitDecision(CABIN, { askId: "ask_1", choice: "邮件" })
    expect(second.already).toBe(true)
    expect(second.record.choice).toBe("短信")
    expect(decisionEvents()).toHaveLength(1)
  })

  it("askId 不存在 → 404（不能靠焦点猜归属）", async () => {
    await expect(decisions.submitDecision(CABIN, { askId: "ask_missing", choice: "短信" }))
      .rejects.toMatchObject({ status: 404 })
  })

  it("choice 不在 options → 400，并返回正确映射", async () => {
    insertAskCard("ask_1")
    try {
      await decisions.submitDecision(CABIN, { askId: "ask_1", choice: "电话" })
      throw new Error("should reject")
    } catch (err) {
      expect(err).toBeInstanceOf(CabinDecisionError)
      const e = err as CabinDecisionError
      expect(e.status).toBe(400)
      expect((e.detail as { choices: string[] }).choices).toEqual(["短信", "邮件"])
    }
  })

  it("自由文本（source=composer）放行 —— Other 不是选项选择", async () => {
    insertAskCard("ask_1")
    const { record } = await decisions.submitDecision(CABIN, {
      askId: "ask_1", choice: "用飞书机器人", source: "composer",
    })
    expect(record.choice).toBe("用飞书机器人")
  })

  it("taskId 与卡片不一致 → 409，不静默接受", async () => {
    insertAskCard("ask_1")
    await expect(decisions.submitDecision(CABIN, {
      askId: "ask_1", choice: "短信", taskId: "t-other",
    })).rejects.toMatchObject({ status: 409 })
  })

  it("focusAtSubmit ≠ askId 不报错（票据为准），只记诊断", async () => {
    insertAskCard("ask_1")
    const { record } = await decisions.submitDecision(CABIN, {
      askId: "ask_1", choice: "短信", focusAtSubmit: "ask_other",
    })
    expect(record.askId).toBe("ask_1")
    expect(record.focusAtSubmit).toBe("ask_other")
  })
})

describe("relayDecision：汐音主路径", () => {
  it("转达 doer：verbatim 逐字 + 结构化块 + 回执", async () => {
    insertAskCard("ask_1")
    await decisions.submitDecision(CABIN, {
      askId: "ask_1", choice: "短信", note: "只做通道验证",
    })
    posts = []
    const res = await decisions.relayDecision(CABIN, {
      askId: "ask_1", framing: "本 phase 不落库",
    })
    expect(res.delivered).toBe(true)
    expect(res.already).toBe(false)

    const toDoer = posts.find((p) => p.url.includes(TASK_THREAD))
    expect(toDoer?.message).toContain("[决策 · #1 · ask_1] 短信")
    expect(toDoer?.message).toContain("（逐字）短信")
    expect(toDoer?.message).toContain("（补充）只做通道验证")
    expect(toDoer?.message).toContain("理由与边界")

    expect(decisions.recordForAsk(CABIN, "ask_1")?.stage).toBe("relayed")
    const receipt = messages(MAIN).find((m) => m.metadata?.includes("decisionReceipt"))
    expect(receipt?.content).toContain("✓ #1 支付回调 · 按「短信」交代下去")
  })

  it("重复转达幂等：不重复写 doer", async () => {
    insertAskCard("ask_1")
    await decisions.submitDecision(CABIN, { askId: "ask_1", choice: "短信" })
    await decisions.relayDecision(CABIN, { askId: "ask_1" })
    posts = []
    const again = await decisions.relayDecision(CABIN, { askId: "ask_1" })
    expect(again.already).toBe(true)
    expect(posts).toHaveLength(0)
  })

  it("改选择 → 拒绝（verbatim 不可改）", async () => {
    insertAskCard("ask_1")
    await decisions.submitDecision(CABIN, { askId: "ask_1", choice: "短信" })
    await expect(decisions.relayDecision(CABIN, { askId: "ask_1", choice: "邮件" }))
      .rejects.toMatchObject({ status: 400 })
  })

  it("还没答就转达 → 拒绝（先有人决定）", async () => {
    insertAskCard("ask_1")
    await expect(decisions.relayDecision(CABIN, { askId: "ask_1" }))
      .rejects.toMatchObject({ status: 409 })
  })
})

describe("watchdog：20s 未转达 → 机械转发", () => {
  it("超时后 doer 收到兼容格式，回执标「直接转达」", async () => {
    insertAskCard("ask_1")
    await decisions.submitDecision(CABIN, { askId: "ask_1", choice: "短信" })
    posts = []
    await new Promise((r) => setTimeout(r, 90))

    const toDoer = posts.find((p) => p.url.includes(TASK_THREAD))
    expect(toDoer?.message).toContain("用户回答了以下问题：短信")
    expect(toDoer?.message).toContain("机械转达")
    expect(decisions.recordForAsk(CABIN, "ask_1")?.stage).toBe("fallback_relayed")
    const receipt = messages(MAIN).find((m) => m.metadata?.includes("decisionReceipt"))
    expect(receipt?.content).toContain("已直接转达")
  })
})

describe("两种工作实体：委派也走同一套票据", () => {
  it("subject=delegation 的卡片能提交 / 转达", async () => {
    db.prepare(
      `INSERT INTO cabin_delegations
         (id, cabin_id, title, intent_text, autonomy, state, doer_session_id, created_at, updated_at)
       VALUES ('d1', ?, '三方案对比', '帮我对比一下', 'checkpoint', 'waiting_input', ?, ?, ?)`,
    ).run(CABIN, TASK_THREAD, NOW, NOW)
    insertAskCard("ask_d1", {
      handle: "D1", taskName: "三方案对比",
      subject: { kind: "delegation", id: "d1" },
    })
    const relayed: string[] = []
    const local = new CabinDecisionService({
      cabin: dao, service, watchdogMs: 10_000, isBusy: () => false,
      onDelegationRelayed: (id) => { relayed.push(id) },
    })
    const { record } = await local.submitDecision(CABIN, { askId: "ask_d1", choice: "A 自建" , source: "composer" })
    expect(record.subject).toEqual({ kind: "delegation", id: "d1" })
    expect(record.handle).toBe("D1")
    const res = await local.relayDecision(CABIN, { askId: "ask_d1" })
    expect(res.delivered).toBe(true)
    // 送完答案，委派回到 running（否则编队一直显示「在问你」）。
    expect(relayed).toEqual(["d1"])
  })
})
