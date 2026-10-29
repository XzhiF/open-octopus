// 票10 · S4——普通 agent 会话（ChatTab）跨会话卡片渲染与动作钮链
// Seam: <ChatTab/>（fetch stub 到 API 边界）+ Lane A fenced 卡注入消息正文。
// fixture 形 = knowledge-material-pack.test.tsx 先例（mock chat hooks + serializeKcCardBlock 注入）。
// expected 真相源：票面 AC3/AC4（卡回流原会话、注册表渲染复用、零新卡类、动作钮同 API）+ 协议 id 约定。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"

const chatBox: {
  messages: Array<{ id: string; session_id: string; role: "user" | "assistant"; content: string; created_at: string; is_summary: boolean; is_compressed: boolean; is_edited: boolean }>
  sent: string[]
} = { messages: [], sent: [] }

vi.mock("@/hooks/useAgentChat", () => ({
  useAgentChat: () => ({
    messages: chatBox.messages,
    streaming: false,
    streamContent: "",
    streamThinking: "",
    streamTimeline: [],
    isThinking: false,
    toolCalls: [],
    pendingConfirm: null,
    error: null,
    statusMessage: "",
    contextUsage: null,
    sendMessage: vi.fn(async (m: string) => { chatBox.sent.push(m) }),
    stopGenerate: vi.fn(),
    steer: vi.fn(),
    steeringRef: { current: false },
    resumeStreaming: false,
    handleConfirm: vi.fn(),
    loadMessages: vi.fn(),
  }),
}))

vi.mock("@/components/providers/chat-sessions", () => ({
  useChatSessions: () => ({
    sessions: [{
      id: "s1", title: "投喂讨论", org: "global", clone_name: null,
      perspective_clone_name: null, session_type: "main", created_at: "2026-10-15T08:00:00Z",
      updated_at: "2026-10-15T08:00:00Z", last_message_at: null, is_active: true,
    }],
    activeSessionId: "s1",
    setActiveSessionId: vi.fn(),
    loading: false,
    createNewSession: vi.fn(),
    renameSession: vi.fn(),
    removeSession: vi.fn(),
    updateSessionTitle: vi.fn(),
  }),
}))

vi.mock("@/hooks/useSessionUsage", () => ({
  useSessionUsage: () => null,
}))
vi.mock("@/hooks/useSessionLedger", () => ({ useSessionLedger: () => ({ aggregates: null, calls: [] }) }))

vi.mock("@/hooks/use-chat-tasks", () => ({
  useChatTasks: () => ({ tasks: [], loading: false, refresh: vi.fn() }),
}))

import { ChatTab } from "../ChatTab"
import { serializeKcCardBlock, type KcCardEvent } from "@/lib/knowledge-center/card-protocol"

// ── fixtures（独立真相源：卡形按 spec/协议手构，非从渲染代码推导）──

const RAW_PATH = "raw/inbox/2026-10-15-article.md"
const COMMIT = "abc1234def56789012345678901234567890ab"
const REVERT_COMMIT = "99887766554433221100ffeeddccbbaa99887766"

const INGEST_EV: KcCardEvent = {
  id: "ing-deadbeef",
  kind: "ingest",
  ts: "2026-10-15T09:00:00Z",
  data: {
    status: "done",
    rawPath: RAW_PATH,
    bytes: 2048,
    hash: "deadbeefcafe0123456789abcdef0123456789abcdef0123456789abcdef01",
    origin: "url:https://example.com/a",
    title: "知识策展样例",
    compile: { taskId: "crt-20261015T0900-001", status: "queued", position: 2 },
  },
}
const DIFF_EV: KcCardEvent = {
  id: "dif-crt-20261015T0900-001",
  kind: "compile-diff",
  ts: "2026-10-15T09:00:01Z",
  data: {
    taskId: "crt-20261015T0900-001",
    status: "committed",
    rawPath: RAW_PATH,
    rawTitle: "知识策展样例",
    touched: [{ path: "concepts/kc-sample.md", type: "concept", created: true }],
    created: 1,
    updated: 0,
    contradictions: 0,
    commit: COMMIT,
    ftsOk: true,
  },
}
const INGEST_FAILED_EV: KcCardEvent = {
  id: "ing-cafe1234",
  kind: "ingest",
  ts: "2026-10-15T09:00:00Z",
  data: {
    status: "done",
    rawPath: RAW_PATH,
    bytes: 1024,
    hash: "cafe1234babe0123456789abcdef0123456789abcdef0123456789abcdef01",
    title: "失败样例",
    compile: { taskId: "crt-20261015T0900-002", status: "failed", error: { code: "COMPILE_FAILED", message: "编译失败" } },
  },
}
const UNKNOWN_EV: KcCardEvent = { id: "xyz-1", kind: "totally-new-kind", ts: "2026-10-15T09:00:00Z", data: { whatever: true } }

const MSG = (id: string, role: "user" | "assistant", content: string) => ({
  id, session_id: "s1", role, content, created_at: "2026-10-15T09:00:02Z",
  is_summary: false, is_compressed: false, is_edited: false,
})

interface FetchCall { url: string; method: string; body: string }
let calls: FetchCall[]
let revertScript: string[]
let compileScript: string[]

function makeStub() {
  let revertPoll = 0
  let compilePoll = 0
  calls = []
  vi.stubGlobal("fetch", vi.fn(async (url: unknown, init?: { method?: string; body?: string }) => {
    const u = String(url)
    const method = init?.method ?? "GET"
    calls.push({ url: u, method, body: String(init?.body ?? "") })
    const json = (v: unknown) => ({ ok: true, status: 200, json: async () => v })
    if (u.includes("/wiki/revert/task/")) {
      const status = revertScript[Math.min(revertPoll, revertScript.length - 1)]
      revertPoll++
      return json({ task: {
        id: "rvt-1", commit: COMMIT, status,
        ...(status === "committed"
          ? { result: { target: COMMIT, revertCommit: REVERT_COMMIT, touched: [], ftsWarnings: [] } }
          : {}),
      } })
    }
    if (u.includes("/wiki/revert")) return json({ taskId: "rvt-1", commit: COMMIT, status: "queued" })
    if (u.includes("/wiki/compile/task/")) {
      const status = compileScript[Math.min(compilePoll, compileScript.length - 1)]
      compilePoll++
      return json({ task: {
        id: "crt-rerun-1", rawPath: RAW_PATH, status, createdAt: "2026-10-15T09:01:00Z",
        ...(status === "committed"
          ? { result: { rawPath: RAW_PATH, rawHash: "0".repeat(64), rawTitle: "失败样例", touched: [], created: 0, updated: 1, contradictions: 0, findingIds: [], commit: COMMIT, changed: true, deduped: false, warnings: [] } }
          : {}),
      } })
    }
    if (u.includes("/wiki/compile")) return json({ taskId: "crt-rerun-1", status: "queued" })
    if (u.includes("/wiki/queue/task/")) {
      return json({ task: { id: "q", opKind: "revert", state: "committed", position: null, queuedAt: "2026-10-15T09:01:00Z" } })
    }
    return json({})
  }))
}

beforeEach(() => {
  vi.clearAllMocks()
  chatBox.messages = []
  chatBox.sent = []
  revertScript = ["queued", "running", "committed"]
  compileScript = ["queued", "compiling", "committed"]
  makeStub()
  localStorage.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("票10 S4：普通会话跨会话卡片渲染（注册表复用，零新卡类）", () => {
  it("Lane A 抓取卡+diff 卡注入消息正文 ⇒ 剥块渲染真卡（fenced 原文不露出，未注册兜底不出现）", async () => {
    chatBox.messages = [MSG("m1", "assistant", `📥 会话投喂入库：知识策展样例\n\n${serializeKcCardBlock(INGEST_EV)}\n\n${serializeKcCardBlock(DIFF_EV)}\n`)]
    render(<ChatTab />)

    const ing = await screen.findByTestId("kc-card-ingest")
    expect(ing.textContent).toContain(RAW_PATH)
    expect(ing.textContent).toContain("排队中 #2") // 编译镜像位次单源进卡面
    const dif = screen.getByTestId("kc-card-compile-diff")
    expect(dif.textContent).toContain("已提交 abc1234") // committed 短 hash 口径（排队/已提交文案单源）
    fireEvent.click(screen.getByTestId("kc-diff-expand")) // 展开触及页明细
    expect(screen.getByTestId("kc-diff-pages").textContent).toContain("concepts/kc-sample.md")
    // Lane A 剥块：正文不露 fenced 协议原文
    expect(document.body.textContent).not.toContain("```kc-card")
    expect(document.body.textContent).not.toContain("未注册卡类") // 注册表既有件生效——零新卡类
    // header 人话保留
    expect(document.body.textContent).toContain("📥 会话投喂入库：知识策展样例")
  })

  it("未注册 kind ⇒ 通用兜底显形不炸流（同一注册表分发面）", async () => {
    chatBox.messages = [MSG("m1", "assistant", serializeKcCardBlock(UNKNOWN_EV))]
    render(<ChatTab />)
    const card = await screen.findByTestId("kc-card-unknown")
    expect(card.textContent).toContain("未注册卡类")
    expect(card.textContent).toContain("totally-new-kind")
  })

  it("回滚钮链与知识中心同一 API：arm→confirm⇒POST /wiki/revert ⇒ 覆盖层回灌原卡显「已回滚 hash」", async () => {
    chatBox.messages = [MSG("m1", "assistant", serializeKcCardBlock(DIFF_EV))]
    render(<ChatTab />)
    const card = await screen.findByTestId("kc-card-compile-diff")

    fireEvent.click(screen.getByTestId("kc-revert-arm"))
    expect(calls.some(c => c.method === "POST" && c.url.includes("/wiki/revert"))).toBe(false) // 二次确认闸同律
    fireEvent.click(screen.getByTestId("kc-revert-confirm"))

    await waitFor(() => {
      expect(calls.some(c => c.method === "POST" && c.url.includes("/api/knowledge/wiki/revert"))).toBe(true)
    })
    await waitFor(() => {
      const el = screen.getByTestId("kc-card-compile-diff")
      expect(el.textContent).toContain("已回滚")
      expect(el.textContent).toContain("9988776") // 回滚 commit 短显
    }, { timeout: 8000 })
    expect(card).toBeTruthy()
  }, 15000)

  it("重试编译钮链同一 API：failed 镜像卡 ⇒POST /wiki/compile（ingest-compile 队列通道）⇒ 新 diff 卡进尾挂（Lane B store 复用）", async () => {
    chatBox.messages = [MSG("m1", "assistant", serializeKcCardBlock(INGEST_FAILED_EV))]
    render(<ChatTab />)
    await screen.findByTestId("kc-card-ingest")

    fireEvent.click(screen.getByTestId("kc-ingest-retry-compile"))
    await waitFor(() => {
      expect(calls.some(c => c.method === "POST" && c.url.includes("/api/knowledge/wiki/compile"))).toBe(true)
    })
    // 重试新任务卡出现在尾挂（Lane B），原卡编译态被覆盖层回灌
    await waitFor(() => {
      expect(screen.getByTestId("kc-card-compile-diff")).toBeTruthy()
    }, { timeout: 8000 })
  })

  it("无卡消息零变化：普通文本会话不引入任何卡面（误吞防护渲染面）", async () => {
    chatBox.messages = [MSG("m1", "user", "今天天气如何？"), MSG("m2", "assistant", "我不确定。")]
    render(<ChatTab />)
    expect(document.body.textContent).toContain("今天天气如何？")
    expect(screen.queryByTestId(/^kc-card-/)).toBeNull()
  })
})
