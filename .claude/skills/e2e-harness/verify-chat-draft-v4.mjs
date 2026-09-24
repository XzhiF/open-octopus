// PROTOTYPE-VERIFY c06db89a — 任务草稿 chat UI 真机验收（一次性，跑完可删）
import { launchBrowser, takeScreenshot } from "file:///C:/xzf/ai/open-octopus/.qoder/skills/e2e-harness/lib/browser.mjs"
import { fetchJSON } from "file:///C:/xzf/ai/open-octopus/.qoder/skills/e2e-harness/lib/api.mjs"

const TASK_NAME = "E2E_VERIFY chat-draft-v4"
const R = (k, v) => console.log(`[${k}] ${v}`)

const { browser, page } = await launchBrowser()
page.setDefaultTimeout(15000)
try {
  // 0. 复用/造任务
  const list = await fetchJSON("/api/tasks")
  const all = Array.isArray(list.data) ? list.data : (list.data?.tasks ?? [])
  let taskId = all.find((t) => t.name === TASK_NAME && t.status === "draft")?.id
  if (!taskId) {
    const created = await fetchJSON("/api/tasks", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ org: "default", name: TASK_NAME, task_spec: { format: "v4" } }) })
    taskId = created.data.id
  }
  // 清掉历史重复的 E2E_VERIFY 草稿（只留一个）
  for (const t of all.filter((x) => x.name === TASK_NAME && x.status === "draft" && x.id !== taskId)) {
    await fetchJSON(`/api/tasks/${t.id}`, { method: "DELETE" }).catch(() => {})
  }
  R("task", taskId)

  await page.goto("http://localhost:3000/tasks", { waitUntil: "domcontentloaded" })
  await page.getByText(TASK_NAME).first().click()
  await page.locator("[data-authoring-workspace]").first().waitFor()
  R("modal", "draft 工作台已打开")

  // 1. 入队清单 = 7 行 + 顶栏计数 x/7 + 按钮 locked
  const rows = await page.locator("[data-checklist-v4]").evaluateAll((els) => els.map((e) => e.getAttribute("data-checklist-v4")))
  R("checklist-rows", JSON.stringify(rows))
  R("bar-count", await page.locator("[data-terminal-bar]").innerText().then((t) => (t.match(/入队清单\s+\d\/\d/) ?? ["?"])[0]))
  R("enqueue-disabled", await page.locator("[data-task-enqueue]").isDisabled())
  await takeScreenshot(page, "01-modal-gate")

  // 2. slash：placeholder 计数 + 打 / 出分组下拉
  const input = page.locator("[data-testid='chat-input'], textarea").last()
  R("placeholder", await input.getAttribute("placeholder"))
  await input.type("/")
  await page.locator("[data-slash-autocomplete]").waitFor({ state: "visible" })
  const ddText = await page.locator("[data-slash-autocomplete]").innerText()
  R("slash-groups", JSON.stringify([ddText.includes("内置命令"), ddText.includes("技能命令")]))
  const first = await page.locator("[data-slash-autocomplete] button").first().innerText()
  R("slash-first", first.replace(/\n/g, " "))
  await takeScreenshot(page, "02-slash-dropdown")

  // 3. Esc 两段：先关下拉，再关弹窗
  await page.keyboard.press("Escape")
  await page.waitForTimeout(300)
  R("esc1-dropdown-open", await page.locator("[data-slash-autocomplete]").count())
  await page.keyboard.press("Escape")
  await page.waitForTimeout(500)
  R("esc2-modal-open", await page.locator("[data-authoring-workspace]").count())

  // 4. 重开 → 发消息看用户气泡（Claude Code 底）+ AI markdown/✳ 渲染
  await page.getByText(TASK_NAME).first().click()
  await page.locator("[data-authoring-workspace]").first().waitFor()
  const input2 = page.locator("[data-testid='chat-input'], textarea").last()
  await input2.fill("请用一句话介绍你自己，并用**加粗**和`行内代码`演示格式")
  await input2.press("Enter")
  await page.waitForTimeout(2500)
  const usrBg = await page.locator("[data-tui-msg='user']").first().evaluate((el) => getComputedStyle(el).backgroundColor)
  R("user-bubble-bg", usrBg)
  await page.waitForTimeout(12000) // 给 thinking/流式一点时间
  await takeScreenshot(page, "03-chat-stream")
  const thinkingLines = await page.locator("[data-tui-thinking] > div:nth-child(2) > div").count()
  R("thinking-visible-lines(<=3)", thinkingLines)
  const stars = await page.locator("[data-tui-msg='assistant'] [data-tui-mark]").count()
  R("assistant-mark-count", stars)
  // 收尾打断
  await page.keyboard.press("Escape").catch(() => {})

  // 5. 清理
  await fetchJSON(`/api/tasks/${taskId}`, { method: "DELETE" }).catch(() => {})
  R("cleanup", "task deleted (或需软删接口)")
} catch (e) {
  console.error("VERIFY-FAIL", e.message)
  await takeScreenshot(page, "99-error").catch(() => {})
} finally {
  await browser.close()
}
