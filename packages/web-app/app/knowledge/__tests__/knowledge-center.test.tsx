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
  stats: { entries: 4, cases: 1, rules: 4, lastCompiled: "2026-10-13", pendingReview: 0 },
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

  it("浏览模式对话抽屉占位（票12 实装，本票零聊天基建）", async () => {
    render(<KnowledgePage />)
    await screen.findByTestId("kc-tree-ready")
    expect(screen.queryByTestId("kc-chat-placeholder")).toBeNull() // 默认全宽
    fireEvent.click(screen.getByRole("button", { name: /对话抽屉/ }))
    expect(screen.getByTestId("kc-chat-placeholder").textContent).toContain("票12")
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

  it("旧导航项未被删除（票09 才执行删除面，本票只加）", () => {
    render(<Header />)
    expect(screen.getByRole("link", { name: /知识词条/ })).toBeDefined()
    expect(screen.getByRole("link", { name: /工作经验/ })).toBeDefined()
  })
})
