// 票11 · /knowledge 知识中心（读面）组件测试 — wiki-page.test.tsx / billing 先例
// （vi.stubGlobal fetch，URL 子串匹配 mock；jsdom 下 getServerUrl() 回落 3001 无关紧要）。
// Seam: <KnowledgePage/>（app/knowledge/page.tsx）—— 树/页渲染/检索/健康条/LOG/preference。
import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"

vi.mock("next/navigation", () => ({
  usePathname: () => "/knowledge",
}))
vi.mock("next/link", () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}))
// react-markdown 全家桶对单测是纯负担 — 桩到内容透传（wiki-page.test.tsx:15 同款）
vi.mock("@/components/resource/MarkdownPreview", () => ({
  MarkdownPreview: ({ content }: { content: string }) => <div data-md-preview>{content}</div>,
}))
// 票12 对话列（clone-session + 卡片编排）本体测于 knowledge-chat.test.tsx；
// 本文件 = 票11 读面 seam，桩掉以隔离聊天基建依赖
vi.mock("@/components/knowledge-center/chat-column", () => ({
  ChatColumn: ({ pinned }: { pinned: boolean }) => <div data-testid="kc-chat-column">{pinned ? "已钉住" : "跟随"}</div>,
}))

import KnowledgePage from "../page"
import { Header } from "@/components/layout/header"

// ── fixtures（expected 独立真相源：原型 Tab④ mockup 数字与票面口径）──

const HEALTH = {
  org: "global",
  pages: { total: 52, entity: 7, concept: 9, topic: 11, source: 23, case: 2 },
  rawSources: 31,
  ingestedThisWeek: 5,
  openFindings: 2,
  queueDepth: 0,
  avgConfidence: 0.64,
  score: 77,
  lastCompiled: "2026-10-13",
  gitHead: "a3f9c21d4b5e6f708192a3b4c5d6e7f8091a2b3c",
}

const TREE = {
  org: "global",
  domains: [
    {
      name: "entity", label: "Entities", count: 1,
      entries: [{ id: "ent-open-octopus", path: "entities/ent-open-octopus.md", title: "Open Octopus（平台 monorepo）", summary: "工作流编排平台", stability: "stable", ruleCount: 0 }],
    },
    {
      name: "concept", label: "Concepts", count: 1,
      entries: [{ id: "con-compiled-rag", path: "concepts/con-compiled-rag.md", title: "编译式 RAG", summary: "检索的重活在编译时", stability: "stable", ruleCount: 1 }],
    },
    {
      name: "topic", label: "Topics", count: 1,
      entries: [{ id: "top-knowledge-injection", path: "topics/top-knowledge-injection.md", title: "知识注入沿革", summary: "注入式→编译式", stability: "stable", ruleCount: 1 }],
    },
    {
      name: "projects", label: "项目知识", count: 1,
      entries: [{ id: "prj-octopus", path: "projects/prj-octopus.md", title: "Octopus 平台工程知识", summary: "monorepo 构建规则", stability: "stable", ruleCount: 2 }],
    },
    {
      name: "cases", label: "问题案例档", count: 1,
      entries: [{ id: "case-2026-003", path: "cases/2026-06-23-pnpm-lockfile-mismatch.md", title: "CI 报 LOCKFILE_CONFIG_MISMATCH", summary: "pnpm 版本错配", stability: "stable", ruleCount: 0 }],
    },
  ],
  stats: { entries: 4, cases: 1, rules: 4, lastCompiled: "2026-10-13" },
  log: null,
}

// v3 页详情（chips/git 近史/[[链接]]/sources 溯源数据源——fixture 对齐票11 AC2）
const ARTICLE = {
  id: "con-compiled-rag", org: "global", domain: "concept", title: "编译式 RAG",
  summary: "检索的重活在编译时", topics: ["rag"], stability: "stable", lastCompiled: "2026-10-13",
  sources: ["raw/inbox/2026-10-13-karpathy-llm-wiki.md"], confidence: 0.9,
  path: "concepts/con-compiled-rag.md", updatedAt: "2026-10-13 09:12:00",
  body: "## 定义\n\n检索的重活从 query 时挪到维护编译时。<!--#oct-008-->\n\nvs 注入式（见 [[top-knowledge-injection|知识注入沿革]]）。\n",
  anchors: ["oct-008"],
  gitHistory: [{ hash: "b71e004", date: "2026-10-13", message: "compile: concepts/con-compiled-rag.md — +oct-008" }],
  case: null,
  page: { type: "concept", entityKind: null, aliases: ["compiled rag", "编译RAG"], links: ["top-knowledge-injection"] },
  // 票07 实效实时段（手算自 fixture 账目：9/(9+3)=0.75；快照列 0.9 与实时 0.75 两值并存）
  effectiveness: { citedCount: 12, helpfulCount: 9, notHelpfulCount: 3, helpfulRate: 0.75, confidence: 0.75, measured: true },
}

const ARTICLE_LINKED = {
  ...ARTICLE, id: "top-knowledge-injection", domain: "topic", title: "知识注入沿革",
  path: "topics/top-knowledge-injection.md",
  body: "## 硬约束\n\n注入式已废止，见 [[con-compiled-rag]]。<!--#oct-013-->\n",
  anchors: ["oct-013"],
  page: { type: "topic", entityKind: null, aliases: [], links: ["con-compiled-rag"] },
}

const RAW_FILE = {
  org: "global",
  path: "raw/inbox/2026-10-13-karpathy-llm-wiki.md",
  bytes: 12288,
  hash: "4f2a9c00000000000000000000000000000000000000000000000000000000aa",
  origin: "url:https://gist.github.com/karpathy/442a6bf",
  title: "Karpathy LLM Wiki",
  ingestedAt: "2026-10-13T09:12:00.000Z",
  content: "---\norigin: \"url:https://gist.github.com/karpathy/442a6bf\"\ntitle: \"Karpathy LLM Wiki\"\n---\n\n# llm wiki\n三层架构 raw/wiki/schema\n",
}

interface FetchCall { url: string }
let calls: FetchCall[]

const LOG_LINES = [
  { date: "2026-10-13", op: "ingest", title: "raw/inbox/2026-10-13-karpathy-llm-wiki.md", result: "落 raw 冻结 · url:https://gist · curator ✓" },
  { date: "2026-10-12", op: "compile", title: "projects/prj-octopus.md", result: "+oct-007 Promise 超时 · task-207 归档提炼 · xzf ✓" },
  { date: "2026-10-11", op: "revert", title: "compile a3f9c21", result: "回滚本次编译 · git revert · owner ✓" },
]

// 检索命中 fixture：Promise 全文命中 topics 页并带规则锚点（锚点跳转定位高亮数据源）
const SEARCH = {
  org: "global", query: "Promise", mode: "fts",
  results: [{
    id: "top-knowledge-injection", domain: "topic", title: "知识注入沿革",
    summary: "注入式→编译式", path: "topics/top-knowledge-injection.md",
    snippet: "注入式已废止，见 con-compiled-rag", anchors: ["oct-013"],
  }],
}

type StubResponse = { ok: boolean; status: number; json: () => Promise<unknown> }
function mockFetch(overrides?: (u: string) => StubResponse | undefined) {
  calls = []
  vi.stubGlobal("fetch", vi.fn(async (url: unknown) => {
    const u = String(url)
    calls.push({ url: u })
    if (overrides) {
      const r = overrides(u)
      if (r) return r
    }
    if (u.includes("/knowledge/wiki/tree")) return { ok: true, status: 200, json: async () => TREE }
    if (u.includes("/knowledge/wiki/search")) return { ok: true, status: 200, json: async () => SEARCH }
    if (u.includes("/knowledge/log")) return { ok: true, status: 200, json: async () => ({ org: "global", lines: LOG_LINES }) }
    if (u.includes("/knowledge/health")) return { ok: true, status: 200, json: async () => HEALTH }
    if (/\/wiki\/article\/top-knowledge-injection/.test(u)) return { ok: true, status: 200, json: async () => ARTICLE_LINKED }
    if (/\/wiki\/article\/[^?]+/.test(u)) return { ok: true, status: 200, json: async () => ARTICLE }
    if (u.includes("/knowledge/raw/")) return { ok: true, status: 200, json: async () => RAW_FILE }
    return { ok: true, status: 200, json: async () => ({}) }
  }))
}

beforeEach(() => {
  vi.clearAllMocks()
  mockFetch()
})

describe("健康条（票面口径七项，负断言「无待审核」）", () => {
  it("renders page counts by class, raw sources, week ingest, findings, queue, last compile, git HEAD", async () => {
    render(<KnowledgePage />)
    const bar = await screen.findByTestId("kc-health-bar")

    expect(bar.textContent).toContain("页 52")
    expect(bar.textContent).toContain("实体 7")
    expect(bar.textContent).toContain("概念 9")
    expect(bar.textContent).toContain("主题 11")
    expect(bar.textContent).toContain("来源 23")
    expect(bar.textContent).toContain("判例 2")
    expect(bar.textContent).toContain("raw 源 31")
    expect(bar.textContent).toContain("本周 ingest 5")
    expect(bar.textContent).toContain("findings 2")
    expect(bar.textContent).toContain("队列 0")
    expect(bar.textContent).toContain("最近编译 2026-10-13")
    expect(bar.textContent).toContain("a3f9c21") // git HEAD 短哈希（原型 kbar「wiki git a3f9c21」）
  })

  it("负断言：全页不存在「待审核」计数（审批概念已废除，spec D6）", async () => {
    render(<KnowledgePage />)
    await screen.findByTestId("kc-health-bar")
    expect(screen.queryByText(/待审核/)).toBeNull()
    expect(document.body.textContent).not.toContain("待审核")
  })

  it("数据面自洽：树/健康条请求钉 org=global，页面无 org 切换控件（故事 18）", async () => {
    render(<KnowledgePage />)
    await screen.findByTestId("kc-health-bar")
    expect(calls.some(c => c.url.includes("/knowledge/wiki/tree") && c.url.includes("org=global"))).toBe(true)
    expect(screen.queryByRole("combobox")).toBeNull()
    expect(document.body.textContent).not.toMatch(/选择组织|切换 ?org/i)
  })

  it("健康条加载失败显形，不伪造零值（CODING_STANDARDS #2）", async () => {
    mockFetch(u => (u.includes("/knowledge/health") ? { ok: false, status: 500, json: async () => ({ error: { message: "健康聚合炸了" } }) } : undefined))
    render(<KnowledgePage />)
    await screen.findByTestId("kc-tree-ready") // 树仍在
    const err = await screen.findByTestId("kc-health-error")
    expect(err.textContent).toContain("健康聚合炸了")
    expect(screen.queryByTestId("kc-health-bar")).toBeNull()
  })

  it("P4 票07：平均置信槽——已测均值显数值；全库未测 null ⇒ 诚实 —（不伪造 0.5 初值均值）", async () => {
    const first = render(<KnowledgePage />)
    const bar = await screen.findByTestId("kc-health-bar")
    expect(bar.textContent).toContain("平均置信 0.64")
    first.unmount()

    mockFetch(u => (u.includes("/knowledge/health") ? { ok: true, status: 200, json: async () => ({ ...HEALTH, avgConfidence: null }) } : undefined))
    render(<KnowledgePage />)
    const bar2 = await screen.findByTestId("kc-health-bar")
    expect(bar2.textContent).toContain("平均置信 —")
  })

  it("P4 票08：健康分槽 77；点开 ranked 层按 severity 分组列开放 findings（复用列表通道，零新页面）", async () => {
    mockFetch(u =>
      u.includes("/knowledge/findings")
        ? {
            ok: true,
            status: 200,
            json: async () => ({
              org: "global",
              findings: [
                { id: "f1", kind: "contradiction", severity: "critical", status: "open", title: "矛盾：甲页 ↔ 乙页", detail: {}, pages: ["topics/a.md"], rawRef: "", source: "patrol", createdAt: "2026-10-15T00:00:00Z", updatedAt: "2026-10-15T00:00:00Z" },
                { id: "f2", kind: "bloat", severity: "major", status: "open", title: "膨胀榜：乙页", detail: {}, pages: ["topics/b.md"], rawRef: "", source: "patrol", createdAt: "2026-10-15T00:00:00Z", updatedAt: "2026-10-15T00:00:00Z" },
                { id: "f3", kind: "orphan", severity: "minor", status: "open", title: "孤儿页：丙页", detail: {}, pages: ["entities/c.md"], rawRef: "", source: "patrol", createdAt: "2026-10-15T00:00:00Z", updatedAt: "2026-10-15T00:00:00Z" },
              ],
            }),
          }
        : undefined,
    )
    render(<KnowledgePage />)
    const bar = await screen.findByTestId("kc-health-bar")
    expect(bar.textContent).toContain("健康分 77")

    // 点开=票08 首例交互：健康分槽的「明细」钮（既有 findings 列表 API 通道，无新端点无新路由页）
    fireEvent.click(screen.getByTestId("kc-health-score-toggle"))
    const panel = await screen.findByTestId("kc-ranked-findings")
    expect(panel.textContent).toContain("矛盾：甲页 ↔ 乙页")
    expect(panel.textContent).toContain("膨胀榜：乙页")
    expect(panel.textContent).toContain("孤儿页：丙页")
    // 按 severity 分组：紧急>重要>一般 的组序即 ranked 语义（故事 14 裁决动线）
    expect(panel.textContent).toContain("紧急")
    expect(panel.textContent).toContain("重要")
    expect(panel.textContent).toContain("一般")
    const text = panel.textContent!
    expect(text.indexOf("紧急")).toBeGreaterThanOrEqual(0)
    expect(text.indexOf("紧急")).toBeLessThan(text.indexOf("重要"))
    expect(text.indexOf("重要")).toBeLessThan(text.indexOf("一般"))
    // 零新页面负断言：分组层不引入新路由（仍在 /knowledge 页内）
    expect(screen.queryByRole("link", { name: /报告|报表|doctor/i })).toBeNull()
  })

  it("P4 票08：score null ⇒ 健康分 —（诚实不可评，不伪造满分——空库/未装配巡检形态）", async () => {
    mockFetch(u => (u.includes("/knowledge/health") ? { ok: true, status: 200, json: async () => ({ ...HEALTH, score: null }) } : undefined))
    render(<KnowledgePage />)
    const bar = await screen.findByTestId("kc-health-bar")
    expect(bar.textContent).toContain("健康分 —")
  })
})

describe("INDEX 五类树（必读/Entities/Concepts/Topics/Sources/Cases + System）", () => {
  it("buckets v3 type groups and v2-domain rows, with 必读 and System(LOG) groups", async () => {
    render(<KnowledgePage />)
    await screen.findByTestId("kc-tree-ready")

    // 必读组：user_preference（人工）
    expect(screen.getByText("必读")).toBeDefined()
    fireEvent.click(screen.getByRole("button", { name: /user_preference/ }))
    expect(await screen.findByTestId("kc-preference-view")).toBeDefined()

    // 五类组头（原型 Tab④ 树分组；v3 类型值组 + v2 域值行并入对应类）
    expect(screen.getByText(/Entities/)).toBeDefined()
    expect(screen.getByText(/Concepts/)).toBeDefined()
    expect(screen.getByText(/Topics/)).toBeDefined()
    expect(screen.getByText(/Sources/)).toBeDefined()
    expect(screen.getByText(/Cases/)).toBeDefined()
    // v2 域值行（projects）并入 Topics 组——组头不再露「项目知识」
    expect(screen.queryByText("项目知识")).toBeNull()
    const topics = screen.getByTestId("kc-group-topic")
    expect(topics.textContent).toContain("Octopus 平台工程知识")
    expect(topics.textContent).toContain("知识注入沿革")
    // 判例组
    expect(screen.getByTestId("kc-group-case").textContent).toContain("CI 报 LOCKFILE_CONFIG_MISMATCH")
    // System 组：LOG.md 时间线入口
    expect(screen.getByRole("button", { name: /LOG\.md 时间线/ })).toBeDefined()
  })

  it("浏览模式对话抽屉：默认全宽，打开挂对话列（票12 实装；本文件隔离 mock，对话列本体测于 knowledge-chat.test.tsx）", async () => {
    render(<KnowledgePage />)
    await screen.findByTestId("kc-tree-ready")
    expect(screen.queryByTestId("kc-chat-column")).toBeNull() // 默认全宽
    fireEvent.click(screen.getByRole("button", { name: /对话抽屉/ }))
    expect(await screen.findByTestId("kc-chat-column")).toBeDefined()
  })
})

describe("v3 页渲染：chips / 锚点现形 / git 近史折叠 / [[链接]] 跳页 / sources 溯源", () => {
  it("renders title, type/aliases/sources chips, anchor tokens and links chip navigates", async () => {
    render(<KnowledgePage />)
    await screen.findByTestId("kc-tree-ready")

    fireEvent.click(screen.getByRole("button", { name: /编译式 RAG/ }))

    await waitFor(() => expect(screen.getByTestId("kc-page-title").textContent).toBe("编译式 RAG"))
    // front-matter chips：type / aliases / sources
    expect(screen.getByTestId("kc-chip-type").textContent).toBe("concept")
    expect(screen.getByTestId("kc-chip-aliases").textContent).toContain("编译RAG")
    expect(screen.getByTestId("kc-chip-aliases").textContent).toContain("compiled rag")
    // MarkdownPreview 桩透传：锚点现形（原型「#oct-008 可见标记」）+ [[链接]] 文本
    await waitFor(() => expect(document.querySelector("[data-md-preview]")).not.toBeNull())
    const md = document.querySelector("[data-md-preview]")!
    expect(md.textContent).toContain("#oct-008")
    expect(md.textContent).toContain("知识注入沿革")
    // links chip 可点跳页
    fireEvent.click(screen.getByTestId("kc-link-chip"))
    await waitFor(() => expect(screen.getByTestId("kc-page-title").textContent).toBe("知识注入沿革"))
    expect(calls.some(c => /\/wiki\/article\/top-knowledge-injection/.test(c.url))).toBe(true)
  })

  it("git 近史折叠区：默认收起，点开展现 commit hash/message（article API gitHistory 现形）", async () => {
    render(<KnowledgePage />)
    await screen.findByTestId("kc-tree-ready")
    fireEvent.click(screen.getByRole("button", { name: /编译式 RAG/ }))
    await screen.findByTestId("kc-page-title")

    expect(screen.queryByTestId("kc-git-history")).toBeNull()
    fireEvent.click(screen.getByTestId("kc-git-history-toggle"))
    const hist = await screen.findByTestId("kc-git-history")
    expect(hist.textContent).toContain("b71e004")
    expect(hist.textContent).toContain("compile: concepts/con-compiled-rag.md")
  })

  it("sources chip 打开不可变 raw 源只读视图（溯源回指）", async () => {
    render(<KnowledgePage />)
    await screen.findByTestId("kc-tree-ready")
    fireEvent.click(screen.getByRole("button", { name: /编译式 RAG/ }))
    await screen.findByTestId("kc-page-title")

    fireEvent.click(screen.getByTestId("kc-source-chip"))
    const view = await screen.findByTestId("kc-raw-view")
    expect(view.textContent).toContain("raw/inbox/2026-10-13-karpathy-llm-wiki.md")
    expect(view.textContent).toContain("4f2a9c") // hash 指针
    expect(calls.some(c => c.url.includes("/knowledge/raw/inbox/2026-10-13-karpathy-llm-wiki.md"))).toBe(true)
  })

  it("页加载失败显形，不伪装成空态（CODING_STANDARDS #2）", async () => {
    mockFetch(u => (u.includes("/wiki/article/") ? { ok: false, status: 500, json: async () => ({ error: { message: "DB 失联" } }) } : undefined))
    render(<KnowledgePage />)
    await screen.findByTestId("kc-tree-ready")
    fireEvent.click(screen.getByRole("button", { name: /编译式 RAG/ }))
    const err = await screen.findByTestId("kc-page-error")
    expect(err.textContent).toContain("DB 失联")
    expect(screen.queryByTestId("kc-page-title")).toBeNull()
  })

  it("票07 浏览页脚实效段：引用数/helpful 率/confidence（DB 实时值——与头 chips 快照值并存展示）", async () => {
    render(<KnowledgePage />)
    await screen.findByTestId("kc-tree-ready")
    fireEvent.click(screen.getByRole("button", { name: /编译式 RAG/ }))
    await screen.findByTestId("kc-page-title")

    const foot = await screen.findByTestId("kc-effectiveness-footer")
    expect(foot.textContent).toContain("引用 12×")
    expect(foot.textContent).toContain("75%")
    expect(foot.textContent).toContain("0.75")
    expect(foot.textContent).not.toContain("样本不足") // measured=true 无滞后注
  })

  it("票07 页脚形态三态：未接账目（effectiveness null）整段缺席；未测行显「样本不足」滞后注", async () => {
    mockFetch(u => (/\/wiki\/article\/[^?]+/.test(u) && !u.includes("top-knowledge-injection")
      ? { ok: true, status: 200, json: async () => ({ ...ARTICLE, effectiveness: null }) }
      : undefined))
    render(<KnowledgePage />)
    await screen.findByTestId("kc-tree-ready")
    fireEvent.click(screen.getByRole("button", { name: /编译式 RAG/ }))
    await screen.findByTestId("kc-page-title")
    expect(screen.queryByTestId("kc-effectiveness-footer")).toBeNull() // 诚实缺席=不显假账
  })

  it("票07 页脚未测态：helpful 率有账直显、confidence 标「样本不足·保持编译期初值」（不抖动语义可见）", async () => {
    mockFetch(u => (/\/wiki\/article\/[^?]+/.test(u) && !u.includes("top-knowledge-injection")
      ? {
          ok: true, status: 200,
          json: async () => ({ ...ARTICLE, effectiveness: { citedCount: 7, helpfulCount: 1, notHelpfulCount: 1, helpfulRate: 0.5, confidence: 0.9, measured: false } }),
        }
      : undefined))
    render(<KnowledgePage />)
    await screen.findByTestId("kc-tree-ready")
    fireEvent.click(screen.getByRole("button", { name: /编译式 RAG/ }))
    const foot = await screen.findByTestId("kc-effectiveness-footer")
    expect(foot.textContent).toContain("引用 7×")
    expect(foot.textContent).toContain("50%")
    expect(foot.textContent).toContain("0.9")
    expect(foot.textContent).toContain("样本不足")
  })
})

describe("Ctrl+K 检索命令条（页名/别名/锚点/FTS5 全文；命中锚点跳转定位高亮）", () => {
  it("Ctrl+K 打开命令条；输入走 search API（q + org=global），FTS5 命中显示片段与锚点", async () => {
    render(<KnowledgePage />)
    await screen.findByTestId("kc-tree-ready")

    fireEvent.keyDown(window, { key: "k", ctrlKey: true })
    const palette = await screen.findByTestId("kc-palette")
    const input = palette.querySelector("input")!
    fireEvent.change(input, { target: { value: "Promise" } })

    await waitFor(() => expect(calls.some(c => c.url.includes("/knowledge/wiki/search") && c.url.includes("q=Promise") && c.url.includes("org=global"))).toBe(true), { timeout: 3000 })
    expect(await screen.findByTestId("kc-search-results")).toBeDefined()
    expect(document.body.textContent).toContain("FTS5 全文")
    expect(screen.getByTestId("kc-search-hit").textContent).toContain("注入式已废止")
    expect(screen.getByTestId("kc-search-hit").textContent).toContain("oct-013")
  })

  it("页面名本地匹配（树内标题/路径），点选进页", async () => {
    render(<KnowledgePage />)
    await screen.findByTestId("kc-tree-ready")
    fireEvent.click(screen.getByTestId("kc-search-open"))

    const input = (await screen.findByTestId("kc-palette")).querySelector("input")!
    fireEvent.change(input, { target: { value: "注入" } })
    const pageHit = await screen.findByTestId("kc-palette-page")
    expect(pageHit.textContent).toContain("知识注入沿革")

    fireEvent.click(pageHit)
    expect(screen.queryByTestId("kc-palette")).toBeNull()
    await waitFor(() => expect(screen.getByTestId("kc-page-title").textContent).toBe("知识注入沿革"))
  })

  it("全文命中带锚点 → 跳页并定位高亮（kc-anchor-focus + data-anchor-hit）", async () => {
    render(<KnowledgePage />)
    await screen.findByTestId("kc-tree-ready")
    fireEvent.keyDown(window, { key: "k", ctrlKey: true })
    const input = (await screen.findByTestId("kc-palette")).querySelector("input")!
    fireEvent.change(input, { target: { value: "Promise" } })

    fireEvent.click(await screen.findByTestId("kc-search-hit"))
    await waitFor(() => expect(screen.getByTestId("kc-page-title").textContent).toBe("知识注入沿革"))
    const focus = screen.getByTestId("kc-anchor-focus")
    expect(focus.getAttribute("data-anchor-hit")).toBe("oct-013")
    expect(document.querySelector('[data-anchor-hit="oct-013"]')).not.toBeNull()
  })

  it("检索失败显形，不伪造空结果（CODING_STANDARDS #2）", async () => {
    mockFetch(u => (u.includes("/knowledge/wiki/search") ? { ok: false, status: 500, json: async () => ({ error: { message: "FTS 崩了" } }) } : undefined))
    render(<KnowledgePage />)
    await screen.findByTestId("kc-tree-ready")
    fireEvent.keyDown(window, { key: "k", ctrlKey: true })
    const input = (await screen.findByTestId("kc-palette")).querySelector("input")!
    fireEvent.change(input, { target: { value: "Promise" } })

    const err = await screen.findByTestId("kc-search-error", undefined, { timeout: 3000 })
    expect(err.textContent).toContain("FTS 崩了")
    expect(screen.queryByTestId("kc-search-results")).toBeNull()
  })
})

describe("LOG.md 时间线视图（行格式渲染 + 前缀过滤）", () => {
  it("System 组入口打开时间线：行格式 `## [date] op | title → result` 渲染", async () => {
    render(<KnowledgePage />)
    await screen.findByTestId("kc-tree-ready")

    fireEvent.click(screen.getByRole("button", { name: /LOG\.md 时间线/ }))
    const view = await screen.findByTestId("kc-log-view")

    expect(view.textContent).toContain("2026-10-13")
    expect(view.textContent).toContain("raw/inbox/2026-10-13-karpathy-llm-wiki.md")
    expect(view.textContent).toContain("落 raw 冻结")
    expect(view.textContent).toContain("2026-10-11")
    expect(screen.getAllByTestId("kc-log-row")).toHaveLength(3)
  })

  it("前缀过滤 ingest/compile/query/lint/revert：点 compile 只剩编译行", async () => {
    render(<KnowledgePage />)
    await screen.findByTestId("kc-tree-ready")
    fireEvent.click(screen.getByRole("button", { name: /LOG\.md 时间线/ }))
    await screen.findByTestId("kc-log-view")

    fireEvent.click(screen.getByRole("button", { name: /^compile$/ }))
    const rows = await screen.findAllByTestId("kc-log-row")
    expect(rows).toHaveLength(1)
    expect(rows[0].textContent).toContain("projects/prj-octopus.md")
    // 非 compile 行不得残留
    expect(screen.queryByText(/raw\/inbox\/2026-10-13/)).toBeNull()
    expect(screen.queryByText(/回滚本次编译/)).toBeNull()
  })
})

describe("user_preference 浏览视图：只读渲染 + 零编辑控件（AC6）", () => {
  it("标注「人工文件，直接编辑」；无输入框/无编辑按钮/无保存", async () => {
    mockFetch(u => (u.includes("/knowledge/preference")
      ? { ok: true, status: 200, json: async () => ({ content: "# owner 偏好\n\n回复要短。\n", scope: "global", filePath: "/home/.octopus/knowledge/user_preference.md" }) }
      : undefined))
    render(<KnowledgePage />)
    await screen.findByTestId("kc-tree-ready")

    fireEvent.click(screen.getByRole("button", { name: /user_preference/ }))
    const view = await screen.findByTestId("kc-preference-view")
    expect(screen.getByTestId("kc-preference-banner").textContent).toContain("人工文件，直接编辑")
    // 内容经 MarkdownPreview（桩透传）
    await waitFor(() => expect(document.querySelector("[data-md-preview]")).not.toBeNull())
    expect(document.querySelector("[data-md-preview]")!.textContent).toContain("回复要短")

    // 零编辑入口：无 textbox / 无编辑保存按钮 / 无 textarea
    expect(screen.queryByRole("textbox")).toBeNull()
    expect(document.querySelector("textarea")).toBeNull()
    expect(screen.queryByRole("button", { name: /编辑|保存|提交|删除/ })).toBeNull()
    expect(view.textContent).toContain("只读")
  })
})

describe("全站导航注册（AC：知识中心入口，只加不删）", () => {
  it("header 含「知识中心」→ /knowledge", () => {
    render(<Header />)
    const link = screen.getByRole("link", { name: /知识中心/ })
    expect(link.getAttribute("href")).toBe("/knowledge")
  })

  it("票09 删除面生效：旧导航项退役，知识入口唯一 = 知识中心", () => {
    render(<Header />)
    expect(screen.queryByRole("link", { name: /知识词条/ })).toBeNull()
    expect(screen.queryByRole("link", { name: /工作经验/ })).toBeNull()
    expect(screen.getByRole("link", { name: /知识中心/ })).toBeDefined()
  })
})
