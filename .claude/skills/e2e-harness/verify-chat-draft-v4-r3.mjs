// PROTOTYPE-VERIFY r3 — 交互四点复验（一次性、throwaway）
// 1 Alt+Enter 换行；2 / 列表含内置 context 等；3 Tab 取消 & Enter 保留输入
// （非精确不强制选中）；4 chat↔spec 分割线 = 一条细线。
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

  const ta = page.locator("[data-composer-block] textarea")
  await ta.click()

  // —— 1. Alt+Enter 换行、不发送 ——
  await ta.fill("hello")
  await page.keyboard.press("Alt+Enter")
  await page.keyboard.type("world")
  const val1 = await ta.inputValue()
  R("alt-enter-newline", JSON.stringify(val1))          // 期望 "hello\nworld"
  R("msg-count-after-altenter", await page.locator('[data-tui-msg="user"]').count())

  // —— 2. "/" 出下拉，内置段含 compact / context ——
  await ta.fill("")
  await ta.type("/")
  await page.locator("[data-slash-autocomplete]").first().waitFor()
  const dropText = await page.locator("[data-slash-autocomplete]").innerText()
  R("slash-has-compact", /compact/.test(dropText))
  R("slash-has-context", /context/.test(dropText))

  // —— 3a. Tab 取消：下拉关闭，文本仍是 "/" ——
  await page.keyboard.press("Tab")
  await page.waitForTimeout(150)
  R("after-tab-dropdown-open", await page.locator("[data-slash-autocomplete]").count())
  R("after-tab-value", JSON.stringify(await ta.inputValue()))

  // —— 3b. 非精确 "/co"（命中 compact/context/cost/config…）Enter：
  //        不强制选第一个，只收起下拉、原样保留 "/co"、不发送 ——
  await ta.fill("")
  await ta.type("/co")
  await page.locator("[data-slash-autocomplete]").first().waitFor()
  await page.keyboard.press("Enter")
  await page.waitForTimeout(150)
  R("partial-enter-value", JSON.stringify(await ta.inputValue())) // 期望 "/co"
  R("partial-enter-dropdown", await page.locator("[data-slash-autocomplete]").count())

  // —— 3c. 精确 "/compact" Enter：补全为 "/compact "（尾空格），不发送 ——
  await ta.fill("")
  await ta.type("/compact")
  await page.locator("[data-slash-autocomplete]").first().waitFor()
  const beforeSend = await page.locator('[data-tui-msg="user"]').count()
  await page.keyboard.press("Enter")
  await page.waitForTimeout(150)
  R("exact-enter-value", JSON.stringify(await ta.inputValue()))   // 期望 "/compact "
  R("exact-enter-dropdown", await page.locator("[data-slash-autocomplete]").count())
  R("exact-enter-msg-sent?", (await page.locator('[data-tui-msg="user"]').count()) !== beforeSend)

  await ta.fill("")
  await takeScreenshot(page, "r3-modal")

  // —— 4. 分割线：一条细线（不再是 repeating-gradient 拉条）——
  const divider = await page.locator('[title="拖拽调整宽度"]').first().evaluate((el) => ({
    inlineBg: el.getAttribute("style") || "",
    inner: el.querySelector("div") ? getComputedStyle(el.querySelector("div")).width : "none",
  }))
  R("divider-no-gradient", !/repeating-linear-gradient/.test(divider.inlineBg))
  R("divider-inner-line-width", divider.inner)
} catch (e) {
  console.log("VERIFY-ERROR", e.message)
  await takeScreenshot(page, "r3-error").catch(() => {})
} finally {
  await browser.close()
}
