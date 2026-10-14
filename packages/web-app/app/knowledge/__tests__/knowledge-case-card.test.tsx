// P3 票03 · /knowledge 判例卡（S4 组件测试，仿票13 knowledge-findings 风格）
// Seam: <KnowledgePage/>（fetch stub 到 API 边界）+ Lane A fenced 卡注入。
// expected 真相源：票面「判例卡：五段预览 + source 指针 + 退役钮（superseded）」
// + spec §卡片与 UI 逐字 + KcCaseCardData 协议（shared card-protocol 单源）。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"

vi.mock("next/navigation", () => ({ usePathname: () => "/knowledge" }))
vi.mock("next/link", () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
}))
vi.mock("@/components/resource/MarkdownPreview", () => ({
  MarkdownPreview: ({ content }: { content: string }) => <div data-md-preview>{content}</div>,
}))

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

vi.mock("@/lib/agent/api", () => ({
  listCloneSessions: vi.fn(async () => ({
    sessions: [{
      id: "kc-s1", title: "知识中心", org: "global", clone_name: "archive",
      perspective_clone_name: null, session_type: "chat", created_at: "2026-10-14T08:00:00Z",
      updated_at: "2026-10-14T08:00:00Z", last_message_at: null, is_active: true,
    }],
    has_more: false, next_cursor: null,
  })),
  createCloneSession: vi.fn(async () => ({
    id: "kc-s1", title: "知识中心", org: "global", clone_name: "archive",
    perspective_clone_name: null, session_type: "chat", created_at: "2026-10-14T08:00:00Z",
    updated_at: "2026-10-14T08:00:00Z", last_message_at: null, is_active: true,
  })),
  getCloneSession: vi.fn(async () => ({ session: {}, messages: { items: [], has_more: false } })),
  getCloneSessionRunning: vi.fn(async () => ({ running: false, partial: false })),
  cloneChatStream: vi.fn(() => ({ reader: { read: async () => ({ done: true, value: undefined }) }, abort: vi.fn() })),
  stopCloneChat: vi.fn(async () => ({ success: true })),
}))

import KnowledgePage from "../page"
import { serializeKcCardBlock, type KcCardEvent } from "@/lib/knowledge-center/card-protocol"

// ── fixtures（票面+协议单源逐字段）─────────────────────────────────────

const HEALTH = {
  org: "global",
  pages: { total: 53, entity: 7, concept: 9, topic: 12, source: 23, case: 2 },
  rawSources: 31, ingestedThisWeek: 5, openFindings: 0, queueDepth: 0,
  lastCompiled: "2026-10-14", gitHead: "a3f9c21d4b5e6f708192a3b4c5d6e7f8091a2b3c",
}
const TREE = {
  org: "global",
  domains: [
    { name: "cases", label: "Cases", count: 1, entries: [{ id: "case-cookie500", path: "cases/2026-10-14-case-cookie500.md", title: "登录接口 500：cookie 未清", summary: "登录接口 500：cookie 未清", stability: "stable", ruleCount: 0 }] },
  ],
  stats: { entries: 0, cases: 1, rules: 0, lastCompiled: "2026-10-14" },
  log: null,
}

const CASE_EV: KcCardEvent = {
  id: "cse-case-cookie500",
  kind: "case",
  ts: "2026-10-14T09:20:00Z",
  data: {
    caseId: "case-cookie500",
    path: "cases/2026-10-14-case-cookie500.md",
    symptom: "登录接口 500：cookie 未清",
    severity: "blocker",
    tags: ["auth", "cookie"],
    occurrences: 2,
    status: "open",
    source: "exec:exec-9f31",
    sections: {
      现场: "验收环境点登录，接口回 500。",
      诊断: "session 过期后旧 cookie 仍被携带。",
      根因: "登录态失效清理路径缺失。",
      修复: "补 cookie 清理并回归通过。",
      教训: "登录态改造必须同时给出失效清理路径。",
    },
    taskId: "aa03-task-1",
    action: "created",
  },
}

const SUPERSEDED_EV: KcCardEvent = {
  id: "cse-case-dead",
  kind: "case",
  ts: "2026-10-14T09:30:00Z",
  data: {
    ...CASE_EV.data,
    caseId: "case-dead",
    status: "superseded",
    action: "retired",
  },
}

const MSG = (id: string, role: "user" | "assistant", content: string) => ({
  id, session_id: "kc-s1", role, content, created_at: "2026-10-14T09:00:00Z",
  is_summary: false, is_compressed: false, is_edited: false,
})

interface FetchCall { url: string; method: string; body: string }
let calls: FetchCall[]
type Stub = { ok: boolean; status: number; json: () => Promise<unknown> }

function makeStub(opts: { retireScript?: string[] } = {}) {
  let retirePoll = 0
  calls = []
  vi.stubGlobal("fetch", vi.fn(async (url: unknown, init?: { method?: string; body?: string }) => {
    const u = String(url)
    const method = init?.method ?? "GET"
    calls.push({ url: u, method, body: String(init?.body ?? "") })
    const json = (v: unknown): Stub => ({ ok: true, status: 200, json: async () => v })
    if (u.includes("/knowledge/wiki/tree")) return json(TREE)
    if (u.includes("/knowledge/health")) return json(HEALTH)
    if (u.includes("/wiki/article/")) return json({ id: "case-cookie500", domain: "cases", title: "登录接口 500：cookie 未清", summary: "登录接口 500：cookie 未清", topics: [], stability: "stable", lastCompiled: "2026-10-14", sources: [], confidence: 1, path: "cases/2026-10-14-case-cookie500.md", updatedAt: "2026-10-14 09:12:00", body: "## 现场\n\n验收环境点登录，接口回 500。", anchors: [], gitHistory: [], case: { symptom: "登录接口 500：cookie 未清", tags: ["auth", "cookie"], severity: "blocker", occurrences: 2, ruleRef: null, status: "open" }, page: null })
    if (u.includes("/knowledge/wiki/case/retire") && method === "POST") {
      return json({ caseId: "case-cookie500", queueTaskId: "car-case-cookie500-01", casePath: "cases/2026-10-14-case-cookie500.md" })
    }
    if (u.includes("/wiki/queue/task/car-case-cookie500-01")) {
      const script = opts.retireScript ?? ["queued", "committed"]
      const state = script[Math.min(retirePoll, script.length - 1)]
      retirePoll++
      return json({
        task: {
          id: "car-case-cookie500-01", opKind: "case-archive", label: "case-retire:case-cookie500",
          state, position: state === "queued" ? 1 : null,
          ...(state === "failed" ? { error: { code: "CASE_APPEND_ONLY", message: "不可变字段冲突" } } : {}),
        },
      })
    }
    if (u.includes("/wiki/queue/task/")) return json({ task: { id: "x", opKind: "case-archive", state: "committed", position: null } })
    if (u.includes("/knowledge/findings")) return json({ org: "global", findings: [] })
    return json({})
  }))
}

function openDrawer() {
  fireEvent.click(screen.getByRole("button", { name: /对话抽屉/ }))
}

beforeEach(() => {
  vi.clearAllMocks()
  chatBox.messages = []
  chatBox.sent = []
  makeStub()
  localStorage.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("票03 判例卡：五段预览 + source 指针 + 退役钮（注册表一行注册生效）", () => {
  it("Lane A 注入判例卡 ⇒ 真卡渲染（非兜底）：症状标题/五段逐段/occurrences/严重度/tags/source 指针在场", async () => {
    chatBox.messages = [MSG("a1", "assistant", serializeKcCardBlock(CASE_EV))]
    render(<KnowledgePage />)
    await screen.findByTestId("kc-tree-ready")
    openDrawer()

    const card = await screen.findByTestId("kc-card-case")
    expect(card.textContent).toContain("登录接口 500：cookie 未清")
    // 五段预览全展开（票面逐字「五段预览」）
    expect(card.textContent).toContain("验收环境点登录")
    expect(card.textContent).toContain("旧 cookie 仍被携带")
    expect(card.textContent).toContain("清理路径缺失")
    expect(card.textContent).toContain("补 cookie 清理")
    expect(card.textContent).toContain("必须同时给出失效清理路径")
    // 计数/溯源面（卡行「命中次数 2 次」；source 可定位指针原样展示）
    expect(card.textContent).toContain("2 次")
    expect(card.textContent).toContain("exec:exec-9f31")
    expect(card.textContent).toContain("blocker")
    expect(card.textContent).not.toContain("未注册卡类") // 注册表接位生效
  })

  it("[退役]→POST /wiki/case/retire（body=caseId）⇒ 占位 queued→轮询位次→committed 后钮退场（终态去钮，finding 卡先例样式）", async () => {
    chatBox.messages = [MSG("a1", "assistant", serializeKcCardBlock(CASE_EV))]
    makeStub({ retireScript: ["queued", "committed"] })
    render(<KnowledgePage />)
    await screen.findByTestId("kc-tree-ready")
    openDrawer()
    await screen.findByTestId("kc-card-case")

    fireEvent.click(screen.getByTestId("kc-case-retire"))
    await waitFor(() => expect(calls.some(c =>
      c.method === "POST" && c.url.includes("/knowledge/wiki/case/retire") && c.body.includes("case-cookie500"),
    )).toBe(true))
    // 排队位次回灌（票06 单源口径）
    await waitFor(() => {
      expect(screen.getByTestId("kc-card-case").textContent).toContain("排队中 #1")
    }, { timeout: 5000 })
    // committed：钮退场（退役是一次性事后纠）
    await waitFor(() => {
      const card = screen.getByTestId("kc-card-case")
      expect(card.textContent).toMatch(/已提交|退役已提交/)
      expect(screen.queryByTestId("kc-case-retire")).toBeNull()
    }, { timeout: 5000 })
  })

  it("退役失败 ⇒ 错误码显形、钮回可用（不静默）", async () => {
    chatBox.messages = [MSG("a1", "assistant", serializeKcCardBlock(CASE_EV))]
    makeStub({ retireScript: ["failed"] })
    render(<KnowledgePage />)
    await screen.findByTestId("kc-tree-ready")
    openDrawer()
    await screen.findByTestId("kc-card-case")

    fireEvent.click(screen.getByTestId("kc-case-retire"))
    await waitFor(() => {
      const card = screen.getByTestId("kc-card-case")
      expect(card.textContent).toContain("CASE_APPEND_ONLY")
    }, { timeout: 5000 })
    expect(screen.getByTestId("kc-case-retire")).toBeTruthy()
  })

  it("Lane A 终态卡（status=superseded）⇒ 已退役徽标 + 零退役钮（沉淀卡吃掉覆盖层也终态）", async () => {
    chatBox.messages = [MSG("a1", "assistant", serializeKcCardBlock(SUPERSEDED_EV))]
    render(<KnowledgePage />)
    await screen.findByTestId("kc-tree-ready")
    openDrawer()
    const card = await screen.findByTestId("kc-card-case")
    expect(card.textContent).toContain("已退役")
    expect(screen.queryByTestId("kc-case-retire")).toBeNull()
  })
})
