// 票13 · /knowledge finding 卡三钮 + 回填卡（S4 组件测试，仿票12 knowledge-chat 风格）
// Seam: <KnowledgePage/>（fetch stub 到 API 边界）+ Lane A fenced 卡注入。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react"

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
      perspective_clone_name: null, session_type: "chat", created_at: "2026-10-13T08:00:00Z",
      updated_at: "2026-10-13T08:00:00Z", last_message_at: null, is_active: true,
    }],
    has_more: false, next_cursor: null,
  })),
  createCloneSession: vi.fn(async () => ({
    id: "kc-s1", title: "知识中心", org: "global", clone_name: "archive",
    perspective_clone_name: null, session_type: "chat", created_at: "2026-10-13T08:00:00Z",
    updated_at: "2026-10-13T08:00:00Z", last_message_at: null, is_active: true,
  })),
  getCloneSession: vi.fn(async () => ({ session: {}, messages: { items: [], has_more: false } })),
  getCloneSessionRunning: vi.fn(async () => ({ running: false, partial: false })),
  cloneChatStream: vi.fn(() => ({ reader: { read: async () => ({ done: true, value: undefined }) }, abort: vi.fn() })),
  stopCloneChat: vi.fn(async () => ({ success: true })),
}))

import KnowledgePage from "../page"
import { serializeKcCardBlock, type KcCardEvent } from "@/lib/knowledge-center/card-protocol"

// ── fixtures（expected 真相源：票13 票面 + 原型 Tab④ finding/回填卡样张）──

const HEALTH = {
  org: "global",
  pages: { total: 52, entity: 7, concept: 9, topic: 11, source: 23, case: 2 },
  rawSources: 31, ingestedThisWeek: 5, openFindings: 2, queueDepth: 0,
  lastCompiled: "2026-10-13", gitHead: "a3f9c21d4b5e6f708192a3b4c5d6e7f8091a2b3c",
}
const TREE = {
  org: "global",
  domains: [
    { name: "topic", label: "Topics", count: 1, entries: [{ id: "top-knowledge-injection", path: "topics/top-knowledge-injection.md", title: "知识注入沿革", summary: "注入式→编译式", stability: "stable", ruleCount: 1 }] },
  ],
  stats: { entries: 1, cases: 0, rules: 1, lastCompiled: "2026-10-13" },
  log: null,
}
const ARTICLE = {
  id: "top-knowledge-injection", domain: "topic", title: "知识注入沿革", summary: "注入式→编译式",
  topics: [], stability: "stable", lastCompiled: "2026-10-13", sources: [], confidence: 0.9,
  path: "topics/top-knowledge-injection.md", updatedAt: "2026-10-13 09:12:00",
  body: "## 沿革\n\n注入式已废止。", anchors: [], gitHistory: [], case: null,
  page: { type: "topic", entityKind: null, aliases: [], links: [] },
}

const COMMIT = "b71e004d4b5e6f708192a3b4c5d6e7f8091a2b3c"

const FINDING_EV: KcCardEvent = {
  id: "fnd-cafe000000000001",
  kind: "finding",
  ts: "2026-10-13T09:20:00Z",
  data: {
    findingId: "fnd-cafe000000000001",
    kind: "contradiction",
    title: "矛盾：topics/top-knowledge-injection.md ↔ concepts/con-compiled-rag.md",
    claims: { old: "规则由引擎预计算注入", new: "注入式冷启动重推导，应编译成 wiki" },
    pages: ["topics/top-knowledge-injection.md"],
    rawRef: "sha256 4f2a9c12",
    source: "compile",
    status: "open",
  },
}
const BACKFILL_EV: KcCardEvent = {
  id: "bfk-9be21c40",
  kind: "backfill",
  ts: "2026-10-13T09:21:00Z",
  data: {
    excerpt: "排查 CI lockfile 失败的合成路径：先对齐 pnpm 版本，再清 node_modules 重装；overrides 位置在 pnpm-workspace.yaml。",
    title: "lockfile 排障路径",
    sessionId: "kc-s1",
    status: "ready",
  },
}

const OPEN_FINDING_VIEW = {
  id: "fnd-7777000011112222",
  kind: "orphan",
  status: "open",
  title: "孤儿页：entities/ent-hermes.md 零入链（不被任何内容页引用）",
  detail: { page: "entities/ent-hermes.md" },
  pages: ["entities/ent-hermes.md"],
  rawRef: "",
  source: "patrol",
  createdAt: "2026-10-13 03:17:00",
  updatedAt: "2026-10-13 03:17:00",
}

const MSG = (id: string, role: "user" | "assistant", content: string) => ({
  id, session_id: "kc-s1", role, content, created_at: "2026-10-13T09:00:00Z",
  is_summary: false, is_compressed: false, is_edited: false,
})

interface FetchCall { url: string; method: string; body: string }
let calls: FetchCall[]
type Stub = { ok: boolean; status: number; json: () => Promise<unknown> }

function makeStub(opts: { fixScript?: string[] } = {}) {
  let fixPoll = 0
  let compilePoll = 0
  calls = []
  vi.stubGlobal("fetch", vi.fn(async (url: unknown, init?: { method?: string; body?: string }) => {
    const u = String(url)
    const method = init?.method ?? "GET"
    calls.push({ url: u, method, body: String(init?.body ?? "") })
    const json = (v: unknown): Stub => ({ ok: true, status: 200, json: async () => v })
    if (u.includes("/knowledge/wiki/tree")) return json(TREE)
    if (u.includes("/knowledge/fs")) return json({ org: "global", root: "knowledge", tree: [], truncated: false, total: 0 })
    if (u.includes("/knowledge/health")) return json(HEALTH)
    if (u.includes("/wiki/article/")) return json(ARTICLE)
    if (u.includes("/knowledge/findings/fix/task/")) {
      const script = opts.fixScript ?? ["committed"]
      const status = script[Math.min(fixPoll, script.length - 1)]
      fixPoll++
      return json({
        task: {
          id: "fft-1", findingId: "fnd-cafe000000000001", kind: "contradiction", status,
          ...(status === "committed" ? { result: { commit: COMMIT, changed: true, touched: [{ path: "topics/top-knowledge-injection.md", type: "topic", created: false }], warnings: [] } } : {}),
          ...(status === "failed" ? { error: { code: "FINDING_ANCHOR_LOST", message: "修订丢失在盘锚点" } } : {}),
        },
      })
    }
    if (u.includes("/knowledge/findings/") && u.includes("/adopt")) return json({ findingId: "fnd-cafe000000000001", taskId: "fft-1", status: "queued" })
    if (u.includes("/knowledge/findings/") && u.includes("/ignore")) return json({ findingId: "fnd-cafe000000000001", status: "ignored" })
    if (u.includes("/knowledge/findings")) return json({ org: "global", findings: opts.fixScript ? [] : [OPEN_FINDING_VIEW] })
    if (u.includes("/knowledge/patrol")) return json({ scanned: { pages: 12, executions: 2 }, findings: [{ id: OPEN_FINDING_VIEW.id, kind: "orphan", title: OPEN_FINDING_VIEW.title, pages: ["entities/ent-hermes.md"], action: "created" }], counts: { orphan: 1 }, newFindings: [{ id: OPEN_FINDING_VIEW.id, kind: "orphan", title: OPEN_FINDING_VIEW.title }], warnings: [] })
    if (u.includes("/knowledge/backfill")) return json({
      mode: "backfill", deduped: false,
      raw: { path: "raw/inbox/2026-10-13-lockfile-排障路径.md", hash: "9be21c401234567890abcdef1234567890abcdef1234567890abcdef12345678", origin: "chat:kc-s1", bytes: 1234 },
      compileTask: { taskId: "crt-7", status: "queued" },
    })
    if (u.includes("/wiki/compile/task/crt-7")) {
      const status = compilePoll === 0 ? "compiling" : "committed"
      compilePoll++
      return json(status === "committed"
        ? { task: { id: "crt-7", rawPath: "raw/inbox/x.md", status, result: { rawPath: "raw/inbox/x.md", rawHash: "9be21c40", rawTitle: "lockfile 排障路径", touched: [{ path: "topics/top-lockfile.md", type: "topic", created: true }], created: 2, updated: 0, contradictions: 0, commit: COMMIT, changed: true, deduped: false, warnings: [] } } }
        : { task: { id: "crt-7", rawPath: "raw/inbox/x.md", status } })
    }
    if (u.includes("/wiki/queue/task/")) return json({ task: { id: "x", opKind: "finding-fix", state: "running", position: null } })
    return json({})
  }))
}

function openDrawer() {
  fireEvent.click(screen.getByTestId("kc-drawer-toggle"))
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

describe("AC2 finding 卡三钮（Lane A 注册接位后走真卡，非兜底）", () => {
  it("渲染标题/双断言/涉事页；[采纳修订]→POST adopt→任务轮询→卡显「已修订 hash」终态", async () => {
    chatBox.messages = [MSG("a1", "assistant", serializeKcCardBlock(FINDING_EV))]
    makeStub({ fixScript: ["queued", "running", "committed"] })
    render(<KnowledgePage />)
    await screen.findByTestId("kc-tree-ready")
    openDrawer()

    const card = await screen.findByTestId("kc-card-finding")
    expect(card.textContent).toContain("规则由引擎预计算注入")
    expect(card.textContent).toContain("注入式冷启动重推导")
    expect(card.textContent).toContain("编译期矛盾")
    expect(card.textContent).not.toContain("未注册卡类") // 注册表接位生效

    fireEvent.click(screen.getByTestId("kc-finding-adopt"))
    await waitFor(() => expect(calls.some(c => c.method === "POST" && c.url.includes("/knowledge/findings/fnd-cafe000000000001/adopt"))).toBe(true))
    await waitFor(() => {
      expect(screen.getByTestId("kc-card-finding").textContent).toContain(`已修订 ${COMMIT.slice(0, 7)}`)
    }, { timeout: 5000 })
    // 终态：钮退场（裁决一次性）
    expect(screen.queryByTestId("kc-finding-adopt")).toBeNull()
    expect(screen.getByTestId("kc-finding-terminal").textContent).toContain("裁决已落地")
  }, 15000)

  it("[忽略]→POST ignore→卡显「已忽略」且钮退场；[讨论]→灌取号器零状态请求；涉事页钮→在主场打开", async () => {
    chatBox.messages = [MSG("a1", "assistant", serializeKcCardBlock(FINDING_EV))]
    makeStub({ fixScript: [] }) // 空 store 面：只测 Lane A 卡
    render(<KnowledgePage />)
    await screen.findByTestId("kc-tree-ready")
    openDrawer()
    await screen.findByTestId("kc-card-finding")

    // 讨论：纯对话，adopt/ignore 零 POST
    fireEvent.click(screen.getByTestId("kc-finding-discuss"))
    const composer = screen.getByPlaceholderText(/投喂|关于 finding/) as HTMLTextAreaElement
    expect(composer.value).toContain("关于 finding")
    expect(calls.filter(c => c.method === "POST" && c.url.includes("/adopt"))).toHaveLength(0)
    expect(calls.filter(c => c.method === "POST" && c.url.includes("/ignore"))).toHaveLength(0)

    // 涉事页钮（显式通道，非自动跟随）⇒ 主场正文渲染
    fireEvent.click(screen.getByTestId("kc-finding-page-top-knowledge-injection.md"))
    await waitFor(() => expect(screen.getByTestId("kc-page-title").textContent).toContain("知识注入沿革"))

    // 忽略
    fireEvent.click(screen.getByTestId("kc-finding-ignore"))
    await waitFor(() => expect(calls.some(c => c.method === "POST" && c.url.includes("/ignore"))).toBe(true))
    await waitFor(() => {
      expect(screen.getByTestId("kc-card-finding").textContent).toContain("已忽略")
    })
    expect(screen.queryByTestId("kc-finding-adopt")).toBeNull()
  }, 15000)

  it("采纳任务失败显形错误码，卡不消失且可再裁决", async () => {
    chatBox.messages = [MSG("a1", "assistant", serializeKcCardBlock(FINDING_EV))]
    makeStub({ fixScript: ["failed"] })
    render(<KnowledgePage />)
    await screen.findByTestId("kc-tree-ready")
    openDrawer()
    await screen.findByTestId("kc-card-finding")
    fireEvent.click(screen.getByTestId("kc-finding-adopt"))
    await waitFor(() => {
      const card = screen.getByTestId("kc-card-finding")
      expect(card.textContent).toContain("修订失败")
      expect(card.textContent).toContain("FINDING_ANCHOR_LOST")
    }, { timeout: 5000 })
  }, 15000)
})

describe("AC1/AC3 夜巡 findings 上屏 + 「体检一下」即时触发", () => {
  it("开放 findings 进 ⚠ FINDING 收件箱（bug-fix 20261016：不再钉尾流）：徽标计未裁决数，点开列卡；「体检一下」→POST /patrol→原文仍发策展人", async () => {
    render(<KnowledgePage />)
    await screen.findByTestId("kc-tree-ready")
    openDrawer()

    // 尾流不再被库级 findings 卡占据（负断言：未点收件箱前对话区零 finding 卡）
    await waitFor(() => expect(screen.getByTestId("kc-drawer-findings-badge").textContent).toBe("1"))
    expect(screen.queryByTestId("kc-card-finding")).toBeNull()

    // 点 ⚠ FINDING → 收件箱浮层以真卡渲染（在办 finding：patrol 新建的孤儿页）
    fireEvent.click(screen.getByTestId("kc-drawer-findings"))
    const pop = await screen.findByTestId("kc-drawer-findings-pop")
    const card = within(pop).getByTestId("kc-card-finding")
    expect(card.textContent).toContain("孤儿页：entities/ent-hermes.md")
    expect(card.textContent).toContain("语义巡检")

    const composer = screen.getByPlaceholderText(/投喂/)
    fireEvent.change(composer, { target: { value: "体检一下" } })
    fireEvent.click(document.querySelector("[data-tui-send]")!)
    await waitFor(() => expect(calls.some(c => c.method === "POST" && c.url.includes("/knowledge/patrol"))).toBe(true))
    expect(chatBox.sent).toContain("体检一下") // 对话不劫持：原文照常发策展人
  }, 15000)

  it("收件箱内裁决（忽略）⇒ 徽标数即时回落", async () => {
    render(<KnowledgePage />)
    await screen.findByTestId("kc-tree-ready")
    openDrawer()
    await waitFor(() => expect(screen.getByTestId("kc-drawer-findings-badge").textContent).toBe("1"))
    fireEvent.click(screen.getByTestId("kc-drawer-findings"))
    const pop = await screen.findByTestId("kc-drawer-findings-pop")
    fireEvent.click(within(pop).getByTestId("kc-finding-ignore"))
    await waitFor(() => expect(calls.some(c => c.method === "POST" && c.url.includes("/ignore"))).toBe(true))
    await waitFor(() => expect(screen.queryByTestId("kc-drawer-findings-badge")).toBeNull())
  }, 15000)
})

describe("AC4 回填卡 [编进 wiki]：摘录落 raw + diff 卡落对话流（ADR-0033：不跟随）；[不用] 零请求", () => {
  it("[编进 wiki]→POST /backfill→回执 raw 路径→编译 diff 卡落流至 commit", async () => {
    chatBox.messages = [MSG("a1", "assistant", serializeKcCardBlock(BACKFILL_EV))]
    render(<KnowledgePage />)
    await screen.findByTestId("kc-tree-ready")
    openDrawer()

    const card = await screen.findByTestId("kc-card-backfill")
    expect(card.textContent).toContain("lockfile")

    fireEvent.click(screen.getByTestId("kc-backfill-commit"))
    await waitFor(() => expect(calls.some(c => c.method === "POST" && c.url.includes("/knowledge/backfill") && c.body.includes("lockfile"))).toBe(true))
    // 回填卡落 raw 回执 + diff 卡（编译链）落流
    await waitFor(() => {
      expect(screen.getByTestId("kc-card-backfill").textContent).toContain("已入 raw · 编译投递")
    }, { timeout: 5000 })
    const diff = await screen.findByTestId("kc-card-compile-diff")
    await waitFor(() => {
      expect(screen.getByTestId("kc-card-compile-diff").textContent).toContain(`已提交 ${COMMIT.slice(0, 7)}`)
    }, { timeout: 5000 })
    expect(diff).toBeDefined()
  }, 15000)

  it("[不用] = 纯前端弃卡：卡消失且零 POST", async () => {
    chatBox.messages = [MSG("a1", "assistant", serializeKcCardBlock(BACKFILL_EV))]
    render(<KnowledgePage />)
    await screen.findByTestId("kc-tree-ready")
    openDrawer()
    await screen.findByTestId("kc-card-backfill")
    fireEvent.click(screen.getByTestId("kc-backfill-dismiss"))
    await waitFor(() => expect(screen.queryByTestId("kc-card-backfill")).toBeNull())
    expect(calls.filter(c => c.method === "POST" && c.url.includes("/backfill"))).toHaveLength(0)
  })
})
