// 票02 · /knowledge 素材包卡（件清单+剔除重编译流；S4 组件测试，仿票13 knowledge-findings 风格）
// Seam: <KnowledgePage/>（fetch stub 到 API 边界）+ Lane A fenced 卡注入。
// expected 真相源：票02 票面（件清单=名/类/大小；剔除钮经全局串行队列）+ 原型 Tab④ 扩行。
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

// ── fixtures ──

const HEALTH = {
  org: "global",
  pages: { total: 52, entity: 7, concept: 9, topic: 11, source: 23, case: 2 },
  rawSources: 31, ingestedThisWeek: 5, openFindings: 0, queueDepth: 0,
  lastCompiled: "2026-10-14", gitHead: "a3f9c21d4b5e6f708192a3b4c5d6e7f8091a2b3c",
}
const TREE = {
  org: "global",
  domains: [
    { name: "topic", label: "Topics", count: 1, entries: [{ id: "top-login-session", path: "topics/top-login-session.md", title: "登录改造纪律", summary: "session 制 SOP", stability: "stable", ruleCount: 1 }] },
  ],
  stats: { entries: 1, cases: 0, rules: 1, lastCompiled: "2026-10-14" },
  log: null,
}
const ARTICLE = {
  id: "top-login-session", domain: "topic", title: "登录改造纪律", summary: "session 制 SOP",
  topics: [], stability: "stable", lastCompiled: "2026-10-14", sources: [], confidence: 0.9,
  path: "topics/top-login-session.md", updatedAt: "2026-10-14 09:12:00",
  body: "## SOP\n\n读包编译。", anchors: [], gitHistory: [], case: null,
  page: { type: "topic", entityKind: null, aliases: [], links: [] },
}

const TASK = "aa02-task-7"
const PACK_DIR = `raw/archives/task-${TASK}`

const PACK_EV: KcCardEvent = {
  id: `mdp-${TASK}`,
  kind: "material-pack",
  ts: "2026-10-14T09:00:00Z",
  data: {
    taskId: TASK,
    packPath: PACK_DIR,
    summaryIncluded: true,
    queueTaskId: `arc-${TASK}`,
    items: [
      { kind: "acceptance-ledger", name: "验收台账", path: `${PACK_DIR}/01-acceptance-ledger.md`, bytes: 512, sha256: "a".repeat(64), excluded: false },
      { kind: "phase-rejections", name: "phase 打回记录", path: `${PACK_DIR}/02-phase-rejections.md`, bytes: 2048, sha256: "b".repeat(64), excluded: false },
      { kind: "exec-jsonl-excerpt", name: "执行 JSONL 关键事件摘录", path: `${PACK_DIR}/03-exec-jsonl-excerpt.md`, bytes: 123456, sha256: "c".repeat(64), excluded: false },
      { kind: "archive-summary", name: "归档总结", path: `${PACK_DIR}/07-archive-summary.md`, bytes: 4096, sha256: "d".repeat(64), excluded: false },
    ],
  },
}

const MSG = (id: string, role: "user" | "assistant", content: string) => ({
  id, session_id: "kc-s1", role, content, created_at: "2026-10-14T09:00:00Z",
  is_summary: false, is_compressed: false, is_edited: false,
})

interface FetchCall { url: string; method: string; body: string }
let calls: FetchCall[]
let queueScript: string[]
let queueErr: { code: string; message: string } | null

function makeStub() {
  let poll = 0
  calls = []
  vi.stubGlobal("fetch", vi.fn(async (url: unknown, init?: { method?: string; body?: string }) => {
    const u = String(url)
    const method = init?.method ?? "GET"
    calls.push({ url: u, method, body: String(init?.body ?? "") })
    const json = (v: unknown) => ({ ok: true, status: 200, json: async () => v })
    if (u.includes("/knowledge/wiki/tree")) return json(TREE)
    if (u.includes("/knowledge/health")) return json(HEALTH)
    if (u.includes("/wiki/article/")) return json(ARTICLE)
    if (u.includes("/knowledge/findings")) return json({ org: "global", findings: [] })
    if (u.includes(`/wiki/pack/${TASK}/recompile`)) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { excludePath?: string }
      return json({
        queueTaskId: `arc-${TASK}-rc1`,
        excludedPath: body.excludePath ?? null,
        focus: null,
        manifestHash: "e".repeat(64),
        opKind: "archive-compile",
      })
    }
    if (u.includes("/wiki/queue/task/")) {
      const state = queueScript[Math.min(poll, queueScript.length - 1)]
      poll++
      // aa-fix 项5：「gone」=队列面 404（任务不可查）——TASK_LOST 显形纪律的注入位
      if (state === "gone") return { ok: false, status: 404, json: async () => ({ error: { code: "TASK_NOT_FOUND", message: "not in queue table" } }) }
      return json({
        task: {
          id: `arc-${TASK}-rc1`, opKind: "archive-compile", state,
          position: state === "queued" ? 1 : null, queuedAt: "2026-10-14T09:01:00Z",
          ...(state === "failed" && queueErr ? { error: queueErr } : {}),
        },
      })
    }
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
  queueScript = ["queued", "running", "committed"]
  queueErr = null
  makeStub()
  localStorage.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("素材包卡：件清单渲染 + 一行注册生效", () => {
  it("Lane A 卡渲染包名/件清单（名/类/大小/sha 短显），注册接位后走真卡非兜底；总结件不挂剔除钮", async () => {
    chatBox.messages = [MSG("a1", "assistant", serializeKcCardBlock(PACK_EV))]
    render(<KnowledgePage />)
    await screen.findByTestId("kc-tree-ready")
    openDrawer()

    const card = await screen.findByTestId("kc-card-material-pack")
    expect(card.textContent).toContain(`task-${TASK}`)
    expect(card.textContent).toContain("验收台账")
    expect(card.textContent).toContain("执行 JSONL 关键事件摘录")
    expect(card.textContent).toContain("120.6 KB") // 大小列（123456 B）
    expect(card.textContent).toContain("已冻结 4 件 · 编译已入队")
    expect(card.textContent).not.toContain("未注册卡类") // 注册表一行注册生效

    // 剔除钮挂在素材件上；总结件（编译主源）不挂
    expect(screen.getByTestId("kc-pack-exclude-exec-jsonl-excerpt")).toBeTruthy()
    expect(screen.getByTestId("kc-pack-exclude-acceptance-ledger")).toBeTruthy()
    expect(screen.queryByTestId("kc-pack-exclude-archive-summary")).toBeNull()
  }, 15000)
})

describe("剔除某件→重编译钮（经全局串行队列的完整流）", () => {
  it("[剔除重编译]→POST pack/recompile（body 含 excludePath）→轮询队列位次→卡显「剔除生效，已重编译」终态且被剔件划线标记", async () => {
    chatBox.messages = [MSG("a1", "assistant", serializeKcCardBlock(PACK_EV))]
    render(<KnowledgePage />)
    await screen.findByTestId("kc-tree-ready")
    openDrawer()
    await screen.findByTestId("kc-card-material-pack")

    fireEvent.click(screen.getByTestId("kc-pack-exclude-exec-jsonl-excerpt"))
    await waitFor(() => expect(
      calls.some(c => c.method === "POST" && c.url.includes(`/wiki/pack/${TASK}/recompile`) && c.body.includes(`03-exec-jsonl-excerpt.md`)),
    ).toBe(true))
    // 位次轮询走票06 队列面（GET /queue/task/arc-{id}-rc1——禁直写 wiki 的串行证据链在卡面）
    await waitFor(() => expect(calls.some(c => c.url.includes("/wiki/queue/task/"))).toBe(true))

    await waitFor(() => {
      const card = screen.getByTestId("kc-card-material-pack")
      expect(card.textContent).toContain("已提交")
      expect(card.textContent).toContain("剔除生效")
    }, { timeout: 8000 })
    // 被剔件行显「已剔除」（审计留痕，不退场）
    const row = screen.getByTestId("kc-pack-item-exec-jsonl-excerpt")
    expect(row.textContent).toContain("已剔除")
  }, 20000)

  it("重编译失败 ⇒ 显形错误码，卡不消失（失败不伪装成空态）", async () => {
    queueScript = ["failed"]
    queueErr = { code: "PACK_HASH_MISMATCH", message: "件 hash 对质失败" }
    chatBox.messages = [MSG("a1", "assistant", serializeKcCardBlock(PACK_EV))]
    render(<KnowledgePage />)
    await screen.findByTestId("kc-tree-ready")
    openDrawer()
    await screen.findByTestId("kc-card-material-pack")

    fireEvent.click(screen.getByTestId("kc-pack-exclude-phase-rejections"))
    await waitFor(() => {
      const card = screen.getByTestId("kc-card-material-pack")
      expect(card.textContent).toContain("重编译失败")
      expect(card.textContent).toContain("PACK_HASH_MISMATCH")
    }, { timeout: 8000 })
  }, 20000)

  it("队列任务不可查（404）⇒ TASK_LOST 显形 failed、占位不永挂排队（aa-fix 项5·对齐 use-kc-feed 纪律）", async () => {
    queueScript = ["gone"]
    chatBox.messages = [MSG("a1", "assistant", serializeKcCardBlock(PACK_EV))]
    render(<KnowledgePage />)
    await screen.findByTestId("kc-tree-ready")
    openDrawer()
    await screen.findByTestId("kc-card-material-pack")

    fireEvent.click(screen.getByTestId("kc-pack-exclude-exec-jsonl-excerpt"))
    await waitFor(() => {
      const card = screen.getByTestId("kc-card-material-pack")
      expect(card.textContent).toContain("重编译失败")
      expect(card.textContent).toContain("TASK_LOST")
    }, { timeout: 8000 })
    // 终态自停：不可查一拍即收（占位 queued 不靠停轮询掩盖）
    expect(calls.filter(c => c.url.includes("/wiki/queue/task/"))).toHaveLength(1)
  }, 20000)
})

describe("对话入口不劫持 + 焦点重编译走策展人", () => {
  it("[对策展人说（焦点重编译）] 灌进取号器（含 task id 与焦点措辞），零 recompile POST", async () => {
    chatBox.messages = [MSG("a1", "assistant", serializeKcCardBlock(PACK_EV))]
    render(<KnowledgePage />)
    await screen.findByTestId("kc-tree-ready")
    openDrawer()
    await screen.findByTestId("kc-card-material-pack")

    fireEvent.click(screen.getByTestId("kc-pack-ask-curator"))
    const composer = screen.getByPlaceholderText(/投喂 raw|关于 finding|重新编译/) as HTMLTextAreaElement
    expect(composer.value).toContain(`重新编译 task-${TASK}`)
    expect(composer.value).toContain("phase-2 打回")
    expect(calls.filter(c => c.method === "POST" && c.url.includes("/recompile"))).toHaveLength(0)
  }, 15000)
})
