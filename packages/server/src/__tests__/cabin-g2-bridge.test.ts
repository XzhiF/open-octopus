// Cabin P3（G2/C4/C6）：舱任务的卡/wake 汇聚舱主会话，
// 且高信号经 hook 落派发账本审计。
//
// 2026-11-14 用户口径修订：运行态卡改落**任务自己的 chat**（task thread），舱主
// 会话只保留 wake/账本 —— 否则任务 chat 看不到工作流状态，舱 chat 把同一次执行
// 重复画几遍。本文件同时钉住这两半。
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest"
import Database from "better-sqlite3"
import { applySchema } from "../db/schema"
import { getChatEventBridge, resetChatEventBridgeForTests } from "../services/activity/chat-event-bridge"
import type { SSEService } from "../services/sse"

const NOW = "2026-11-12T10:00:00.000Z"

let db: Database.Database
let emit: ReturnType<typeof vi.fn>
let fetchMock: ReturnType<typeof vi.fn>
let signals: Array<{ taskId: string; status: string }>

function insertSession(id: string, workspaceId: string | null = null): void {
  db.prepare(`
    INSERT INTO sessions (id, org, title, clone_name, session_type, is_active, is_deleted, workspace_id, created_at, updated_at)
    VALUES (?, 'org', ?, NULL, 'main', 1, 0, ?, ?, ?)
  `).run(id, id, workspaceId, NOW, NOW)
}

beforeAll(() => {
  db = new Database(":memory:")
  applySchema(db)
  db.prepare(`
    INSERT INTO cabins (id, name, path, status, main_session_id, workspace_id, version, created_at, updated_at)
    VALUES ('c1', '测试舱', 'C:/tmp/cabin-g2', 'active', 's-cabin', 'ws-cabin', 1, ?, ?)
  `).run(NOW, NOW)
  insertSession("s-cabin", "ws-cabin")
  insertSession("s-task", "ws-task")
  db.prepare(`
    INSERT INTO tasks (id, repo_group, name, status, source_chat_session_id, task_spec, cabin_id, created_at, updated_at)
    VALUES ('t1', 'org', '舱任务', 'running', 's-task', '{"format":"v4"}', 'c1', ?, ?)
  `).run(NOW, NOW)
  db.prepare(`
    INSERT INTO tasks (id, repo_group, name, status, source_chat_session_id, task_spec, created_at, updated_at)
    VALUES ('t2', 'org', '普通任务', 'running', 's-task', '{"format":"v4"}', ?, ?)
  `).run(NOW, NOW)
})

afterAll(() => db.close())

beforeEach(() => {
  resetChatEventBridgeForTests()
  db.prepare("DELETE FROM messages").run()
  emit = vi.fn()
  signals = []
  fetchMock = vi.fn(async () => ({
    ok: true,
    body: { getReader: () => ({ read: async () => ({ done: true }) }) },
  }))
  vi.stubGlobal("fetch", fetchMock)
  const bridge = getChatEventBridge()
  bridge.attach(db)
  bridge.attachSse({ emit } as unknown as SSEService)
  bridge.setCabinSignalHook((taskId, status) => { signals.push({ taskId, status }) })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function cards(sessionId: string): Array<Record<string, unknown>> {
  return db.prepare("SELECT metadata FROM messages WHERE session_id = ? ORDER BY rowid")
    .all(sessionId)
    .map((r) => JSON.parse((r as { metadata: string }).metadata) as Record<string, unknown>)
}

describe("作者提问卡（design 23 §2 · 舱主会话就地作答）", () => {
  const QUESTIONS = {
    questions: [{
      question: "走哪个通道？", header: "通道", multiSelect: false,
      options: [{ label: "短信", description: "最薄" }],
    }],
  }

  it("舱任务的作者提问投到舱主会话；同 askMessageId 幂等", () => {
    const bridge = getChatEventBridge()
    bridge.requestAuthorAskCard({
      authorSessionId: "s-task", askMessageId: "ask-msg-1", questions: QUESTIONS,
    })
    const cabinCards = cards("s-cabin") as Array<{
      activity?: { payload?: Record<string, unknown> }
    }>
    expect(cabinCards).toHaveLength(1)
    const payload = cabinCards[0].activity?.payload ?? {}
    expect(payload.authorAsk).toBe(true)
    expect(payload.authorSessionId).toBe("s-task")
    expect(payload.taskName).toBe("舱任务")
    expect(payload.questions).toEqual(QUESTIONS)
    // SSE 必须发到舱主会话自己的 workspace，舱壳才收得到 session_updated；
    // 同时广播 cabin_view 让编队/attention 立即刷新（不等 30s 轮询）。
    expect(emit).toHaveBeenCalledWith('ws-cabin', expect.objectContaining({
      event: 'session_updated',
      data: expect.objectContaining({ sessionId: 's-cabin' }),
    }))
    expect(emit).toHaveBeenCalledWith('cabin:c1', expect.objectContaining({ event: 'cabin_view' }))

    // 同一张提问重复投递 → 不新增卡（重启/重放都幂等）。
    bridge.requestAuthorAskCard({
      authorSessionId: "s-task", askMessageId: "ask-msg-1", questions: QUESTIONS,
    })
    expect(cards("s-cabin")).toHaveLength(1)
  })

  it("非舱任务不投卡；作者会话缺失 main session 时静默跳过", () => {
    const bridge = getChatEventBridge()
    // t2 没有 cabin_id → JOIN 落空。
    bridge.requestAuthorAskCard({
      authorSessionId: "s-task", askMessageId: "ask-msg-2", questions: QUESTIONS,
    })
    expect(cards("s-cabin")).toHaveLength(1) // 只有上一条用例的卡
  })

  it("在任务线程答题 → 主会话镜像卡写回 decision（双会话同步）", () => {
    const bridge = getChatEventBridge()
    bridge.requestAuthorAskCard({
      authorSessionId: "s-task", askMessageId: "ask-msg-3", questions: QUESTIONS,
    })
    bridge.markAuthorAskAnswered("s-task")
    const card = cards("s-cabin")[0] as { activity?: { decision?: { id?: string } } }
    expect(card.activity?.decision?.id).toBe("answer_from_thread")
    // 幂等：重复同步不会把更早的卡翻出来再改。
    bridge.markAuthorAskAnswered("s-task")
    const again = cards("s-cabin")[0] as { activity?: { decision?: { id?: string } } }
    expect(again.activity?.decision?.id).toBe("answer_from_thread")
  })

  it("编队 chat 里直接回复（via=direct）同样销账，回执文案区分来源（v22 #9）", () => {
    const bridge = getChatEventBridge()
    bridge.requestAuthorAskCard({
      authorSessionId: "s-task", askMessageId: "ask-direct-1", questions: QUESTIONS,
    })
    bridge.markAuthorAskAnswered("s-task", { via: "direct" })

    const rows = cards("s-cabin") as Array<{
      activity?: { decision?: { label?: string }; payload?: Record<string, unknown> }
    }>
    const card = rows.find((r) => r.activity?.payload?.askMessageId === "ask-direct-1")
    expect(card?.activity?.decision?.label).toBe("对话里直接回复")
    const receipt = rows.find((r) => JSON.stringify(r).includes("authorAskReceipt")) as {
      activity?: { payload?: { authorAskReceipt?: { label?: string } } }
    } | undefined
    expect(receipt?.activity?.payload?.authorAskReceipt?.label).toBe("已回答（对话里直接回复）")
  })

  it("委派的提问被直接回复 → 委派回 running（不再挂着「在问你」）", () => {
    db.prepare(`
      INSERT INTO cabin_delegations
        (id, cabin_id, title, intent_text, autonomy, state, doer_session_id, created_at, updated_at)
      VALUES ('d-direct', 'c1', '直接答复', '帮我看看', 'checkpoint', 'waiting_input', 's-deleg-direct', ?, ?)
    `).run(NOW, NOW)
    insertSession("s-deleg-direct")
    try {
      const states: Array<{ id: string; state: string }> = []
      const bridge = getChatEventBridge()
      bridge.setDelegationStateHook((id, state) => { states.push({ id, state }) })
      bridge.requestAuthorAskCard({
        authorSessionId: "s-deleg-direct", askMessageId: "ask-direct-del", questions: QUESTIONS,
      })
      bridge.markAuthorAskAnswered("s-deleg-direct", { via: "direct" })
      expect(states).toEqual([
        { id: "d-direct", state: "waiting_input" },
        { id: "d-direct", state: "running" },
      ])
    } finally {
      // 句柄按创建顺序派生：不清掉会抢走后续用例的 D1。
      db.prepare("DELETE FROM cabin_delegations WHERE id = 'd-direct'").run()
    }
  })
})

describe("决策信封 / 句柄 / 回执（design 24 §3 + design 25 §4.1 / §5.1）", () => {
  const QUESTIONS = {
    questions: [{
      question: "走哪个通道？", header: "通道", multiSelect: false,
      options: [
        { label: "短信", description: "只做通道验证" },
        { label: "邮件", description: "多一张投递记录表" },
      ],
    }],
  }

  it("信封富化字段落 payload：decision / recommendation / options / handle", () => {
    const bridge = getChatEventBridge()
    bridge.requestAuthorAskCard({
      authorSessionId: "s-task",
      askMessageId: "ask-env-1",
      questions: QUESTIONS,
      decision: "失败回调用什么通道重试？",
      recommendation: { label: "短信", reason: "最薄" },
      options: [
        { label: "短信", impact: "只做通道验证" },
        { label: "邮件", impact: "多一张投递记录表" },
      ],
    })
    const payload = (cards("s-cabin")[0] as {
      activity?: { payload?: Record<string, unknown> }
    }).activity?.payload ?? {}
    expect(payload.decision).toBe("失败回调用什么通道重试？")
    expect(payload.recommendation).toEqual({ label: "短信", reason: "最薄" })
    expect(payload.options).toHaveLength(2)
    // 句柄由创建顺序派生：本舱只有 t1。
    expect(payload.handle).toBe("#1")
    expect(payload.subject).toEqual({ kind: "task", id: "t1" })
    expect(payload.blocking).toBe(true)
  })

  it("缺字段降级：没有 decision 就不带这个键（UI 不渲染空块）", () => {    const bridge = getChatEventBridge()
    bridge.requestAuthorAskCard({
      authorSessionId: "s-task", askMessageId: "ask-env-2", questions: QUESTIONS,
    })
    const payload = (cards("s-cabin")[0] as {
      activity?: { payload?: Record<string, unknown> }
    }).activity?.payload ?? {}
    expect("decision" in payload).toBe(false)
    expect("recommendation" in payload).toBe(false)
    expect(payload.options).toBeUndefined()
  })

  it("先落最小卡、回合收尾再补齐信封（同一 askMessageId，不新增卡）", () => {
    const bridge = getChatEventBridge()
    bridge.requestAuthorAskCard({
      authorSessionId: "s-task", askMessageId: "ask-early-1", questions: QUESTIONS,
    })
    let payload = (cards("s-cabin")[0] as {
      activity?: { payload?: Record<string, unknown> }
    }).activity?.payload ?? {}
    expect(payload.decision).toBeUndefined()

    bridge.requestAuthorAskCard({
      authorSessionId: "s-task",
      askMessageId: "ask-early-1",
      questions: QUESTIONS,
      decision: "失败回调用什么通道重试？",
      recommendation: { label: "短信", reason: "最薄" },
      options: [
        { label: "短信", impact: "只做通道验证" },
        { label: "邮件", impact: "多一张投递记录表" },
      ],
    })
    const rows = cards("s-cabin")
    expect(rows).toHaveLength(1)
    payload = (rows[0] as { activity?: { payload?: Record<string, unknown> } }).activity?.payload ?? {}
    expect(payload.decision).toBe("失败回调用什么通道重试？")
    expect(payload.options).toEqual([
      { label: "短信", impact: "只做通道验证" },
      { label: "邮件", impact: "多一张投递记录表" },
    ])
  })

  it("任务线程兜底作答 → 主会话多一条回执（幂等键 askMessageId）", () => {
    const bridge = getChatEventBridge()
    bridge.requestAuthorAskCard({
      authorSessionId: "s-task", askMessageId: "ask-env-3", questions: QUESTIONS,
    })
    bridge.markAuthorAskAnswered("s-task")
    bridge.markAuthorAskAnswered("s-task")
    const rows = cards("s-cabin")
    const receipts = rows.filter((r) => JSON.stringify(r).includes("authorAskReceipt"))
    expect(receipts).toHaveLength(1)
    const receipt = receipts[0] as {
      activity?: { payload?: { askReceiptFor?: string; authorAskReceipt?: { handle?: string } } }
    }
    expect(receipt.activity?.payload?.askReceiptFor).toBe("ask-env-3")
    expect(receipt.activity?.payload?.authorAskReceipt?.handle).toBe("#1")
  })

  it("委派 doer 的提问：subject=delegation、handle=D1，并回流 waiting_input", () => {
    db.prepare(`
      INSERT INTO cabin_delegations
        (id, cabin_id, title, intent_text, autonomy, state, doer_session_id, created_at, updated_at)
      VALUES ('d1', 'c1', '三方案对比', '帮我对比一下', 'checkpoint', 'running', 's-deleg', ?, ?)
    `).run(NOW, NOW)
    insertSession("s-deleg")
    const states: Array<{ id: string; state: string }> = []
    const bridge = getChatEventBridge()
    bridge.setDelegationStateHook((id, state) => { states.push({ id, state }) })

    bridge.requestAuthorAskCard({
      authorSessionId: "s-deleg", askMessageId: "ask-del-1", questions: QUESTIONS,
    })
    const payload = (cards("s-cabin")[0] as {
      activity?: { payload?: Record<string, unknown> }
    }).activity?.payload ?? {}
    expect(payload.subject).toEqual({ kind: "delegation", id: "d1" })
    expect(payload.handle).toBe("D1")
    expect(payload.taskId).toBeNull()
    expect(states).toEqual([{ id: "d1", state: "waiting_input" }])
  })
})

describe("舱任务的路由（2026-11-16 双会话修订）", () => {
  it("舱任务卡同时落任务 chat 与舱主会话，wake 仍汇聚舱主会话", () => {
    const bridge = getChatEventBridge()
    bridge.handleSse({ event: "task_status", data: { task_id: "t1", status: "awaiting_review" } })
    expect(cards("s-task")).toHaveLength(1)
    // 2026-11-16 用户口径：舱里汐音这条对话也要能追溯到同一事件
    // （规格 / 运行 / 验收就在卡片上内嵌展开）。
    expect(cards("s-cabin")).toHaveLength(1)
    // 镜像卡的 SSE 必须走舱主会话的 workspace（修复前发去了任务 workspace，
    // 开着的主对话收不到，只能 F5）。
    expect(emit).toHaveBeenCalledWith('ws-cabin', expect.objectContaining({
      event: 'session_updated',
      data: expect.objectContaining({ sessionId: 's-cabin' }),
    }))
    expect(emit).toHaveBeenCalledWith('cabin:c1', expect.objectContaining({ event: 'cabin_view' }))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0][0])).toContain("/sessions/s-cabin/chat")
  })

  it("暂停/继续落任务 chat，并镜像到舱主会话，且是轻量转场卡", () => {
    const bridge = getChatEventBridge()
    bridge.notifyTaskRunState("t1", "e1", "running")
    bridge.notifyTaskRunState("t1", "e1", "paused")
    expect(cards("s-cabin")).toHaveLength(2)
    const rows = cards("s-task") as Array<{ activity?: { payload?: { runState?: string } } }>
    expect(rows).toHaveLength(2)
    expect(rows[0].activity?.payload?.runState).toBe("resumed")
    expect(rows[1].activity?.payload?.runState).toBe("paused")
  })

  it("高信号经 hook 落审计（attention），普通状态不落", () => {
    const bridge = getChatEventBridge()
    bridge.handleSse({ event: "task_status", data: { task_id: "t1", status: "ready" } })
    expect(signals).toHaveLength(0)
    bridge.handleSse({ event: "task_status", data: { task_id: "t1", status: "awaiting_review" } })
    expect(signals).toEqual([{ taskId: "t1", status: "awaiting_review" }])
    bridge.handleSse({ event: "task_status", data: { task_id: "t1", status: "done" } })
    expect(signals).toHaveLength(2)
    expect(signals[1].status).toBe("done")
  })

  it("无舱任务保持原路由（回归）", () => {
    const bridge = getChatEventBridge()
    bridge.handleSse({ event: "task_status", data: { task_id: "t2", status: "awaiting_review" } })
    expect(cards("s-task")).toHaveLength(1)
    expect(cards("s-cabin")).toHaveLength(0)
    expect(signals).toHaveLength(0)
  })
})

// 2026-11-24 用户 #2：人在任务 chat 里直接跟执行者交互完，汐音原先完全无感。
// 回合收尾回传一张只读卡到舱主会话（零 LLM、不唤醒）。
describe("任务线程回复回传舱主会话", () => {
  it("人发起的一轮：卡落主会话，带 handle / 回复摘要 / 用户原话", () => {
    const bridge = getChatEventBridge()
    bridge.requestThreadReplyMirror({
      sessionId: "s-task",
      messageId: "m-reply-1",
      userText: "把这个接口改成分页",
      replyText: "已改好：/api/users 支持 page/size 两个参数，默认 20 条；单测与新接口都通过。",
    })
    const rows = cards("s-cabin") as Array<{
      activity?: { title?: string; payload?: { threadReply?: Record<string, unknown> } }
    }>
    expect(rows).toHaveLength(1)
    const tr = rows[0].activity?.payload?.threadReply
    expect(tr?.subject).toEqual({ kind: "task", id: "t1" })
    expect(tr?.handle).toBe("#1")
    expect(tr?.sessionId).toBe("s-task")
    expect(rows[0].activity?.title).toContain("#1")
    const row = db.prepare("SELECT content FROM messages WHERE session_id = 's-cabin'").get() as
      { content: string }
    expect(row.content).toContain("已改好")
    expect(row.content).toContain("你：把这个接口改成分页")
    // 开着的主对话立即刷新（Sse → 主会话自己的 workspace）。
    expect(emit).toHaveBeenCalledWith('ws-cabin', expect.objectContaining({
      event: 'session_updated',
      data: expect.objectContaining({ sessionId: 's-cabin' }),
    }))
  })

  it("同一条回复幂等：重复回传不重复落卡", () => {
    const bridge = getChatEventBridge()
    const input = {
      sessionId: "s-task",
      messageId: "m-reply-2",
      userText: "再跑一次回归",
      replyText: "回归已跑：42 个用例全绿，耗时 3 分 12 秒。",
    }
    bridge.requestThreadReplyMirror(input)
    bridge.requestThreadReplyMirror(input)
    expect(cards("s-cabin")).toHaveLength(1)
  })

  it("wake 回合（汐音转达 / 恢复）也回传，但系统指令不写成「你说了什么」", () => {
    const bridge = getChatEventBridge()
    bridge.requestThreadReplyMirror({
      sessionId: "s-task",
      messageId: "m-reply-wake",
      userText: "",
      replyText: "已按转达的选择把管理面改成 admin 令牌校验，单测通过，等你验收。",
    })
    const row = db.prepare("SELECT content FROM messages WHERE session_id = 's-cabin'").get() as
      { content: string }
    expect(row.content).toContain("↳ 已按转达的选择")
    expect(row.content).not.toContain("你：")
  })

  it("短应答 / 主会话自身 / 无舱会话都不回传", () => {
    insertSession("s-free")
    const bridge = getChatEventBridge()
    bridge.requestThreadReplyMirror({
      sessionId: "s-task", messageId: "m-ack", userText: "收到", replyText: "好",
    })
    bridge.requestThreadReplyMirror({
      sessionId: "s-cabin", messageId: "m-main", userText: "在吗", replyText: "有什么需要我处理的吗？这条回复属于主会话自己。",
    })
    bridge.requestThreadReplyMirror({
      sessionId: "s-free", messageId: "m-free", userText: "聊两句", replyText: "这条回复不属于任何舱，不该进舱主会话。",
    })
    expect(cards("s-cabin")).toHaveLength(0)
  })
})
