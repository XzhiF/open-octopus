#!/usr/bin/env node
/**
 * T4 — Browser E2E (handoff item 4 / US5 / fix F + fix N) with REQUIRED screenshots.
 * Flow: API-create v3 draft → open :3000/tasks board → click card → AuthoringWorkspace
 * WorkflowBox → 绑定工作流 dialog → click preset general-dev → RIGHT panel shows
 * goal/ac prefilled + max_turns="200" (fix F) → switch manually to another built-in
 * workflow → form inputs cleared (fix N) → save → badge shows built-in/task-dev → DB assert.
 */
import { resolveApiUrl, resolveWebUrl } from "../../../.claude/skills/e2e-harness/lib/api.mjs"
import { launchBrowser, takeScreenshot, captureConsole, closeBrowser } from "../../../.claude/skills/e2e-harness/lib/browser.mjs"
import { querySQL } from "../../../.claude/skills/e2e-harness/lib/db.mjs"
import { createResults, record, exitWithResults } from "../../../.claude/skills/e2e-harness/lib/reporter.mjs"

const API = resolveApiUrl()
const WEB = resolveWebUrl()
const results = createResults()
const ok = (name, cond, detail) => {
  record(results, name, !!cond, detail)
  console.log(`${cond ? "PASS" : "FAIL"} [${name}] ${detail ?? ""}`)
}
const shot = (page, name) => takeScreenshot(page, name)

async function api(pathname, opts = {}) {
  const r = await fetch(`${API}${pathname}`, {
    headers: { "Content-Type": "application/json", ...(opts.headers ?? {}) },
    ...opts,
  })
  return { status: r.status, data: await r.json().catch(() => null) }
}

let page, browser
try {
  // 1) create + prefill a v3 draft via API
  const created = await api("/api/tasks", { method: "POST", body: JSON.stringify({ org: "default", name: "E2E_TEST_GTD_browser", task_type: "coding", skill_groups: [] }) })
  const draft = created.data
  ok("PRE draft created", created.status === 201 && draft?.id, `id=${draft?.id}`)
  await api(`/api/tasks/${draft.id}`, {
    method: "PUT", headers: { "If-Match": String(draft.version) },
    body: JSON.stringify({ task_spec: { goal: "浏览器E2E占位目标", ac: ["浏览器E2E判据"], goal_confirmed: true, ac_confirmed: ["浏览器E2E判据"], task_type: "coding", skill_groups: [] } }),
  })

  // 2) open board
  ;({ browser, page } = await launchBrowser())
  const consoleCap = captureConsole(page)
  await page.goto(`${WEB}/tasks`, { waitUntil: "domcontentloaded", timeout: 30000 })
  const card = page.locator(`[data-task-card][data-task-id="${draft.id}"]`)
  try {
    await card.waitFor({ state: "visible", timeout: 20000 })
    ok("UI-1 board shows draft card", true, `selector matched`)
  } catch {
    await shot(page, "00-diag-board-missing-card")
    ok("UI-1 board shows draft card", false, `card not found; console errors=${consoleCap.errors.slice(0, 3).join(" | ")}`)
    throw new Error("card not found")
  }
  await card.click()

  // 3) WorkflowBox visible, unbound
  const box = page.locator("[data-workflow-box]")
  await box.waitFor({ state: "visible", timeout: 15000 })
  ok("UI-2 WorkflowBox rendered in authoring view", true)
  ok("UI-2 initially unbound", (await page.locator("[data-workflow-unbound]").count()) === 1)

  // 4) open binding dialog
  await page.locator("[data-workflow-bind-button]").click()
  await page.locator('[data-preset-item="general-dev"]').waitFor({ state: "visible", timeout: 15000 })
  ok("UI-3 dialog opens with recommended preset general-dev", true)

  // 5) click preset → prefill + fix F (max_turns default "200" shown)
  await page.locator('[data-preset-item="general-dev"]').click()
  await page.locator('[data-input-field="max_turns"]').waitFor({ state: "visible", timeout: 15000 })
  const goalVal = await page.locator('[data-input-field="goal"]').inputValue()
  const acVal = await page.locator('[data-input-field="ac"]').inputValue()
  const mtVal = await page.locator('[data-input-field="max_turns"]').inputValue()
  ok("UI-4 preset prefill goal=${goal}", goalVal === "${goal}", `goal="${goalVal}"`)
  ok("UI-4 preset prefill ac=${ac}", acVal === "${ac}", `ac="${acVal}"`)
  ok("UI-5 fix F max_turns input SHOWS \"200\"", mtVal === "200", `max_turns="${mtVal}"`)
  const s1 = await shot(page, "01-dialog-preset-general-dev-maxturns-200")
  ok("SHOT-1 proof fix F", s1.endsWith(".png"), s1)

  // 6) manual switch → fix N clears formInputs
  await page.locator('[data-workflow-item="built-in/xzf-dev"]').waitFor({ state: "visible", timeout: 10000 })
  await page.locator('[data-workflow-item="built-in/xzf-dev"]').click()
  await page.waitForTimeout(500) // let detail load
  // xzf-dev inputs: only `idea` — but fix N asserts previous goal/ac values are gone from formInputs.
  // Re-open task-dev manually to see goal field rendered empty (cleared, not "${goal}").
  const goalAfterSwitch = await page.locator('[data-input-field="goal"]').count()
  // if goal field absent (xzf-dev has no goal input) that alone proves no leakage; then pick task-dev manually:
  await page.locator('[data-workflow-item="built-in/task-dev"]').click()
  await page.locator('[data-input-field="goal"]').waitFor({ state: "visible", timeout: 10000 })
  const goalVal2 = await page.locator('[data-input-field="goal"]').inputValue()
  const acVal2 = await page.locator('[data-input-field="ac"]').inputValue()
  const mtVal2 = await page.locator('[data-input-field="max_turns"]').inputValue()
  ok("UI-6 fix N manual switch clears prefilled goal/ac", goalVal2 === "" && acVal2 === "", `goal="${goalVal2}" ac="${acVal2}" (xzf-dev had goal field=${goalAfterSwitch})`)
  ok("UI-6 untouched max_turns still shows default 200", mtVal2 === "200", `max_turns="${mtVal2}"`)
  const s2 = await shot(page, "02-dialog-manual-switch-cleared")
  ok("SHOT-2 proof fix N", s2.endsWith(".png"), s2)

  // 7) save → badge shows built-in/task-dev
  await page.locator("[data-bind-save-button]").click()
  const badge = page.locator("[data-workflow-ref-badge]")
  await badge.waitFor({ state: "visible", timeout: 15000 })
  const badgeText = await badge.innerText()
  ok("UI-7 badge shows built-in/task-dev", badgeText.includes("built-in/task-dev"), `badge="${badgeText.trim()}"`)
  await page.waitForTimeout(800)
  const s3 = await shot(page, "03-workflow-box-badge-bound")
  ok("SHOT-3 proof badge", s3.endsWith(".png"), s3)

  // 8) DB cross-validation: workflow_ref persisted
  const q = querySQL(`SELECT workflow_ref, task_spec FROM tasks WHERE id='${draft.id}'`)
  const row = q.data?.[0]
  const spec = row ? JSON.parse(row.task_spec) : {}
  ok("DB-1 workflow_ref=built-in/task-dev", row?.workflow_ref === "built-in/task-dev", `db.workflow_ref=${row?.workflow_ref}`)
  ok("DB-1 save dropped untouched default+cleared fields (no max_turns/goal/ac keys)",
    !("max_turns" in (spec.input_values ?? {})) && Object.keys(spec.input_values ?? {}).length === 0,
    `input_values=${JSON.stringify(spec.input_values)}`)

  // console hygiene
  ok("UI-8 no fatal console errors on flow", consoleCap.errors.filter(e => !/favicon|Download the React DevTools/i.test(e)).length === 0,
    consoleCap.errors.slice(0, 5).join(" | "))
} catch (err) {
  ok("T4 completed without unexpected error", false, String(err?.message ?? err))
} finally {
  // cleanup regardless
  try {
    const sweep = querySQL(`DELETE FROM schedules WHERE origin_id IN (SELECT id FROM tasks WHERE name LIKE 'E2E_TEST_GTD_%')`)
    const sweep2 = querySQL(`DELETE FROM tasks WHERE name LIKE 'E2E_TEST_GTD_%'`)
    const chk = querySQL(`SELECT COUNT(*) AS n FROM tasks WHERE name LIKE 'E2E_TEST_GTD_%'`)
    ok("CLEANUP browser task deleted", sweep.ok && sweep2.ok && Number(chk.data?.[0]?.n) === 0, `remaining=${chk.data?.[0]?.n}`)
  } catch (e) { ok("CLEANUP browser task deleted", false, String(e)) }
  if (browser) await closeBrowser(browser)
}

exitWithResults(results, { title: "T4 Browser E2E — fix F/N + badge + DB" })
