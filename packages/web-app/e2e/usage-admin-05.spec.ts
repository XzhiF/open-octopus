/**
 * usage-admin-3 票05 · browser 走查（真实 dev server + 隔离分支库 + E2E_TD_ 种子）
 * 步骤：菜单→列齐全/倒序→source 筛选对账 curl→展开 trace 树对账 sqlite→聚合 4 dim→格式化三态。
 * 证据：截图 ×3 → .scratch/.../e2e-screenshots/；API/sqlite 对照由 spec 断言 + 走查脚本落盘。
 */
import { test, expect } from "@playwright/test"

const SERVER = process.env.E2E_SERVER_URL || "http://localhost:3338"
const SHOTS = process.env.E2E_SHOTS || "."

// 展示格式化 oracle（独立复刻 lib/format.ts 口径作交叉验证，非产品代码）
const fmtTok = (n: number) => (n < 1000 ? String(Math.round(n)) : n < 1e6 ? `${(n / 1000).toFixed(1)}K` : `${(n / 1e6).toFixed(1)}M`)
const fmtCost = (usd: number | null, complete = true) =>
  usd == null ? "—" : `${complete ? "$" : "≈$"}${usd.toLocaleString("en-US", { minimumFractionDigits: usd >= 1 ? 2 : 4, maximumFractionDigits: usd >= 1 ? 2 : 4 })}`

async function api(path: string) {
  const res = await fetch(`${SERVER}${path}`)
  expect(res.ok, `API ${path} → ${res.status}`).toBe(true)
  return res.json()
}

test.describe("usage-admin-3 · /system/usage browser 走查", () => {
  test("S1 菜单入口 + 明细列表列齐全 + 时间倒序", async ({ page }) => {
    await page.goto("/system/models")
    await expect(page.getByRole("link", { name: "Token 使用" })).toBeVisible()
    await page.getByRole("link", { name: "Token 使用" }).click()
    await expect(page).toHaveURL(/\/system\/usage/)
    await expect(page.getByRole("heading", { name: "Token 使用" })).toBeVisible()
    await expect(page.getByRole("tab", { name: "明细" })).toBeVisible()

    const table = page.getByRole("table")
    for (const h of ["时间", "source", "model", "归因", "in", "out", "缓存读", "缓存写", "ttft", "耗时", "费用"]) {
      await expect(table.getByRole("columnheader", { name: h, exact: true })).toBeVisible()
    }
    // 种子行时间最新 → 倒序后前几行必为 E2E_TD（旧序列在前的缺陷会在此暴露）
    const firstAttrib = table.getByRole("cell").nth(3)
    await expect(firstAttrib).toContainText(/E2E_TD_(sess1|exec1|ne1|exec2)/)
    await page.screenshot({ path: `${SHOTS}/01-detail-list.png`, fullPage: false })
  })

  test("S2 source=chat 筛选行数 == curl total", async ({ page }) => {
    await page.goto("/system/usage")
    await expect(page.getByRole("table")).toBeVisible()
    const curl = await api("/api/usage/llm-calls?page=1&page_size=50&source=chat")
    await page.getByLabel("来源筛选").selectOption("chat")
    await expect(page.getByText(`共 ${curl.total} 条`)).toBeVisible()
    // 会话筛选缩小到种子组（先清 source，筛选位是叠加语义）
    await page.getByLabel("来源筛选").selectOption("")
    await page.getByLabel("会话筛选").fill("E2E_TD_sess1")
    const sess = await api("/api/usage/llm-calls?page=1&session_id=E2E_TD_sess1&source=all")
    expect(sess.calls.length).toBe(4)
    await expect(page.getByText("共 4 条")).toBeVisible()
    await expect(page.getByRole("row", { name: /E2E_TD_sess1/ })).toHaveCount(4)
  })

  test("S3 展开 t1 → 轮分组 + 逐调用四字段 + 小计 == sqlite 手算（含未定价行 —）", async ({ page }) => {
    await page.goto("/system/usage")
    await page.getByLabel("会话筛选").fill("E2E_TD_sess1")
    await expect(page.getByText("共 4 条")).toBeVisible()

    await page.getByLabel("展开调用树").first().click()
    const tree = page.getByTestId("trace-tree")
    await expect(tree).toBeVisible()

    // sqlite/API 交叉锚（种子值手算）：Σ四字段 = 1800+540+425+270 = 3035；cost 已知和 0.05+0.01+0.02=0.08，含 1 条未定价 → 部分和三态
    const trace = await api("/api/usage/llm-calls?trace_id=E2E_TD_t1&source=all")
    const sum = trace.calls.reduce((a: number, c: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number }) =>
      a + c.inputTokens + c.outputTokens + c.cacheReadTokens + c.cacheCreationTokens, 0)
    expect(sum).toBe(3035)
    await expect(tree.getByText(`小计 ${fmtTok(sum)} tokens`)).toBeVisible()
    await expect(tree.getByText("轮 1")).toBeVisible()
    await expect(tree.getByText("轮 2")).toBeVisible()
    await expect(tree.getByText(fmtCost(0.08, false))).toBeVisible() // ≈$0.0800 三态
    // 逐调用行可见：turn1 两次 + turn2 两次 → 第1次×2、第2次×2
    await expect(tree.getByText("第1次")).toHaveCount(2)
    await expect(tree.getByText("第2次")).toHaveCount(2)
    // 明细未定价行（t1c）：费用列显示 — 而非 $0.00（表格全局兜底，S6 另有门禁）
    await expect(page.getByText("$0.00")).toHaveCount(0)
    // 同轮标记：其余 3 行带「同轮」
    await expect(page.getByText("同轮")).toHaveCount(3)
    await page.screenshot({ path: `${SHOTS}/02-trace-tree.png`, fullPage: false })
  })

  test("S4 引擎行展开补链 + 无 trace 旧行占位", async ({ page }) => {
    await page.goto("/system/usage")
    await page.getByLabel("来源筛选").selectOption("engine")
    // 旧行占位（源库历史行也满足 ≥1）
    await expect(page.getByText("无追踪链").first()).toBeVisible()
    const execRow = page.getByRole("row", { name: /E2E_TD_exec1/ }).first()
    await expect(execRow).toBeVisible()
    await execRow.getByLabel("展开调用树").click()
    const tree = page.getByTestId("trace-tree")
    await expect(tree).toContainText("执行 E2E_TD_exec1")
    await expect(tree).toContainText("节点 E2E_TD_node1")
    await expect(tree).toContainText("wf-demo") // workflow 归因面包屑
    // t2 Σ = 980/980（800+120+40+20）→ 小计 980 tokens
    await expect(tree.getByText(`小计 ${fmtTok(980)} tokens`)).toBeVisible()
    await page.screenshot({ path: `${SHOTS}/04-trace-engine.png`, fullPage: false })
  })

  test("S5 聚合 tab：4 dim 逐切 + engine 组三方一致（屏 == curl == sqlite 手算）", async ({ page }) => {
    await page.goto("/system/usage")
    await page.getByRole("tab", { name: "聚合" }).click()
    const dimSel = page.getByLabel("聚合维度")

    for (const d of ["day", "source", "model", "clone"]) {
      await dimSel.selectOption(d)
      await expect(page.getByTestId("agg-share").first()).toBeVisible({ timeout: 10000 })
    }
    await dimSel.selectOption("source")

    // curl 对照：engine 组数值
    const agg = await api("/api/usage/aggregate?dim=source")
    const eng = agg.rows.find((r: { key: string }) => r.key === "engine")
    expect(eng, "engine 组存在").toBeDefined()
    const engRow = page.getByRole("row").filter({ has: page.getByRole("cell", { name: "engine", exact: true }) })
    await expect(engRow.getByRole("cell").nth(1)).toHaveText(String(eng.calls))
    await expect(engRow.getByRole("cell").nth(2)).toHaveText(fmtTok(eng.inputTokens))
    await expect(engRow.getByRole("cell").nth(6)).toHaveText(fmtTok(eng.totalTokens)) // total
    // sqlite 手算（走查脚本另侧断言）：屏 total == sql 值 → 记入证据
    console.log(`E2E_TD_AGG engine: calls=${eng.calls} in=${eng.inputTokens} total=${eng.totalTokens} cost=${eng.costUsd} complete=${eng.costComplete}`)
    // 占比条存在（day 维度也应有）
    await expect(engRow.getByTestId("agg-share")).toBeVisible()
    await page.screenshot({ path: `${SHOTS}/03-aggregate.png`, fullPage: false })
  })

  test("S6 格式化门禁：无裸小数爆炸/无 5 位以上小数/未定价非 $0.00", async ({ page }) => {
    await page.goto("/system/usage")
    await page.getByLabel("会话筛选").fill("E2E_TD_sess1")
    await expect(page.getByText("共 4 条")).toBeVisible()
    const body = await page.getByRole("table").innerText()
    expect(body).not.toMatch(/\d\.\d{5,}/) // 无 toFixed 爆炸
    expect(body).not.toMatch(/\$0\.00\b(?!\d)/) // 未定价绝不焊成 $0.00
    // 四字段格式化：1000→1.0K 而非裸 1000
    await expect(page.getByRole("table").getByText("1.0K").first()).toBeVisible()
  })
})
