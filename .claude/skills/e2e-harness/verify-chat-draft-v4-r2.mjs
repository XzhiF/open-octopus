// PROTOTYPE-VERIFY r2 — 三项新改动的真机复验（一次性）
import { launchBrowser, takeScreenshot } from "file:///C:/xzf/ai/open-octopus/.qoder/skills/e2e-harness/lib/browser.mjs"
import { fetchJSON } from "file:///C:/xzf/ai/open-octopus/.qoder/skills/e2e-harness/lib/api.mjs"

const TASK_NAME = "E2E_VERIFY chat-draft-v4"
const R = (k, v) => console.log(`[${k}] ${v}`)
const { browser, page } = await launchBrowser()
page.setDefaultTimeout(15000)
try {
  const list = await fetchJSON("/api/tasks")
  const all = Array.isArray(list.data) ? list.data : (list.data?.tasks ?? [])
  let taskId = all.find((t) => t.name === TASK_NAME && t.status === "draft")?.id
  if (!taskId) {
    const created = await fetchJSON("/api/tasks", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ org: "default", name: TASK_NAME, task_spec: { format: "v4" } }) })
    taskId = created.data.id
  }
  R("task", taskId)

  await page.goto("http://localhost:3000/tasks", { waitUntil: "domcontentloaded" })
  await page.getByText(TASK_NAME).first().click()
  await page.locator("[data-authoring-workspace]").first().waitFor()

  // 1. 顶栏「草稿」只出现一次（type badge），状态 token 已删
  const barText = await page.locator("[data-terminal-bar]").innerText()
  const draftCount = (barText.match(/草稿/g) ?? []).length
  R("topbar-草稿-count", draftCount)

  // 2. 输入框初始高度（1 行 ≈ 36px 内容区）
  const ta = page.locator("[data-composer-block] textarea")
  const h = await ta.evaluate((el) => el.getBoundingClientRect().height)
  R("textarea-height-px", Math.round(h))
  await takeScreenshot(page, "r2-modal")

  // 3. Esc 不关窗
  await page.keyboard.press("Escape")
  await page.waitForTimeout(400)
  R("after-esc-modal-open", await page.locator("[data-authoring-workspace]").count())
  // 4. 点遮罩（弹窗外）不关窗
  await page.mouse.click(5, 5)
  await page.waitForTimeout(400)
  R("after-outside-click-modal-open", await page.locator("[data-authoring-workspace]").count())
  // 5. ✕ 仍可关
  await page.locator("[data-terminal-bar] button:has-text('✕')").click().catch(async () => {
    await page.locator("button[aria-label='关闭']").click()
  })
  await page.waitForTimeout(500)
  R("after-x-btn-modal-open", await page.locator("[data-authoring-workspace]").count())
} catch (e) {
  console.error("VERIFY-FAIL", e.message)
  await takeScreenshot(page, "r2-error").catch(() => {})
} finally {
  await browser.close()
}
