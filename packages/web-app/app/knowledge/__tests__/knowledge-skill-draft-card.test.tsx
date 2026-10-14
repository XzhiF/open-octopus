// P3 票04 · /knowledge skill 草案卡（S4 组件测试，仿票03 knowledge-case-card 风格）
// Seam: <KnowledgePage/>（fetch stub 到 API 边界）+ Lane A fenced 卡注入。
// expected 真相源：票面「skill 草案卡：SKILL.md 完整渲染（name/description/触发条件/
// 步骤/纪律）+ 来源指针可点」+ spec §卡片与 UI；**红线4 负断言：卡上零授予钮**。
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
import {
  kcEventPageRefs,
  serializeKcCardBlock,
  type KcCardEvent,
  type KcSkillDraftCardData,
} from "@/lib/knowledge-center/card-protocol"

// ── fixtures（票面+协议单源逐字段；expected 真相源=票04 票面 + KcSkillDraftCardData）──

const HEALTH = {
  org: "global",
  pages: { total: 54, entity: 7, concept: 9, topic: 12, source: 23, case: 2 },
  rawSources: 33, ingestedThisWeek: 5, openFindings: 0, queueDepth: 0,
  lastCompiled: "2026-10-14", gitHead: "a3f9c21d4b5e6f708192a3b4c5d6e7f8091a2b3c",
}
const TREE = {
  org: "global",
  domains: [
    { name: "cases", label: "Cases", count: 1, entries: [{ id: "case-msys", path: "cases/2026-10-12-case-msys.md", title: "Git Bash ref 冒号被转成路径", summary: "Git Bash ref 冒号被转成路径", stability: "stable", ruleCount: 0 }] },
  ],
  stats: { entries: 0, cases: 1, rules: 0, lastCompiled: "2026-10-14" },
  log: null,
}

const DRAFT_BODY = "# 重复操作流 task-aa04-a × task-aa04-b\n\n## 触发条件\n\n- 同形失败工具序列（相似 1.00）。\n\n## 步骤\n\n1. read\n2. bash\n3. edit\n\n## 纪律\n\n- 草案未经授予不生效。\n"

const DRAFT_EV: KcCardEvent = {
  id: "skl-flow-85153203c0",
  kind: "skill-draft",
  ts: "2026-10-14T09:20:00Z",
  data: {
    draftName: "flow-85153203c0",
    description: "跨 task 重复的依赖修复序列（task-aa04-a × task-aa04-b，相似 1.00）",
    status: "draft",
    origin: "sequence-similar",
    source: "pack:task-aa04-a; pack:task-aa04-b",
    skillPath: "drafts/skills/flow-85153203c0/SKILL.md",
    content: DRAFT_BODY,
    sourceRefs: [
      { kind: "pack", pointer: "raw/archives/task-aa04-a/03-exec-jsonl-excerpt.md", label: "exec 摘录 · task-aa04-a" },
      { kind: "pack", pointer: "raw/archives/task-aa04-b/03-exec-jsonl-excerpt.md", label: "exec 摘录 · task-aa04-b" },
    ],
    skillName: "flow-85153203c0",
    taskId: "aa04-a",
    similarity: 1,
    action: "created",
  } as unknown as KcSkillDraftCardData,
}

const CASE_ORIGIN_EV: KcCardEvent = {
  id: "skl-flow-case-msys",
  kind: "skill-draft",
  ts: "2026-10-14T09:30:00Z",
  data: {
    ...DRAFT_EV.data,
    draftName: "flow-case-msys",
    origin: "case-procedural",
    source: "case:case-msys",
    caseId: "case-msys",
    ruleRef: "oct-001",
    skillPath: "drafts/skills/flow-case-msys/SKILL.md",
    sourceRefs: [{ kind: "case", pointer: "cases/2026-10-12-case-msys.md", label: "Git Bash ref 冒号被转成路径" }],
  } as unknown as KcSkillDraftCardData,
}

const REVOKED_EV: KcCardEvent = {
  id: "skl-flow-dead",
  kind: "skill-draft",
  ts: "2026-10-14T09:40:00Z",
  data: {
    ...DRAFT_EV.data,
    draftName: "flow-dead",
    status: "revoked",
    action: "retired",
  } as unknown as KcSkillDraftCardData,
}

const MSG = (id: string, role: "user" | "assistant", content: string) => ({
  id, session_id: "kc-s1", role, content, created_at: "2026-10-14T09:00:00Z",
  is_summary: false, is_compressed: false, is_edited: false,
})

interface FetchCall { url: string; method: string }
let calls: FetchCall[]

function makeStub() {
  calls = []
  vi.stubGlobal("fetch", vi.fn(async (url: unknown, init?: { method?: string; body?: string }) => {
    const u = String(url)
    calls.push({ url: u, method: init?.method ?? "GET" })
    const json = (v: unknown) => ({ ok: true, status: 200, json: async () => v })
    if (u.includes("/knowledge/wiki/tree")) return json(TREE)
    if (u.includes("/knowledge/health")) return json(HEALTH)
    if (u.includes("/wiki/article/")) return json({ id: "case-msys", domain: "cases", title: "Git Bash ref 冒号被转成路径", summary: "s", topics: [], stability: "stable", lastCompiled: "2026-10-14", sources: [], confidence: 1, path: "cases/2026-10-12-case-msys.md", updatedAt: "2026-10-14 09:12:00", body: "## 现场\n\n冒号坑。", anchors: [], gitHistory: [], case: { symptom: "Git Bash ref 冒号被转成路径", tags: [], severity: "blocker", occurrences: 3, ruleRef: "oct-001", status: "distilled" }, page: null })
    if (u.includes("/api/knowledge/raw/")) return json({ content: "- [t] do-a · tool_call :: {\"toolName\":\"Read\"}", bytes: 42, hash: "aa" })
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

describe("票04 skill 草案卡：SKILL.md 完整渲染 + 来源指针可点 + 对话改写入口（注册表一行注册生效）", () => {
  it("Lane A 注入草案卡 ⇒ 真卡渲染：草案名/描述/origin 三路标/来源指针原文 + SKILL.md 全文进预览（触发条件/步骤/纪律在场）", async () => {
    chatBox.messages = [MSG("a1", "assistant", serializeKcCardBlock(DRAFT_EV))]
    render(<KnowledgePage />)
    await screen.findByTestId("kc-tree-ready")
    openDrawer()

    const card = await screen.findByTestId("kc-card-skill-draft")
    expect(card.textContent).toContain("flow-85153203c0")
    expect(card.textContent).toContain("序列相似") // origin 三路中文标
    expect(card.textContent).toContain("pack:task-aa04-a; pack:task-aa04-b")
    // SKILL.md 完整渲染（票面逐字：触发条件/步骤/纪律 全文进 MarkdownPreview）
    const md = card.querySelector("[data-md-preview]")
    expect(md?.textContent).toContain("## 触发条件")
    expect(md?.textContent).toContain("2. bash")
    expect(md?.textContent).toContain("草案未经授予不生效")
    expect(card.textContent).not.toContain("未注册卡类")
  })

  it("来源指针可点：[开原文] ⇒ GET /api/knowledge/raw/{件路径}（右栏渲染素材件）", async () => {
    chatBox.messages = [MSG("a1", "assistant", serializeKcCardBlock(DRAFT_EV))]
    render(<KnowledgePage />)
    await screen.findByTestId("kc-tree-ready")
    openDrawer()
    await screen.findByTestId("kc-card-skill-draft")

    fireEvent.click(screen.getByTestId("kc-skl-raw-0"))
    await waitFor(() => expect(calls.some(c =>
      c.method === "GET" && c.url.includes("/api/knowledge/raw/") && c.url.includes("03-exec-jsonl-excerpt.md"),
    )).toBe(true))
  })

  it("判例来源草案：[看判例页] 走 openPage（右栏渲染 cases 页）；纯协议面 kcEventPageRefs 钉判例跟随", async () => {
    expect(kcEventPageRefs(CASE_ORIGIN_EV)).toEqual(["cases/2026-10-12-case-msys.md"])
    expect(kcEventPageRefs(DRAFT_EV)).toEqual([]) // 纯 pack 来源不跟随（草案本体非知识页）

    chatBox.messages = [MSG("a1", "assistant", serializeKcCardBlock(CASE_ORIGIN_EV))]
    render(<KnowledgePage />)
    await screen.findByTestId("kc-tree-ready")
    openDrawer()
    const card = await screen.findByTestId("kc-card-skill-draft")
    expect(card.textContent).toContain("流程型") // case-procedural 中文标
    expect(card.textContent).toContain("oct-001")
    fireEvent.click(screen.getByTestId("kc-skl-case"))
    await waitFor(() => expect(calls.some(c => c.url.includes("/wiki/article/"))).toBe(true))
  })

  it("「对策展人说（改写草案）」⇒ 取号器预取草案名与路径（对话修改流的 S4 半腿）", async () => {
    chatBox.messages = [MSG("a1", "assistant", serializeKcCardBlock(DRAFT_EV))]
    render(<KnowledgePage />)
    await screen.findByTestId("kc-tree-ready")
    openDrawer()
    await screen.findByTestId("kc-card-skill-draft")

    fireEvent.click(screen.getByTestId("kc-skl-say"))
    const composer = screen.getByPlaceholderText(/投喂 raw/)
    expect((composer as HTMLTextAreaElement).value).toContain("改写草案 flow-85153203c0")
    expect((composer as HTMLTextAreaElement).value).toContain("drafts/skills/flow-85153203c0/SKILL.md")
  })

  it("红线4 负断言：草案卡零授予钮零目标分身选择器（grant/revoke/授予 类钮不存在）", async () => {
    chatBox.messages = [MSG("a1", "assistant", serializeKcCardBlock(DRAFT_EV))]
    render(<KnowledgePage />)
    await screen.findByTestId("kc-tree-ready")
    openDrawer()
    const card = await screen.findByTestId("kc-card-skill-draft")
    const btns = Array.from(card.querySelectorAll("button")).map(b => b.textContent ?? "")
    expect(btns.every(t => !/授予|grant|revoke|撤销|目标分身/i.test(t))).toBe(true)
    expect(screen.queryByTestId("kc-skl-grant")).toBeNull()
    expect(screen.queryByTestId("kc-skl-revoke")).toBeNull()
  })

  it("终态卡（status=revoked）⇒ 已退役徽标 + 改写钮退场（沉淀卡终态去钮，finding/判例卡同律）", async () => {
    chatBox.messages = [MSG("a1", "assistant", serializeKcCardBlock(REVOKED_EV))]
    render(<KnowledgePage />)
    await screen.findByTestId("kc-tree-ready")
    openDrawer()
    const card = await screen.findByTestId("kc-card-skill-draft")
    expect(card.textContent).toContain("已退役")
    expect(screen.queryByTestId("kc-skl-say")).toBeNull()
  })
})
