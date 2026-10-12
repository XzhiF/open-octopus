// 票03 · /wiki 只读页组件测试 — billing __tests__ .test.tsx 先例（vi.stubGlobal fetch，无 MSW）
// Seam: <WikiPage/>（app/wiki/page.tsx）—— mock API 断言域树/词条渲染/检索交互。
import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"

vi.mock("next/navigation", () => ({
  usePathname: () => "/wiki",
}))
vi.mock("next/link", () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}))
// react-markdown 全家桶对单测是纯负担 — 桩到内容透传（acceptance-surface.test.tsx:90 同款）
vi.mock("@/components/resource/MarkdownPreview", () => ({
  MarkdownPreview: ({ content }: { content: string }) => <div data-md-preview>{content}</div>,
}))
vi.mock("@/hooks/useOrgs", () => ({
  useOrgs: () => ({ orgs: [{ id: 1, name: "xzf-dev", path: "" }], loading: false, error: null }),
}))

import WikiPage from "../page"
import { Header } from "@/components/layout/header"

const TREE = {
  org: "xzf-dev",
  domains: [
    {
      name: "projects", label: "项目知识", count: 1,
      entries: [{ id: "prj-octopus", path: "projects/prj-octopus.md", title: "Octopus 平台工程知识", summary: "monorepo 构建/测试/端口规则与已知陷阱", stability: "stable", ruleCount: 2 }],
    },
    {
      name: "workflows", label: "工作流知识", count: 1,
      entries: [{ id: "wf-prd-impl", path: "workflows/wf-prd-impl.md", title: "prd-impl 工作流经验", summary: "P1-P5 分阶段提交", stability: "stable", ruleCount: 1 }],
    },
    {
      name: "cases", label: "问题案例档", count: 1,
      entries: [{ id: "case-2026-003", path: "cases/2026-06-23-pnpm-lockfile-mismatch.md", title: "CI 报 LOCKFILE_CONFIG_MISMATCH", summary: "pnpm 9 的 CI 读 v10 lockfile 失败", stability: "volatile", ruleCount: 0 }],
    },
  ],
  stats: { entries: 2, cases: 1, rules: 3, lastCompiled: "2026-10-12", pendingReview: 3 },
  log: `# Curation Log（append-only · 编译器自动写 · 详情看 git show <hash>）\n\n| 日期 | 动作 | 词条 | 摘要 | 来源 | 审核 |\n|------|------|------|------|------|------|\n| 2026-10-12 | compile | projects/prj-octopus.md | +oct-013 CI pnpm10 约束 | task-207 归档提炼 | xzf ✓ |\n`,
}

const ARTICLE = {
  id: "prj-octopus", org: "xzf-dev", domain: "projects", title: "Octopus 平台工程知识",
  summary: "monorepo 构建/测试/端口规则与已知陷阱", topics: ["build", "test"], stability: "stable",
  lastCompiled: "2026-10-12", sources: ["archive:ws-feat-actuator:2026-06-23", "doc:docs/agents/windows-bash.md"],
  confidence: 0.86, path: "projects/prj-octopus.md", updatedAt: "2026-10-12 10:00:00",
  body: "## 构建规则\n- 修改 shared/ 后必须 pnpm build <!--#oct-001-->\n\n## 已知陷阱\n- Promise.allSettled 聚合调用必须设全局超时 <!--#oct-007-->\n",
  anchors: ["oct-001", "oct-007"],
  gitHistory: [{ hash: "a3f9c21", date: "2026-10-12", message: "compile: projects/prj-octopus.md — +oct-013" }],
}

const SEARCH = {
  org: "xzf-dev", query: "Promise", mode: "fts",
  results: [{
    id: "prj-octopus", domain: "projects", title: "Octopus 平台工程知识",
    summary: "monorepo 构建/测试/端口规则与已知陷阱", path: "projects/prj-octopus.md",
    snippet: "- Promise.allSettled 聚合调用必须设全局超时", anchors: ["oct-007"],
  }],
}

interface FetchCall { url: string; method: string }
let calls: FetchCall[]

function mockFetch() {
  calls = []
  vi.stubGlobal("fetch", vi.fn(async (url: unknown, init: RequestInit = {}) => {
    const call: FetchCall = { url: String(url), method: init.method ?? "GET" }
    calls.push(call)
    if (call.url.includes("/wiki/tree")) return { ok: true, status: 200, json: async () => TREE }
    if (call.url.includes("/wiki/search")) return { ok: true, status: 200, json: async () => SEARCH }
    if (/\/wiki\/article\/[^?]+/.test(call.url)) return { ok: true, status: 200, json: async () => ARTICLE }
    return { ok: true, status: 200, json: async () => ({}) }
  }))
}

beforeEach(() => {
  vi.clearAllMocks()
  mockFetch()
})

describe("左域树 + 健康概览条（故事 1/32）", () => {
  it("renders domain groups with labels, counts and entries; System group exposes LOG.md", async () => {
    render(<WikiPage />)

    await waitFor(() => expect(screen.getByText("项目知识")).toBeDefined())
    expect(screen.getByText("工作流知识")).toBeDefined()
    expect(screen.getByText("问题案例档")).toBeDefined()
    // 域计数（label 行右侧 count）
    expect(screen.getAllByText("1").length).toBeGreaterThanOrEqual(3)
    // 词条行
    expect(screen.getByText("Octopus 平台工程知识")).toBeDefined()
    // System 组：LOG.md 入口
    expect(screen.getByRole("button", { name: /LOG\.md/ })).toBeDefined()
  })

  it("health summary bar shows 词条/规则/案例/最近编译/待审核", async () => {
    render(<WikiPage />)
    await waitFor(() => expect(screen.getByText("项目知识")).toBeDefined())

    const bar = screen.getByTestId("wiki-health-bar")
    expect(bar.textContent).toContain("词条 2")
    expect(bar.textContent).toContain("规则 3")
    expect(bar.textContent).toContain("案例 1")
    expect(bar.textContent).toContain("2026-10-12")
    expect(bar.textContent).toContain("待审核 3")
  })

  it("tree call is org-scoped", async () => {
    render(<WikiPage />)
    await waitFor(() => expect(screen.getByText("项目知识")).toBeDefined())
    expect(calls.some(c => c.url.includes("/wiki/tree") && c.url.includes("org=xzf-dev"))).toBe(true)
  })
})

describe("中栏词条渲染 + 右栏元数据（故事 2）", () => {
  it("clicking an entry loads /article/:id and renders body via MarkdownPreview with chips", async () => {
    render(<WikiPage />)
    await waitFor(() => expect(screen.getByText("项目知识")).toBeDefined())

    fireEvent.click(screen.getByRole("button", { name: /Octopus 平台工程知识/ }))

    await waitFor(() => expect(screen.getByTestId("wiki-entry-title").textContent).toBe("Octopus 平台工程知识"))
    expect(calls.some(c => /\/wiki\/article\/prj-octopus/.test(c.url))).toBe(true)
    // MarkdownPreview 桩：正文透传
    await waitFor(() => expect(document.querySelector("[data-md-preview]")).not.toBeNull())
    expect(document.querySelector("[data-md-preview]")!.textContent).toContain("Promise.allSettled 聚合调用必须设全局超时")

    // 元数据 chips（原型 Tab⑤ 中栏首行）
    expect(screen.getByText("projects")).toBeDefined()
    expect(screen.getByText("stable")).toBeDefined()
    expect(screen.getByText("confidence 0.86")).toBeDefined()
    expect(screen.getByText("编译于 2026-10-12")).toBeDefined()

    // 右栏：sources 溯源 + git 近史
    expect(screen.getByText("archive:ws-feat-actuator:2026-06-23")).toBeDefined()
    expect(screen.getByText("doc:docs/agents/windows-bash.md")).toBeDefined()
    expect(screen.getByText("a3f9c21")).toBeDefined()
    expect(screen.getByText("compile: projects/prj-octopus.md — +oct-013")).toBeDefined()
  })
})

describe("顶部检索 + LOG.md 渲染视图（故事 3/4）", () => {
  it("search box hits /search?q=…, jumps to the entry and highlights the hit anchor", async () => {
    render(<WikiPage />)
    await waitFor(() => expect(screen.getByText("项目知识")).toBeDefined())

    const input = screen.getByPlaceholderText(/FTS5/)
    fireEvent.change(input, { target: { value: "Promise" } })
    fireEvent.submit(input.closest("form")!)

    // 检索框接 search API（q+org 透传）
    await waitFor(() => expect(calls.some(c => c.url.includes("/wiki/search") && c.url.includes("q=Promise") && c.url.includes("org=xzf-dev"))).toBe(true))
    // 结果行显示命中片段（snippet）
    expect(await screen.findByText(/Promise\.allSettled 聚合调用必须设全局超时/)).toBeDefined()

    // 点击命中 → 跳转词条并高亮命中锚点
    fireEvent.click(screen.getByRole("button", { name: /Promise/ }))
    await waitFor(() => expect(screen.getByTestId("wiki-entry-title").textContent).toBe("Octopus 平台工程知识"))
    expect(document.querySelector('[data-anchor-hit="oct-007"]')).not.toBeNull()
  })

  it("LOG.md System entry renders the curation log table in the center column", async () => {
    render(<WikiPage />)
    await waitFor(() => expect(screen.getByText("项目知识")).toBeDefined())

    fireEvent.click(screen.getByRole("button", { name: /LOG\.md/ }))

    // MarkdownPreview 桩透传：表头与 fixture 行出现
    const md = await waitFor(() => {
      const el = document.querySelector("[data-md-preview]")
      expect(el).not.toBeNull()
      return el!
    })
    expect(md.textContent).toContain("| 日期 | 动作 | 词条 | 摘要 | 来源 | 审核 |")
    expect(md.textContent).toContain("task-207 归档提炼")
  })
})

describe("全站导航注册（AC：/wiki 入口）", () => {
  it("header 含「知识词条」→ /wiki（只读页入口）", () => {
    render(<Header />)
    const link = screen.getByRole("link", { name: /知识词条/ })
    expect(link.getAttribute("href")).toBe("/wiki")
  })

  it("只读纪律：页面上没有编辑/审核操作入口", async () => {
    render(<WikiPage />)
    await waitFor(() => expect(screen.getByText("项目知识")).toBeDefined())
    // 无「提议词条」「策展人对话」「审核队列」「编辑」等写操作按钮（票06 策展通道才有写入口）
    expect(screen.queryByRole("button", { name: /提议词条|策展人对话|审核队列|编辑/ })).toBeNull()
  })
})
