// 票12 · /knowledge 对话即管理 + 卡片协议（写面）组件测试 — S4
// Seam: <KnowledgePage/>（票11 同款 fetch stub）+ 对话列（useAgentChat/clone-api 桩到
// 通道边界——卡流/投喂链/回滚钮/跟随与钉住/写保护零落盘在卡层断言）。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"

vi.mock("next/navigation", () => ({ usePathname: () => "/knowledge" }))
vi.mock("next/link", () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
}))
vi.mock("@/components/resource/MarkdownPreview", () => ({
  MarkdownPreview: ({ content }: { content: string }) => <div data-md-preview>{content}</div>,
}))

// ── 会话通道桩（票面 AC1「零自建聊天基建」= 本测试不引真 SSE；通道契约在
//    lib/agent 自有测试域。这里桩 useAgentChat + clone api，消息面可控注入）──
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
import { serializeKcCardBlock, parseKcCardBlocks, kcEventPageRefs, type KcCardEvent } from "@/lib/knowledge-center/card-protocol"
import { classifyKcFeed } from "@/lib/knowledge-center/feed-protocol"

// ── fixtures（expected 独立真相源：原型 Tab④ mockup 数字）──

const HEALTH = {
  org: "global",
  pages: { total: 52, entity: 7, concept: 9, topic: 11, source: 23, case: 2 },
  rawSources: 31, ingestedThisWeek: 5, openFindings: 2, queueDepth: 0,
  lastCompiled: "2026-10-13", gitHead: "a3f9c21d4b5e6f708192a3b4c5d6e7f8091a2b3c",
}

const TREE = {
  org: "global",
  domains: [
    { name: "entity", label: "Entities", count: 1, entries: [{ id: "ent-open-octopus", path: "entities/ent-open-octopus.md", title: "Open Octopus（平台 monorepo）", summary: "工作流编排平台", stability: "stable", ruleCount: 0 }] },
    { name: "concept", label: "Concepts", count: 1, entries: [{ id: "con-compiled-rag", path: "concepts/con-compiled-rag.md", title: "编译式 RAG", summary: "检索的重活在编译时", stability: "stable", ruleCount: 1 }] },
    { name: "topic", label: "Topics", count: 1, entries: [{ id: "top-knowledge-injection", path: "topics/top-knowledge-injection.md", title: "知识注入沿革", summary: "注入式→编译式", stability: "stable", ruleCount: 1 }] },
  ],
  stats: { entries: 3, cases: 0, rules: 3, lastCompiled: "2026-10-13" },
  log: null,
}

const ARTICLE_RAG = {
  id: "con-compiled-rag", domain: "concept", title: "编译式 RAG", summary: "检索的重活在编译时",
  topics: ["rag"], stability: "stable", lastCompiled: "2026-10-13", sources: ["raw/inbox/2026-10-13-karpathy-llm-wiki.md"],
  confidence: 0.9, path: "concepts/con-compiled-rag.md", updatedAt: "2026-10-13 09:12:00",
  body: "## 定义\n\n检索的重活从 query 时挪到维护编译时。", anchors: [], gitHistory: [], case: null,
  page: { type: "concept", entityKind: null, aliases: [], links: [] },
}
const ARTICLE_INJ = { ...ARTICLE_RAG, id: "top-knowledge-injection", domain: "topic", title: "知识注入沿革", path: "topics/top-knowledge-injection.md", body: "## 沿革\n\n注入式已废止。", page: { type: "topic", entityKind: null, aliases: [], links: [] } }

const COMMIT = "a3f9c21d4b5e6f708192a3b4c5d6e7f8091a2b3c"
const REVERT_COMMIT = "b71e004d4b5e6f708192a3b4c5d6e7f8091a2b3c"

const MSG = (id: string, role: "user" | "assistant", content: string) => ({
  id, session_id: "kc-s1", role, content, created_at: "2026-10-13T09:00:00Z",
  is_summary: false, is_compressed: false, is_edited: false,
})

const INGEST_EV: KcCardEvent = { id: "ing-4f2a9c12", kind: "ingest", ts: "2026-10-13T09:00:01Z", data: { status: "done", rawPath: "raw/inbox/2026-10-13-karpathy-llm-wiki.md", bytes: 12288, hash: "4f2a9c1234567890", origin: "url:https://gist.github.com/karpathy/442a6bf", title: "Karpathy LLM Wiki" } }
const SUMMARY_EV: KcCardEvent = { id: "sum-crt-1", kind: "source-summary", ts: "2026-10-13T09:00:02Z", data: { sourcePath: "sources/2026-10-13-karpathy-llm-wiki.md", rawPath: "raw/inbox/2026-10-13-karpathy-llm-wiki.md", hash: "4f2a9c1234567890", points: ["三层架构 raw/wiki/schema", "三操作 ingest/query/lint", "无审批——人管输入与方向"] } }
const DIFF_EV: KcCardEvent = { id: "dif-crt-1", kind: "compile-diff", ts: "2026-10-13T09:00:03Z", data: { taskId: "crt-1", status: "committed", commit: COMMIT, rawPath: "raw/inbox/2026-10-13-karpathy-llm-wiki.md", touched: [{ path: "concepts/con-compiled-rag.md", type: "concept", created: true }, { path: "entities/ent-open-octopus.md", type: "entity" }, { path: "topics/top-knowledge-injection.md", type: "topic" }], created: 1, updated: 2, contradictions: 1, ftsOk: true } }
const ARCHIVE_EV: KcCardEvent = { id: "dif-crt-9", kind: "archive-compile", ts: "2026-10-13T09:10:00Z", data: { taskLabel: "task-207「actuator 增强」", status: "committed", commit: REVERT_COMMIT, rawPath: "raw/archives/task-207-summary.md", touched: [{ path: "entities/ent-hermes.md", type: "entity", created: true }], created: 1, updated: 3, contradictions: 0, ftsOk: true } }
const MINI_EV: KcCardEvent = { id: "pgm-top-knowledge-injection", kind: "page-mini", ts: "2026-10-13T09:00:04Z", data: { pageId: "top-knowledge-injection", path: "topics/top-knowledge-injection.md", title: "知识注入沿革", type: "topic" } }
const GUARD_EV: KcCardEvent = { id: "grd-pref-1", kind: "guard", ts: "2026-10-13T09:00:05Z", data: { target: "user_preference.md", intent: "把默认模型建议改为 pro-max", suggestion: "建议在「模型偏好」节追加：默认模型 = pro-max", manualSteps: ["打开 ~/.octopus/knowledge/user_preference.md", "编辑对应节", "保存即生效（AI 永不写此文件）"] } }

interface FetchCall { url: string; method: string; body: string }
let calls: FetchCall[]
type Stub = { ok: boolean; status: number; json: () => Promise<unknown> }

/** 任务状态脚本桩：pollCount 按调用次数递进（queued #N → compiling → committed）。 */
function makeStub(opts: { compileScript?: string[]; revertScript?: string[]; revertAckTaskId?: string } = {}) {
  let compilePoll = 0
  let revertPoll = 0
  calls = []
  vi.stubGlobal("fetch", vi.fn(async (url: unknown, init?: { method?: string; body?: string }) => {
    const u = String(url)
    const method = init?.method ?? "GET"
    calls.push({ url: u, method, body: String(init?.body ?? "") })
    const json = (v: unknown): Stub => ({ ok: true, status: 200, json: async () => v })
    if (u.includes("/knowledge/wiki/tree")) return json(TREE)
    if (u.includes("/knowledge/health")) return json(HEALTH)
    if (u.includes("/wiki/article/top-knowledge-injection")) return json(ARTICLE_INJ)
    if (u.includes("/wiki/article/")) return json(ARTICLE_RAG)
    if (u.includes("/knowledge/raw/")) return json({ path: "raw/inbox/2026-10-13-karpathy-llm-wiki.md", bytes: 12288, hash: "4f2a9c1234567890", origin: "url:https://gist.github.com/karpathy/442a6bf", title: "Karpathy LLM Wiki", ingestedAt: "2026-10-13T09:00:01Z", content: "# llm wiki\n三层架构\n" })
    if (u.includes("/api/knowledge/ingest")) return json({
      mode: "url", dir: "inbox", title: "Karpathy LLM Wiki", deduped: false,
      raw: { path: "raw/inbox/2026-10-13-karpathy-llm-wiki.md", bytes: 12288, hash: "4f2a9c1234567890", origin: "url:https://gist", title: "Karpathy LLM Wiki", ingestedAt: "2026-10-13T09:00:01Z" },
      compileTask: { taskId: "crt-1", status: "queued" },
    })
    if (u.includes("/wiki/compile/task/")) {
      const status = (opts.compileScript ?? ["committed"])[Math.min(compilePoll, (opts.compileScript ?? ["committed"]).length - 1)]
      compilePoll++
      return json({ task: status === "queued" ? { id: "crt-1", rawPath: "raw/inbox/x.md", status }
        : status === "compiling" ? { id: "crt-1", rawPath: "raw/inbox/x.md", status }
          : { id: "crt-1", rawPath: "raw/inbox/x.md", status, result: { rawPath: "raw/inbox/x.md", rawHash: "4f2a9c1234567890", rawTitle: "Karpathy LLM Wiki", touched: [{ path: "concepts/con-compiled-rag.md", type: "concept", created: true }, { path: "sources/2026-10-13-karpathy-llm-wiki.md", type: "source", created: true }], created: 2, updated: 0, contradictions: 0, commit: COMMIT, changed: true, deduped: false, warnings: [] } } })
    }
    if (u.includes("/wiki/queue/task/")) {
      const pos = compilePoll === 0 ? 2 : null
      return json({ task: { id: "crt-1", opKind: "ingest-compile", state: pos ? "queued" : "running", position: pos } })
    }
    if (u.includes("/wiki/revert/task/")) {
      const script = opts.revertScript ?? ["committed"]
      const status = script[Math.min(revertPoll, script.length - 1)]
      revertPoll++
      return json({ task: status === "committed"
        ? { id: "rvt-1", commit: COMMIT, status, result: { target: COMMIT, revertCommit: REVERT_COMMIT, touched: [], ftsWarnings: [] } }
        : { id: "rvt-1", commit: COMMIT, status } })
    }
    if (u.includes("/wiki/revert")) return json({ taskId: opts.revertAckTaskId ?? "rvt-1", commit: COMMIT, status: "queued" })
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

describe("AC1 通道复用：对话列挂载（clone-session 通道 + TuiTranscript 形制）", () => {
  it("抽屉打开挂 kc-chat-column；archive 分身会话通道被使用；TUI 形制渲染既有消息", async () => {
    chatBox.messages = [MSG("m1", "user", "把这篇文章编进 wiki：https://gist.github.com/karpathy/442a6bf"), MSG("m2", "assistant", "编译完成，触及 12 页。")]
    render(<KnowledgePage />)
    await screen.findByTestId("kc-tree-ready")
    expect(screen.queryByTestId("kc-chat-column")).toBeNull() // 默认全宽（票11 行为保持）
    openDrawer()
    await screen.findByTestId("kc-chat-column")
    expect(document.querySelectorAll('[data-tui-msg="user"]').length).toBe(1) // TUI 用户行（TuiTranscript 复用形制）
    expect(document.querySelectorAll('[data-tui-msg="assistant"]').length).toBe(1)
    expect(screen.getByText(/编译完成，触及 12 页/)).toBeDefined()
  })
})

describe("AC2 卡片协议首批五类渲染（Lane A：消息正文 fenced 块）", () => {
  it("五类卡各就位；fenced JSON 从正文剥除；未注册 kind 走通用兜底（票13 接位验证）", async () => {
    chatBox.messages = [MSG("a1", "assistant", [
      serializeKcCardBlock(INGEST_EV),
      serializeKcCardBlock(SUMMARY_EV),
      serializeKcCardBlock(DIFF_EV),
      serializeKcCardBlock(MINI_EV),
      serializeKcCardBlock(GUARD_EV),
      "正文里还有一句 [[con-compiled-rag]]。",
    ].join("\n\n"))]
    render(<KnowledgePage />)
    await screen.findByTestId("kc-tree-ready")
    openDrawer()

    // 抓取卡：raw 路径 + 大小/hash
    expect((await screen.findByTestId("kc-card-ingest")).textContent).toContain("raw/inbox/2026-10-13-karpathy-llm-wiki.md")
    expect(screen.getByTestId("kc-card-ingest").textContent).toContain("12.0 KB")
    expect(screen.getByTestId("kc-card-ingest").textContent).toContain("4f2a9c")
    // 来源摘要卡：sources 页 + 要点
    expect(screen.getByTestId("kc-card-source-summary").textContent).toContain("sources/2026-10-13-karpathy-llm-wiki.md")
    expect(screen.getByTestId("kc-card-source-summary").textContent).toContain("三层架构")
    // 编译 diff 卡：commit 短 hash + 触及清单 + 冲突数（amber 语义在钮/行文案）
    expect(screen.getByTestId("kc-card-compile-diff").textContent).toContain("a3f9c21")
    expect(screen.getByTestId("kc-card-compile-diff").textContent).toContain("3 页 =")
    expect(screen.getByTestId("kc-card-compile-diff").textContent).toContain("冲突")
    expect(screen.getByTestId("kc-card-compile-diff").textContent).toContain("矛盾标记")
    // 词条迷你卡：标题 + 右栏渲染/全页打开
    expect(screen.getByTestId("kc-card-page-mini").textContent).toContain("知识注入沿革")
    // 写保护卡
    expect(screen.getByTestId("kc-card-guard").textContent).toContain("user_preference.md")
    // fenced 块本体不渲染为 JSON 文本（剥除），但正文本体在
    expect(screen.queryByText(/"taskId":"crt-1"/)).toBeNull()
    expect(screen.getByText(/正文里还有一句/)).toBeDefined()
  })

  it("未注册卡类（未来 kind——票13 后 finding/backfill 已注册，兜底改钉未来位）渲染通用兜底卡，不炸流", async () => {
    chatBox.messages = [MSG("a1", "assistant", serializeKcCardBlock({ id: "xyz-1", kind: "probe-future", ts: "2026-10-13T09:00:06Z", data: { note: "尚未注册的卡类" } }))]
    render(<KnowledgePage />)
    await screen.findByTestId("kc-tree-ready")
    openDrawer()
    const unknown = await screen.findByTestId("kc-card-unknown")
    expect(unknown.textContent).toContain("未注册卡类 · probe-future")
    expect(unknown.textContent).toContain("尚未注册")
  })
})

describe("AC3 对话内投喂全链 + 队列状态流转（排队中 #N → 编译中 → 已提交 hash）", () => {
  it("URL 投喂：抓取卡→摘要卡→diff卡 状态逐拍推进；原文同步发策展人", async () => {
    makeStub({ compileScript: ["queued", "compiling", "committed"] })
    render(<KnowledgePage />)
    await screen.findByTestId("kc-tree-ready")
    openDrawer()

    const composer = screen.getByPlaceholderText(/投喂 raw/)
    fireEvent.change(composer, { target: { value: "把这篇文章编进 wiki：https://gist.github.com/karpathy/442a6bf" } })
    fireEvent.click(document.querySelector("[data-tui-send]")!)
    await waitFor(() => expect(screen.getByTestId("kc-card-ingest").textContent).toContain("已落 raw"))

    const diff = await screen.findByTestId("kc-card-compile-diff")
    expect(diff.textContent).toMatch(/排队中 #2|编译中|已提交 a3f9c21/) // 首拍即排队中 #2（stub 位次）
    await waitFor(() => {
      const d = screen.getByTestId("kc-card-compile-diff")
      expect(d.textContent).toContain("已提交 a3f9c21")
      expect(d.textContent).toContain("2 页") // committed 明细回灌（概念+来源）
    }, { timeout: 5000 })
    await screen.findByTestId("kc-card-source-summary") // 摘要卡在 committed 后追加
    expect(chatBox.sent).toContain("把这篇文章编进 wiki：https://gist.github.com/karpathy/442a6bf")
    expect(calls.some(c => c.method === "POST" && c.url.includes("/api/knowledge/ingest"))).toBe(true)
  }, 15000)
})

describe("AC5 回滚钮：二次确认 → POST /revert → 任务态回灌原卡", () => {
  it("点回滚先出二次确认（未点确认零请求）；确认后 POST revert 且卡显「已回滚 hash」", async () => {
    chatBox.messages = [MSG("a1", "assistant", serializeKcCardBlock(DIFF_EV))]
    makeStub({ revertScript: ["queued", "running", "committed"] })
    render(<KnowledgePage />)
    await screen.findByTestId("kc-tree-ready")
    openDrawer()

    const card = await screen.findByTestId("kc-card-compile-diff")
    fireEvent.click(screen.getByTestId("kc-revert-arm"))
    expect(card.textContent).not.toMatch(/已回滚/)
    expect(screen.getByTestId("kc-revert-confirm")).toBeDefined()
    expect(calls.some(c => c.method === "POST" && c.url.includes("/wiki/revert"))).toBe(false) // 二次确认闸

    fireEvent.click(screen.getByTestId("kc-revert-confirm"))
    await waitFor(() => expect(calls.some(c => c.method === "POST" && c.url.includes("/wiki/revert") && c.body.includes(COMMIT))).toBe(true))
    await waitFor(() => {
      expect(screen.getByTestId("kc-card-compile-diff").textContent).toContain(`已回滚 ${REVERT_COMMIT.slice(0, 7)}`)
    }, { timeout: 5000 })
  }, 15000)

  it("回滚任务失败显形错误码（任务级 failed 码如 LOCK_HELD；票02 后 REVERT_CONFLICT 已废），卡不消失", async () => {
    chatBox.messages = [MSG("a1", "assistant", serializeKcCardBlock(DIFF_EV))]
    makeStub()
    // revert 任务直接 failed（注入形态：任务面返回 failed + code）
    vi.stubGlobal("fetch", vi.fn(async (url: unknown, init?: { method?: string; body?: string }) => {
      const u = String(url)
      const json = (v: unknown): Stub => ({ ok: true, status: 200, json: async () => v })
      if (u.includes("/wiki/queue/task/")) return json({ task: { id: "rvt-1", opKind: "revert", state: "failed", position: null, error: { code: "LOCK_HELD", message: "锁被占用" } } })
      if (u.includes("/wiki/revert/task/")) return json({ task: { id: "rvt-1", commit: COMMIT, status: "failed", error: { code: "LOCK_HELD", message: "锁被占用" } } })
      if (u.includes("/wiki/revert")) return json({ taskId: "rvt-1", commit: COMMIT, status: "queued" })
      if (u.includes("/knowledge/wiki/tree")) return json(TREE)
      if (u.includes("/knowledge/health")) return json(HEALTH)
      if (u.includes("/wiki/article/")) return json(ARTICLE_RAG)
      return json({})
    }))
    render(<KnowledgePage />)
    await screen.findByTestId("kc-tree-ready")
    openDrawer()
    await screen.findByTestId("kc-card-compile-diff")
    fireEvent.click(screen.getByTestId("kc-revert-arm"))
    fireEvent.click(screen.getByTestId("kc-revert-confirm"))
    await waitFor(() => {
      const card = screen.getByTestId("kc-card-compile-diff")
      expect(card.textContent).toContain("回滚失败")
      expect(card.textContent).toContain("LOCK_HELD")
    }, { timeout: 5000 })
  }, 15000)
})

describe("AC4 右栏跟随与钉住", () => {
  it("未钉住：新卡提到页 ⇒ 右栏自动渲染该页（跟随）", async () => {
    chatBox.messages = [MSG("a1", "assistant", serializeKcCardBlock(MINI_EV))]
    render(<KnowledgePage />)
    await screen.findByTestId("kc-tree-ready")
    openDrawer()
    await waitFor(() => expect(screen.getByTestId("kc-page-title").textContent).toContain("知识注入沿革"), { timeout: 3000 })
  })

  it("钉住后新卡不再抢视图；手动「右栏渲染」仍可跳转", async () => {
    chatBox.messages = [MSG("a1", "assistant", serializeKcCardBlock(DIFF_EV))] // 首卡→跟随 concepts 页
    const { rerender } = render(<KnowledgePage />)
    await screen.findByTestId("kc-tree-ready")
    openDrawer()
    await waitFor(() => expect(screen.getByTestId("kc-page-title").textContent).toContain("编译式 RAG"))

    fireEvent.click(screen.getByTestId("kc-pin-toggle"))
    expect(screen.getByTestId("kc-pin-toggle").textContent).toContain("已钉住")

    // 新卡（另一页）进入消息流：跟随停止
    chatBox.messages = [...chatBox.messages, MSG("a2", "assistant", serializeKcCardBlock(MINI_EV))]
    rerender(<KnowledgePage />)
    await new Promise(r => setTimeout(r, 50))
    expect(screen.getByTestId("kc-page-title").textContent).toContain("编译式 RAG")

    // 手动钮不受钉住限制
    fireEvent.click(screen.getByTestId("kc-mini-follow"))
    await waitFor(() => expect(screen.getByTestId("kc-page-title").textContent).toContain("知识注入沿革"))
  })

  it("全页打开 = 切浏览模式并渲染", async () => {
    chatBox.messages = [MSG("a1", "assistant", serializeKcCardBlock(MINI_EV))]
    render(<KnowledgePage />)
    await screen.findByTestId("kc-tree-ready")
    openDrawer()
    await screen.findByTestId("kc-card-page-mini")
    fireEvent.click(screen.getByTestId("kc-mini-open"))
    await waitFor(() => expect(screen.queryByTestId("kc-chat-column")).toBeNull())
    expect(screen.getByTestId("kc-page-title").textContent).toContain("知识注入沿革")
  })
})

describe("AC6 写保护卡：零自动落盘", () => {
  it("卡上交互（查看建议展开）不发任何请求；建议文本+人工步骤在卡面；右栏不跳", async () => {
    chatBox.messages = [MSG("a1", "assistant", serializeKcCardBlock(GUARD_EV))]
    render(<KnowledgePage />)
    await screen.findByTestId("kc-tree-ready")
    openDrawer()
    const card = await screen.findByTestId("kc-card-guard")
    expect(card.textContent).toContain("user_preference.md")
    fireEvent.click(screen.getByTestId("kc-guard-toggle"))
    expect(screen.getByTestId("kc-guard-detail").textContent).toContain("默认模型 = pro-max")
    expect(screen.getByTestId("kc-guard-detail").textContent).toContain("人工确认步骤")
    // 零写请求（GET 树/健康为页面常态读；POST=0）
    expect(calls.filter(c => c.method === "POST").length).toBe(0)
    // 写保护卡不触发跟随（无页引用）
    expect(screen.queryByTestId("kc-page-title")).toBeNull()
  })
})

describe("归档编译卡（AC2 第五类）+ 对策展人说", () => {
  it("渲染 task 标签与 commit；「对策展人说」预进取号器", async () => {
    chatBox.messages = [MSG("a1", "assistant", serializeKcCardBlock(ARCHIVE_EV))]
    render(<KnowledgePage />)
    await screen.findByTestId("kc-tree-ready")
    openDrawer()
    const card = await screen.findByTestId("kc-card-archive-compile")
    expect(card.textContent).toContain("task-207「actuator 增强」")
    expect(card.textContent).toContain("b71e004")
    fireEvent.click(screen.getByTestId("kc-archive-say"))
    const composer = screen.getByPlaceholderText(/关于归档编译|投喂 raw/)
    expect((composer as HTMLTextAreaElement).value).toContain("关于归档编译")
  })
})

describe("D-kc15-1 抓取卡「重试编译」入口（票07 S4）", () => {
  /** 重试剧本桩：crt-1 编译失败（带错误码）→ 点重试 POST /wiki/compile → crt-2 queued→committed。 */
  function makeRetryStub() {
    calls = []
    let crt2Poll = 0
    vi.stubGlobal("fetch", vi.fn(async (url: unknown, init?: { method?: string; body?: string }) => {
      const u = String(url)
      const method = init?.method ?? "GET"
      calls.push({ url: u, method, body: String(init?.body ?? "") })
      const json = (v: unknown, status = 200): Stub => ({ ok: status < 400, status, json: async () => v })
      if (u.includes("/knowledge/wiki/tree")) return json(TREE)
      if (u.includes("/knowledge/health")) return json(HEALTH)
      if (u.includes("/wiki/article/")) return json(ARTICLE_RAG)
      if (u.includes("/api/knowledge/ingest")) return json({
        mode: "url", dir: "inbox", title: "Karpathy LLM Wiki", deduped: false,
        raw: { path: "raw/inbox/2026-10-13-karpathy-llm-wiki.md", bytes: 12288, hash: "4f2a9c1234567890", origin: "url:https://gist", title: "Karpathy LLM Wiki", ingestedAt: "2026-10-13T09:00:01Z" },
        compileTask: { taskId: "crt-1", status: "queued" },
      })
      if (u.includes("/wiki/compile/task/crt-1")) return json({ task: { id: "crt-1", rawPath: "raw/inbox/x.md", status: "failed", error: { code: "COMPILE_FAILED", message: "L5_DATES_IN_BODY: 正文出现日期（自纠一轮仍未过闸）" } } })
      if (u.includes("/wiki/queue/task/crt-1")) return json({ task: { id: "crt-1", opKind: "ingest-compile", state: "failed", position: null, error: { code: "COMPILE_FAILED", message: "L5_DATES_IN_BODY" } } })
      if (u.includes("/api/knowledge/wiki/compile") && method === "POST") return json({ taskId: "crt-2", rawPath: "raw/inbox/2026-10-13-karpathy-llm-wiki.md", status: "queued" }, 202)
      if (u.includes("/wiki/compile/task/crt-2")) {
        const status = crt2Poll++ === 0 ? "queued" : "committed"
        return json({ task: status === "queued" ? { id: "crt-2", rawPath: "raw/inbox/x.md", status } : { id: "crt-2", rawPath: "raw/inbox/x.md", status, result: { rawPath: "raw/inbox/x.md", rawHash: "4f2a9c1234567890", rawTitle: "Karpathy LLM Wiki", touched: [{ path: "concepts/con-retried.md", type: "concept", created: true }, { path: "sources/2026-10-13-karpathy-llm-wiki.md", type: "source", created: true }], created: 2, updated: 0, contradictions: 0, commit: COMMIT, changed: true, deduped: false, warnings: [] } } })
      }
      if (u.includes("/wiki/queue/task/crt-2")) return json({ task: { id: "crt-2", opKind: "ingest-compile", state: crt2Poll <= 1 ? "queued" : "running", position: crt2Poll <= 1 ? 1 : null } })
      return json({})
    }))
  }

  it("编译失败态挂「重试编译」钮；点击 ⇒ POST /wiki/compile（同 rawPath，经队列通道）⇒ 新 diff 卡推进到已提交，重试钮消失", async () => {
    makeRetryStub()
    render(<KnowledgePage />)
    await screen.findByTestId("kc-tree-ready")
    openDrawer()

    // 投喂 → 抓取卡落 raw → crt-1 编译失败
    const composer = screen.getByPlaceholderText(/投喂 raw/)
    fireEvent.change(composer, { target: { value: "把这篇文章编进 wiki：https://gist.github.com/karpathy/442a6bf" } })
    fireEvent.click(document.querySelector("[data-tui-send]")!)
    const ingest = await screen.findByTestId("kc-card-ingest")
    await waitFor(() => {
      expect(screen.getByTestId("kc-card-ingest").textContent).toContain("编译失败")
      expect(screen.getByTestId("kc-card-ingest").textContent).toContain("COMPILE_FAILED")
    }, { timeout: 5000 })
    expect(screen.getByTestId("kc-ingest-retry-compile")).toBeDefined()
    expect(ingest.textContent).toContain("已落 raw") // raw 不可变仍在（重试只重编译）

    // 点击重试：走 POST /api/knowledge/wiki/compile（红线2 队列通道，非直写）——body 带原 rawPath
    fireEvent.click(screen.getByTestId("kc-ingest-retry-compile"))
    await waitFor(() => {
      const hit = calls.find(c => c.method === "POST" && c.url.includes("/api/knowledge/wiki/compile"))
      expect(hit, "重试必须 POST /wiki/compile").toBeDefined()
      expect(hit!.body).toContain("raw/inbox/2026-10-13-karpathy-llm-wiki.md")
    }, { timeout: 5000 })

    // 新任务 diff 卡（crt-2）推进到已提交（历史 dif-crt-1 失败卡保留在流里=审计面）；
    // 抓取卡失败态解除、重试钮消失
    await waitFor(() => {
      const diffs = screen.getAllByTestId("kc-card-compile-diff")
      expect(diffs.some(d => d.textContent?.includes("已提交 a3f9c21"))).toBe(true)
    }, { timeout: 8000 })
    await waitFor(() => {
      expect(screen.getByTestId("kc-card-ingest").textContent).not.toContain("编译失败")
      expect(screen.queryByTestId("kc-ingest-retry-compile")).toBeNull()
    }, { timeout: 5000 })
  }, 20000)

  it("committed 正常链不挂重试钮（入口只长在完成态之外的失败态上）", async () => {
    makeStub({ compileScript: ["queued", "compiling", "committed"] })
    render(<KnowledgePage />)
    await screen.findByTestId("kc-tree-ready")
    openDrawer()
    const composer = screen.getByPlaceholderText(/投喂 raw/)
    fireEvent.change(composer, { target: { value: "把这篇文章编进 wiki：https://gist.github.com/karpathy/442a6bf" } })
    fireEvent.click(document.querySelector("[data-tui-send]")!)
    await waitFor(() => expect(screen.getByTestId("kc-card-ingest").textContent).toContain("已落 raw"), { timeout: 5000 })
    expect(screen.queryByTestId("kc-ingest-retry-compile")).toBeNull()
  }, 15000)
})

describe("纯协议函数（票13 依赖的接位件行为钉）", () => {  it("classifyKcFeed 三形态 + 动词门", () => {
    expect(classifyKcFeed("把这篇文章编进 wiki：https://gist.github.com/karpathy/442")).toEqual({ mode: "url", url: "https://gist.github.com/karpathy/442" })
    expect(classifyKcFeed("投喂这个本地文件：C:\\notes\\meeting.md 编进 wiki")).toEqual({ mode: "file", path: "C:\\notes\\meeting.md" })
    expect(classifyKcFeed("投喂文本：\n会议纪要：发布纪律更新\n第二条")).toEqual({ mode: "text", text: "会议纪要：发布纪律更新\n第二条" })
    expect(classifyKcFeed("https://example.com 只是随口提个链接")).toBeNull() // 无动词不投喂
    expect(classifyKcFeed("上次投喂的那篇讲了啥？")).toBeNull() // 动词在、无可投对象=对话
  })

  it("parseKcCardBlocks：合法剥除 / 非法显形；refs 判据；坏形状事件丢弃", () => {
    const good = parseKcCardBlocks(serializeKcCardBlock(MINI_EV))
    expect(good.events).toHaveLength(1)
    expect(good.rest).toBe("")
    const bad = parseKcCardBlocks("```kc-card\n{not json}\n```\n正文")
    expect(bad.events).toHaveLength(0)
    expect(bad.rest).toContain("{not json}") // 显形留原文
    expect(kcEventPageRefs(MINI_EV)).toEqual(["top-knowledge-injection"])
    expect(kcEventPageRefs(INGEST_EV)).toEqual([])
    expect(kcEventPageRefs(DIFF_EV)).toEqual(["concepts/con-compiled-rag.md"]) // 首个 created 页优先
    expect(parseKcCardBlocks(serializeKcCardBlock({ id: "x", kind: "ingest", ts: "t", data: "not-object" as never })).events).toHaveLength(0)
  })
})
