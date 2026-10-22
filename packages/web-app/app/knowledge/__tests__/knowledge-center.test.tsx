// 票11 · /knowledge 知识中心（读面）组件测试 — wiki-page.test.tsx / billing 先例
// （vi.stubGlobal fetch，URL 子串匹配 mock；jsdom 下 getServerUrl() 回落 3001 无关紧要）。
// 知识中心改版 ADR-0033 换契约：健康条→页头三槽+弹层全量；INDEX 五类树去必读组
// 加 INDEX 总览/原料库；偏好视图随概念删除（负断言防复活）；
// 对话列→策展人抽屉（恒挂载 overlay，本文件 mock，本体测于 knowledge-chat.test.tsx）。
// Seam: <KnowledgePage/>（app/knowledge/page.tsx）—— 树/页渲染/右栏/检索/健康弹层/LOG/原料库。
import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react"

// react-markdown 全家桶对单测是纯负担 — 桩到内容透传（wiki-page.test.tsx:15 同款）
vi.mock("@/components/resource/MarkdownPreview", () => ({
  MarkdownPreview: ({ content }: { content: string }) => <div data-md-preview>{content}</div>,
}))
// 策展人抽屉（clone-session + 卡片编排）本体测于 knowledge-chat.test.tsx；
// 本文件 = 读面 seam，桩掉以隔离聊天基建依赖（恒挂载 + open 反映到 class）
vi.mock("@/components/knowledge-center/curator-drawer", () => ({
  CuratorDrawer: ({ open }: { open: boolean }) => (
    <div data-testid="kc-curator-drawer" className={open ? "fixed translate-x-0" : "fixed translate-x-[102%]"} />
  ),
}))

import KnowledgePage from "../page"
import { AppRail } from "@/components/layout/app-rail"

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

const FINDINGS_OPEN = {
  org: "global",
  findings: [
    { id: "f1", kind: "contradiction", severity: "critical", status: "open", title: "矛盾：甲页 ↔ 乙页", detail: {}, pages: ["topics/a.md"], rawRef: "", source: "patrol", createdAt: "2026-10-15T00:00:00Z", updatedAt: "2026-10-15T00:00:00Z" },
    { id: "f2", kind: "bloat", severity: "major", status: "open", title: "膨胀榜：乙页", detail: {}, pages: ["topics/b.md"], rawRef: "", source: "patrol", createdAt: "2026-10-15T00:00:00Z", updatedAt: "2026-10-15T00:00:00Z" },
    { id: "f3", kind: "orphan", severity: "minor", status: "open", title: "孤儿页：丙页", detail: {}, pages: ["entities/c.md"], rawRef: "", source: "patrol", createdAt: "2026-10-15T00:00:00Z", updatedAt: "2026-10-15T00:00:00Z" },
  ],
}

const TREE = {
  org: "global",
  domains: [
    {
      name: "entity", label: "Entities", count: 1,
      entries: [{ id: "ent-open-octopus", path: "entities/ent-open-octopus.md", title: "Open Octopus（平台 monorepo）", summary: "工作流编排平台", stability: "stable", ruleCount: 0, links: [], backlinks: [] }],
    },
    {
      name: "concept", label: "Concepts", count: 1,
      entries: [{ id: "con-compiled-rag", path: "concepts/con-compiled-rag.md", title: "编译式 RAG", summary: "检索的重活在编译时", stability: "stable", ruleCount: 1, links: ["top-knowledge-injection"], backlinks: ["top-knowledge-injection"] }],
    },
    {
      name: "topic", label: "Topics", count: 1,
      entries: [{ id: "top-knowledge-injection", path: "topics/top-knowledge-injection.md", title: "知识注入沿革", summary: "注入式→编译式", stability: "stable", ruleCount: 1, links: ["con-compiled-rag"], backlinks: ["con-compiled-rag"] }],
    },
    {
      name: "projects", label: "项目知识", count: 1,
      entries: [{ id: "prj-octopus", path: "projects/prj-octopus.md", title: "Octopus 平台工程知识", summary: "monorepo 构建规则", stability: "stable", ruleCount: 2, links: [], backlinks: [] }],
    },
    {
      name: "cases", label: "问题案例档", count: 1,
      entries: [{ id: "case-2026-003", path: "cases/2026-06-23-pnpm-lockfile-mismatch.md", title: "CI 报 LOCKFILE_CONFIG_MISMATCH", summary: "pnpm 版本错配", stability: "stable", ruleCount: 0, links: [], backlinks: [] }],
    },
  ],
  stats: { entries: 4, cases: 1, rules: 4, lastCompiled: "2026-10-13" },
  log: null,
  index: "# Octopus Knowledge Wiki — global\n\n## 必读\n- ../SCHEMA.md — 人机共演约定\n\n## Concepts (1)\n- concepts/con-compiled-rag.md — 检索的重活在编译时 ←1 源\n",
}

const RAW_LIST = {
  org: "global",
  sources: [
    { path: "raw/inbox/2026-10-13-karpathy-llm-wiki.md", bytes: 12288, hash: "4f2a9c00000000000000000000000000000000000000000000000000000000aa", origin: "url:https://gist.github.com/karpathy/442a6bf", title: "Karpathy LLM Wiki", ingestedAt: "2026-10-13T09:12:00.000Z" },
    { path: "raw/inbox/meeting-1004.md", bytes: 4200, hash: "9c4d00000000000000000000000000000000000000000000000000000000b04", origin: "paste", title: "10-04 例会纪要", ingestedAt: "2026-10-04T02:00:00.000Z" },
  ],
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

// ── 知识根真实目录树 fixture（左栏改版 20261016）：与 TREE entries 的 path 全路径对齐 ──
const FS_TREE = {
  org: "global", root: "knowledge", truncated: false, total: 11,
  tree: [
    { name: "_archive", kind: "dir", path: "_archive", children: [
      { name: "pending-review-2026-10-14.json", kind: "file", path: "_archive/pending-review-2026-10-14.json" },
    ] },
    { name: "raw", kind: "dir", path: "raw", children: [
      { name: "inbox", kind: "dir", path: "raw/inbox", children: [
        { name: "2026-10-13-karpathy-llm-wiki.md", kind: "file", path: "raw/inbox/2026-10-13-karpathy-llm-wiki.md" },
      ] },
    ] },
    { name: "SCHEMA.md", kind: "file", path: "SCHEMA.md" },
    { name: "wiki", kind: "dir", path: "wiki", children: [
      { name: "_retired", kind: "dir", path: "wiki/_retired", children: [
        { name: "con-bye.md", kind: "file", path: "wiki/_retired/con-bye.md" },
      ] },
      { name: "concepts", kind: "dir", path: "wiki/concepts", children: [
        { name: "con-compiled-rag.md", kind: "file", path: "wiki/concepts/con-compiled-rag.md" },
      ] },
      { name: "projects", kind: "dir", path: "wiki/projects", children: [
        { name: "prj-octopus.md", kind: "file", path: "wiki/projects/prj-octopus.md" },
      ] },
      { name: "topics", kind: "dir", path: "wiki/topics", children: [
        { name: "top-knowledge-injection.md", kind: "file", path: "wiki/topics/top-knowledge-injection.md" },
      ] },
      { name: "INDEX.md", kind: "file", path: "wiki/INDEX.md" },
      { name: "LOG.md", kind: "file", path: "wiki/LOG.md" },
    ] },
  ],
}
const DOC_FILE = { org: "global", path: "SCHEMA.md", content: "# SCHEMA\n人机共演纪律", bytes: 24 }

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
    if (u.includes("/knowledge/findings")) return { ok: true, status: 200, json: async () => FINDINGS_OPEN }
    if (u.includes("/knowledge/log")) return { ok: true, status: 200, json: async () => ({ org: "global", lines: LOG_LINES }) }
    if (u.includes("/knowledge/health")) return { ok: true, status: 200, json: async () => HEALTH }
    if (u.includes("/api/knowledge/raw?")) return { ok: true, status: 200, json: async () => RAW_LIST }
    if (u.includes("/knowledge/fs/file")) return { ok: true, status: 200, json: async () => DOC_FILE }
    if (u.includes("/knowledge/fs")) return { ok: true, status: 200, json: async () => FS_TREE }
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

describe("页头健康三槽 + 点开弹层全量指标（负断言「无待审核」）", () => {
  it("三槽=分/findings/队列；点开弹层全量（页数按类/raw/ingest/最近编译/git HEAD）一个不砍", async () => {
    render(<KnowledgePage />)
    const bar = await screen.findByTestId("kc-health-bar")
    expect(bar.textContent).toContain("77")
    expect(bar.textContent).toContain("2")
    expect(bar.textContent).toContain("0")

    fireEvent.click(bar)
    const pop = await screen.findByTestId("kc-health-popover")
    expect(pop.textContent).toContain("页 52")
    expect(pop.textContent).toContain("实体 7")
    expect(pop.textContent).toContain("概念 9")
    expect(pop.textContent).toContain("主题 11")
    expect(pop.textContent).toContain("来源 23")
    expect(pop.textContent).toContain("判例 2")
    expect(pop.textContent).toContain("raw 源 31")
    expect(pop.textContent).toContain("本周 ingest 5")
    expect(pop.textContent).toContain("最近编译 2026-10-13")
    expect(pop.textContent).toContain("a3f9c21") // git HEAD 短哈希（原型 kbar「wiki git a3f9c21」）
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

  it("健康件加载失败显形，不伪造零值（CODING_STANDARDS #2）", async () => {
    mockFetch(u => (u.includes("/knowledge/health") ? { ok: false, status: 500, json: async () => ({ error: { message: "健康聚合炸了" } }) } : undefined))
    render(<KnowledgePage />)
    await screen.findByTestId("kc-tree-ready") // 树仍在
    const err = await screen.findByTestId("kc-health-error")
    expect(err.textContent).toContain("健康聚合炸了")
    expect(screen.queryByTestId("kc-health-popover")).toBeNull()
  })

  it("P4 票07：弹层平均置信——已测均值显数值；全库未测 null ⇒ 诚实 —（不伪造 0.5 初值均值）", async () => {
    const first = render(<KnowledgePage />)
    fireEvent.click(await screen.findByTestId("kc-health-bar"))
    const pop = await screen.findByTestId("kc-health-popover")
    expect(pop.textContent).toContain("平均置信 0.64")
    first.unmount()

    mockFetch(u => (u.includes("/knowledge/health") ? { ok: true, status: 200, json: async () => ({ ...HEALTH, avgConfidence: null }) } : undefined))
    render(<KnowledgePage />)
    fireEvent.click(await screen.findByTestId("kc-health-bar"))
    const pop2 = await screen.findByTestId("kc-health-popover")
    expect(pop2.textContent).toContain("平均置信 —")
  })

  it("P4 票08：弹层内 ranked findings 按 severity 分组列开放 findings（复用列表通道，零新页面）", async () => {
    render(<KnowledgePage />)
    const bar = await screen.findByTestId("kc-health-bar")
    expect(bar.textContent).toContain("77")

    // 点开三槽=票08 明细首例交互升级（既有 findings 列表 API 通道，无新端点无新路由页）
    fireEvent.click(bar)
    const panel = await screen.findByTestId("kc-ranked-findings")
    expect(panel.textContent).toContain("矛盾：甲页 ↔ 乙页")
    expect(panel.textContent).toContain("膨胀榜：乙页")
    expect(panel.textContent).toContain("孤儿页：丙页")
    // 按 severity 分组：紧急>重要>一般 的组序即 ranked 语义（故事 14 裁决动线）
    expect(panel.textContent).toContain("紧急")
    expect(panel.textContent).toContain("重要")
    expect(panel.textContent).toContain("一般")
    const text = panel.textContent!
    expect(text.indexOf("紧急")).toBeLessThan(text.indexOf("重要"))
    expect(text.indexOf("重要")).toBeLessThan(text.indexOf("一般"))
    // 零新页面负断言：分组层不引入新路由（仍在 /knowledge 页内）
    expect(screen.queryByRole("link", { name: /报告|报表|doctor/i })).toBeNull()
  })

  it("P4 票08：score null ⇒ 三槽显 —（诚实不可评，不伪造满分——空库/未装配巡检形态）", async () => {
    mockFetch(u => (u.includes("/knowledge/health") ? { ok: true, status: 200, json: async () => ({ ...HEALTH, score: null }) } : undefined))
    render(<KnowledgePage />)
    const bar = await screen.findByTestId("kc-health-bar")
    expect(bar.textContent).toContain("⚡ —")
  })
})

describe("知识根目录树（左栏改版 20261016：真实目录，INDEX/LOG/raw 三入口收进树）", () => {
  const fsRow = (p: string) => document.querySelector(`[data-kc-fs-path="${p}"]`) as HTMLElement | null

  it("根层=真实结构；智能展开让活页直接可见；归档收起；五类组头/v2 中文头/user_preference 全不外露", async () => {
    render(<KnowledgePage />)
    await screen.findByTestId("kc-tree-ready")

    // 根层直呈（对齐 ~/.octopus/knowledge 盘上实况）
    expect(fsRow("_archive")).toBeTruthy()
    expect(fsRow("raw")).toBeTruthy()
    expect(fsRow("SCHEMA.md")).toBeTruthy()
    // System 三入口收进树：INDEX/LOG 是 wiki 下文件叶，raw 目录行挂原料库语义
    expect(fsRow("wiki/INDEX.md")).toBeTruthy()
    expect(fsRow("wiki/LOG.md")).toBeTruthy()
    expect(screen.getByTestId("kc-select-rawlib")).toBeTruthy()
    // 智能展开：活页目录（concepts/topics/projects 非 "_" 前缀 depth≤1）自动开——页面直接可见
    expect(fsRow("wiki/concepts/con-compiled-rag.md")).toBeTruthy()
    expect(fsRow("wiki/topics/top-knowledge-injection.md")).toBeTruthy()
    expect(fsRow("wiki/projects/prj-octopus.md")).toBeTruthy()
    // 归档与货箱默认收起（_retired 36 页/raw 数十件不淹树）
    expect(fsRow("wiki/_retired/con-bye.md")).toBeNull()
    expect(fsRow("raw/inbox/2026-10-13-karpathy-llm-wiki.md")).toBeNull()
    // 负断言：五类组头消失、v2 中文组头不外露、偏好钮防复活
    expect(screen.queryByText(/Entities/)).toBeNull()
    expect(screen.queryByText(/Concepts/)).toBeNull()
    expect(screen.queryByText("项目知识")).toBeNull()
    expect(screen.queryByRole("button", { name: /user_preference/ })).toBeNull()
  })

  it("一键展开/收起：⤓展开 让归档叶显形，⤒收起 回到只留根层；根行点击=全树开关", async () => {
    render(<KnowledgePage />)
    await screen.findByTestId("kc-tree-ready")
    // 初始（智能展开）：活页可见、归档收起
    expect(fsRow("wiki/concepts/con-compiled-rag.md")).toBeTruthy()
    expect(fsRow("wiki/_retired/con-bye.md")).toBeNull()

    fireEvent.click(screen.getByTestId("kc-tree-expand-all"))
    expect(fsRow("wiki/_retired/con-bye.md")).toBeTruthy()
    expect((screen.getByTestId("kc-tree-expand-all") as HTMLButtonElement).disabled).toBe(true)

    fireEvent.click(screen.getByTestId("kc-tree-collapse-all"))
    expect(fsRow("wiki/concepts/con-compiled-rag.md")).toBeNull()
    expect(fsRow("wiki/INDEX.md")).toBeNull() // wiki 自身收起后子项全隐
    expect(fsRow("_archive")).toBeTruthy()   // 根层恒在
    // 根行点击 → 全展开（收起态下点击=展开）
    fireEvent.click(screen.getByTestId("kc-tree-root-toggle"))
    expect(fsRow("raw/inbox/2026-10-13-karpathy-llm-wiki.md")).toBeTruthy()
  })

  it("点击 raw 目录行=展开+原料库清单双动作；点 inbox 文件叶进 RawView", async () => {
    render(<KnowledgePage />)
    await screen.findByTestId("kc-tree-ready")
    fireEvent.click(screen.getByTestId("kc-select-rawlib"))
    // 展开即时生效（同一次点击）
    expect(fsRow("raw/inbox")).toBeTruthy()
    const lib = await screen.findByTestId("kc-raw-lib")
    expect(lib.textContent).toContain("2 个文件")
    fireEvent.click(fsRow("raw/inbox")!) // 二跳展开 inbox（raw 只开了自己）
    fireEvent.click(fsRow("raw/inbox/2026-10-13-karpathy-llm-wiki.md")!)
    const view = await screen.findByTestId("kc-raw-view")
    expect(view.textContent).toContain("raw/inbox/2026-10-13-karpathy-llm-wiki.md")
  })

  it("DocView：SCHEMA.md 叶=fs/file 只读渲染；_retired 叶走 doc 不错绑活跃页（全路径精确配判据钉）；非 md 置灰", async () => {
    render(<KnowledgePage />)
    await screen.findByTestId("kc-tree-ready")

    fireEvent.click(fsRow("SCHEMA.md")!)
    const doc = await screen.findByTestId("kc-doc-view")
    expect(doc.textContent).toContain("SCHEMA.md")
    await waitFor(() => expect(document.querySelector("[data-md-preview]")!.textContent).toContain("人机共演纪律"))
    expect(calls.some(c => /\/wiki\/article\//.test(c.url))).toBe(false)

    // _retired 展开后点击：落 DocView（发 fs/file 请求），且绝不发 article 请求（防退役页错绑活跃页）
    fireEvent.click(fsRow("wiki/_retired")!)
    fireEvent.click(fsRow("wiki/_retired/con-bye.md")!)
    await waitFor(() => expect(calls.some(c => c.url.includes("wiki%2F_retired%2Fcon-bye.md"))).toBe(true))
    expect(calls.some(c => /\/wiki\/article\//.test(c.url))).toBe(false)

    // 非 md 叶置灰不可点
    fireEvent.click(fsRow("_archive")!)
    const jsonRow = fsRow("_archive/pending-review-2026-10-14.json")! as HTMLButtonElement
    expect(jsonRow.disabled).toBe(true)
  })

  it("INDEX 总览特殊项：点开=tree.index 只读渲染（导航层上树，ADR-0033）", async () => {
    render(<KnowledgePage />)
    await screen.findByTestId("kc-tree-ready")
    fireEvent.click(screen.getByTestId("kc-select-index"))
    const view = await screen.findByTestId("kc-index-view")
    expect(view.textContent).toContain("INDEX.md — 知识总览")
    await waitFor(() => expect(document.querySelector("[data-md-preview]")!.textContent).toContain("## Concepts (1)"))
  })

  it("策展人抽屉恒挂载（overlay），页头钮开合、正文列不受影响", async () => {
    render(<KnowledgePage />)
    await screen.findByTestId("kc-tree-ready")
    const drawer = await screen.findByTestId("kc-curator-drawer")
    expect(drawer.className).toContain("translate-x-[102%]")
    fireEvent.click(screen.getByTestId("kc-drawer-toggle"))
    await waitFor(() => expect(screen.getByTestId("kc-curator-drawer").className).toContain("translate-x-0"))
    expect(screen.getByTestId("kc-tree-ready")).toBeDefined() // 树仍在原位（无模式重建）
  })
})

describe("原料库 raw（GET /api/knowledge/raw 的首个 importer · ADR-0033）", () => {
  it("System 组入口打开清单；点行→正文区不可变原文只读视图", async () => {
    render(<KnowledgePage />)
    await screen.findByTestId("kc-tree-ready")

    fireEvent.click(screen.getByTestId("kc-select-rawlib"))
    const lib = await screen.findByTestId("kc-raw-lib")
    expect(lib.textContent).toContain("原料库")
    expect(lib.textContent).toContain("2 个文件")
    expect(lib.textContent).toContain("Karpathy LLM Wiki")
    expect(lib.textContent).toContain("例会纪要")
    expect(calls.some(c => c.url.includes("/api/knowledge/raw?"))).toBe(true)

    fireEvent.click(screen.getAllByTestId("kc-raw-row")[0])
    const view = await screen.findByTestId("kc-raw-view")
    expect(view.textContent).toContain("raw/inbox/2026-10-13-karpathy-llm-wiki.md")
  })
})

describe("v3 页渲染：面包屑 / chips / 锚点现形 / git 近史折叠 / [[链接]] 跳页 / sources 溯源 / 右栏三件套", () => {
  it("renders breadcrumb, title, type/aliases/sources chips, anchor tokens and links chip navigates", async () => {
    render(<KnowledgePage />)
    await screen.findByTestId("kc-tree-ready")

    fireEvent.click(screen.getByRole("button", { name: /编译式 RAG/ }))

    await waitFor(() => expect(screen.getByTestId("kc-page-title").textContent).toBe("编译式 RAG"))
    expect(screen.getByTestId("kc-crumb").textContent).toContain("编译式 RAG") // 面包屑尾段
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

  it("右栏三件套：目录/实效账渲染 + 反链来自 tree.backlinks 且可点跳页", async () => {
    render(<KnowledgePage />)
    await screen.findByTestId("kc-tree-ready")
    fireEvent.click(screen.getByRole("button", { name: /编译式 RAG/ }))
    await screen.findByTestId("kc-page-title")

    const rail = await screen.findByTestId("kc-rail")
    expect(rail.textContent).toContain("本页目录")
    expect(rail.textContent).toContain("定义") // 正文 H2 派生
    expect(rail.textContent).toContain("反向链接")
    expect(rail.textContent).toContain("被引 12") // 实效账（effectiveness 实时段）
    expect(rail.textContent).toContain("75%")

    fireEvent.click(within(screen.getByTestId("kc-rail-backlinks")).getByText("知识注入沿革"))
    await waitFor(() => expect(screen.getByTestId("kc-page-title").textContent).toBe("知识注入沿革"))
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

  it("票07 页脚实效段：引用数/helpful 率/confidence（DB 实时值——与头 chips 快照值并存展示）", async () => {
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

  it("票07 页脚形态：未接账目（effectiveness null）整段缺席（诚实=不显假账）", async () => {
    mockFetch(u => (/\/wiki\/article\/[^?]+/.test(u) && !u.includes("top-knowledge-injection")
      ? { ok: true, status: 200, json: async () => ({ ...ARTICLE, effectiveness: null }) }
      : undefined))
    render(<KnowledgePage />)
    await screen.findByTestId("kc-tree-ready")
    fireEvent.click(screen.getByRole("button", { name: /编译式 RAG/ }))
    await screen.findByTestId("kc-page-title")
    expect(screen.queryByTestId("kc-effectiveness-footer")).toBeNull()
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

    fireEvent.click(screen.getByTestId("kc-select-log"))
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
    fireEvent.click(screen.getByTestId("kc-select-log"))
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

describe("全站导航注册（AC：知识中心入口，只加不删）", () => {
  it("左导轨含「知识中心」→ /knowledge", () => {
    render(<AppRail mobileOpen={false} onMobileOpenChange={() => {}} />)
    const link = screen.getByRole("link", { name: /知识中心/ })
    expect(link.getAttribute("href")).toBe("/knowledge")
  })

  it("票09 删除面生效：旧导航项退役，知识入口唯一 = 知识中心", () => {
    render(<AppRail mobileOpen={false} onMobileOpenChange={() => {}} />)
    expect(screen.queryByRole("link", { name: /知识词条/ })).toBeNull()
    expect(screen.queryByRole("link", { name: /工作经验/ })).toBeNull()
    expect(screen.getByRole("link", { name: /知识中心/ })).toBeDefined()
  })
})
