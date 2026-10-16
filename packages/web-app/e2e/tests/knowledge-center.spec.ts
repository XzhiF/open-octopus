// 知识中心改版（ADR-0033）E2E — wiki 主场 + 策展人抽屉交互契约。
// 真 server(3001)+web(3000) 真数据：开局页=机器主通道会话与全局 wiki 真实库。
// 钉三条人因验收：①抽屉开合/调宽不惊动正文列（重排病根治）；②INDEX 总览与
// 原料库读面真通（raw 清单端点首个 importer）；③页渲染+右栏三件套在场。
// 「永不自动跳转」由 vitest 负断言系覆盖（e2e 触发卡引用需真 LLM，成本不配）。
import { test, expect } from "@playwright/test"

const W = 1440
const H = 900

test.use({ viewport: { width: W, height: H } })

test.describe("知识中心 · wiki 主场 + 策展人抽屉", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/knowledge")
    await page.waitForSelector('[data-testid="kc-tree-ready"]', { timeout: 15000 })
  })

  test("抽屉开合零重排：正文列几何纹丝不动（双模式重排病的根治钉）", async ({ page }) => {
    const asideBox = await page.locator("aside").boundingBox()
    const stageBefore = await page.evaluate(() => {
      const el = document.querySelector("section")
      return el ? el.getBoundingClientRect().width : 0
    })
    expect(asideBox).not.toBeNull()

    // 开抽屉（overlay 盖上来，不是重排）——className 判态（真实数据内容撑满视口，isVisible 会假绿）
    await page.getByTestId("kc-drawer-toggle").click()
    await expect(page.getByTestId("kc-curator-drawer")).toHaveClass(/translate-x-0/, { timeout: 5000 })
    const asideAfter = await page.locator("aside").boundingBox()
    const stageAfter = await page.evaluate(() => {
      const el = document.querySelector("section")
      return el ? el.getBoundingClientRect().width : 0
    })
    expect(asideAfter!.x).toBeCloseTo(asideBox!.x, 1)
    expect(Math.abs(stageAfter - stageBefore)).toBeLessThan(1)

    // 拖宽把手存在且抽屉可关闭
    await expect(page.getByTestId("kc-drawer-resize")).toBeVisible()
    await page.getByTestId("kc-drawer-close").click()
    await expect(page.getByTestId("kc-curator-drawer")).toHaveClass(/translate-x-\[102%\]/, { timeout: 5000 })
  })

  test("树导航 → 页渲染 → 右栏三件套在场（目录/反链/实效账）", async ({ page }) => {
    const firstPage = page.locator('[data-testid="kc-tree-ready"] button').filter({ hasText: /▸/ }).first()
    await firstPage.click()
    await expect(page.getByTestId("kc-page-title")).toBeVisible({ timeout: 10000 })
    await expect(page.getByTestId("kc-crumb")).toBeVisible()
    // 1440px 视口 = xl 断点，右栏应现
    await expect(page.getByTestId("kc-rail")).toBeVisible()
    await expect(page.getByTestId("kc-rail").locator("text=本页目录")).toBeVisible()
    await expect(page.getByTestId("kc-rail").locator("text=反向链接")).toBeVisible()
  })

  test("INDEX 总览与原料库两特殊视图真读（tree.index + /api/knowledge/raw）", async ({ page }) => {
    await page.getByTestId("kc-select-index").click()
    await expect(page.getByTestId("kc-index-view")).toBeVisible()

    await page.getByTestId("kc-select-rawlib").click()
    const lib = page.getByTestId("kc-raw-lib")
    await expect(lib).toBeVisible()
    // 真库 raw 非空（本机 global wiki 已投喂多时）；行点开通只读原文
    const rows = page.getByTestId("kc-raw-row")
    await expect(rows.first()).toBeVisible({ timeout: 10000 })
    await rows.first().click()
    await expect(page.getByTestId("kc-raw-view")).toBeVisible()
  })

  test("抽屉会话面：主通道 tab 在场、历史按钮可开（多会话读面）", async ({ page }) => {
    await page.getByTestId("kc-drawer-toggle").click()
    const drawer = page.getByTestId("kc-curator-drawer")
    await expect(drawer).toBeVisible()
    // 主通道恒在（ensureSession 语义）：tab 条含「知识中心」会话
    await expect(page.getByTestId("kc-drawer-tabs")).toContainText("知识中心", { timeout: 10000 })
    await expect(page.getByTestId("kc-drawer-history")).toBeVisible()
    await page.getByTestId("kc-drawer-history").click()
    await expect(page.getByTestId("kc-drawer-history-pop")).toBeVisible()
  })

  test("负断言：user_preference 概念全消失（无必读组/无入口/无文案）", async ({ page }) => {
    await expect(page.locator("text=user_preference")).toHaveCount(0)
    await expect(page.locator("text=必读")).toHaveCount(0)
    // 双模式钮已删
    await expect(page.locator('button:has-text("对话模式")')).toHaveCount(0)
    await expect(page.locator('button:has-text("浏览模式")')).toHaveCount(0)
  })
})

// 引用药丸全动线（ADR-0033 决策④ e2e 半腿）：route-mock 注入一张 Lane A 迷你卡到
// 主通道会话，钉「新卡只亮丸不动正文，点丸才渲染」。真 LLM 产卡成本不配，通道消息面 mock。
test.describe("引用药丸 · 卡→丸→点开跳转闭环", () => {
  const tree = {
    org: "global",
    domains: [{
      name: "concept", label: "Concepts", count: 1,
      entries: [{ id: "con-e2e-pill", path: "concepts/con-e2e-pill.md", title: "E2E 药丸页", summary: "e2e mock 页", stability: "stable", ruleCount: 0, links: [], backlinks: [] }],
    }],
    stats: { entries: 1, cases: 0, rules: 0, lastCompiled: "2026-10-16" },
    log: null, index: null,
  }
  const article = {
    id: "con-e2e-pill", org: "global", domain: "concept", title: "E2E 药丸页", summary: "e2e mock 页",
    topics: [], stability: "stable", lastCompiled: "2026-10-16", sources: [], confidence: 0.9,
    path: "concepts/con-e2e-pill.md", updatedAt: "2026-10-16 00:00:00",
    body: "## 定义\n\n药丸动线验证页。", anchors: [], gitHistory: [], case: null,
    page: { type: "concept", entityKind: null, aliases: [], links: [] }, effectiveness: null,
  }
  const sess = {
    id: "kc-e2e-pill", title: "知识中心", org: "global", clone_name: "archive",
    perspective_clone_name: null, session_type: "chat", created_at: "2026-10-16T00:00:00Z",
    updated_at: "2026-10-16T00:00:00Z", last_message_at: "2026-10-16T00:00:01Z", is_active: true, scope_id: "knowledge",
  }
  const cardBlock = "```kc-card\n" + JSON.stringify({
    id: "e2e-pill-card-1", kind: "page-mini", ts: "2026-10-16T00:00:01Z",
    data: { pageId: "con-e2e-pill", path: "concepts/con-e2e-pill.md", title: "E2E 药丸页", type: "concept" },
  }) + "\n```"
  const msg = {
    id: "m-e2e-1", session_id: sess.id, role: "assistant",
    content: `这页刚编好。\n\n${cardBlock}`, created_at: "2026-10-16T00:00:01Z",
    is_summary: false, is_compressed: false, is_edited: false,
  }

  test.beforeEach(async ({ page }) => {
    await page.route(/\/api\//, route => {
      const u = route.request().url()
      const j = (v: unknown) => route.fulfill({ json: v as never })
      if (u.includes("/wiki/tree")) return j(tree)
      if (u.includes("/knowledge/health")) return j({ org: "global", pages: { total: 1, entity: 0, concept: 1, topic: 0, source: 0, case: 0 }, rawSources: 0, ingestedThisWeek: 0, openFindings: 0, queueDepth: 0, avgConfidence: null, score: null, lastCompiled: "", gitHead: null })
      if (u.includes("/wiki/article/")) return j(article)
      if (u.includes("/knowledge/findings")) return j({ org: "global", findings: [] })
      if (u.includes("/api/clones/archive/sessions?") || u.endsWith("/api/clones/archive/sessions")) return j({ sessions: [sess], has_more: false, next_cursor: null })
      if (u.includes("/api/clones/archive/sessions/")) return j({ session: sess, messages: { items: [msg], has_more: false } })
      if (u.includes("/api/clones")) return j({ clones: [] })
      return j({})
    })
    await page.goto("/knowledge")
    await page.waitForSelector('[data-testid="kc-tree-ready"]', { timeout: 15000 })
  })

  test("新卡引用页 → 只亮药丸正文不动；点药丸才渲染并消丸", async ({ page }) => {
    await page.getByTestId("kc-drawer-toggle").click()
    await expect(page.getByTestId("kc-card-page-mini")).toBeVisible({ timeout: 10000 })
    // 负断言：跟随已死——正文区没有被卡自动渲染
    await expect(page.getByTestId("kc-page-title")).toHaveCount(0)
    const pill = page.getByTestId("kc-cite-pill")
    await expect(pill).toBeVisible()
    await expect(pill).toContainText("E2E 药丸页")
    // 显式一点才跳转
    await pill.click()
    await expect(page.getByTestId("kc-page-title")).toHaveText("E2E 药丸页")
    await expect(pill).toHaveCount(0)
  })
})
