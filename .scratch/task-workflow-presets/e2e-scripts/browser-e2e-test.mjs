#!/usr/bin/env node
/**
 * E2E Browser Test — task-workflow-presets: WorkflowBox UI
 *
 * Tests AC:
 *  1. WorkflowBox renders in v3 authoring workspace (between GoalAcCard & OutputViewer)
 *  2. Binding dialog opens with presets + all workflows
 *  3. Binding dialog shows search + detail panel
 *  4. Preset click pre-fills inputs with ${goal}/${ac} templates
 *  5. Save persists workflow_ref + input_values
 */

import { chromium } from "playwright"
import { resolveApiUrl, resolveWebUrl, fetchJSON } from "../../../.claude/skills/e2e-harness/lib/api.mjs"
import fs from "node:fs"
import path from "node:path"

const API = resolveApiUrl()
const WEB = resolveWebUrl()
const ORG = "E2E_TD_org"
const PREFIX = "E2E_TEST_WP_"
const SCREENSHOT_DIR = "/Users/xzf/Projects/ai/XzhiF/open-octopus/.scratch/task-workflow-presets/e2e-screenshots"
const E2E_DATA = "/Users/xzf/Projects/ai/XzhiF/open-octopus/.scratch/task-workflow-presets/e2e-data"

const results = []
const createdTaskIds = []

function record(step, pass, detail = "") {
  const status = pass ? "PASS" : "FAIL"
  console.log(`[${status}] ${step}${detail ? ": " + detail : ""}`)
  results.push({ step, pass, detail })
  return pass
}

async function cleanup() {
  for (const id of createdTaskIds) {
    try { await fetchJSON(`${API}/api/tasks/${id}/abort`, { method: "POST" }) } catch {}
    try { await fetchJSON(`${API}/api/tasks/${id}`, { method: "DELETE" }) } catch {}
  }
  console.log(`\n[cleanup] Deleted ${createdTaskIds.length} test tasks`)
}

async function screenshot(page, name) {
  const filepath = path.join(SCREENSHOT_DIR, `${name}.png`)
  await page.screenshot({ path: filepath, fullPage: false })
  console.log(`  [screenshot] ${filepath}`)
  return filepath
}

async function main() {
  console.log("=== E2E Browser Test: WorkflowBox UI ===\n")

  // ─── Create a v3 task for UI testing ─────────────────────────────
  const createResp = await fetchJSON(`${API}/api/tasks`, {
    method: "POST",
    body: JSON.stringify({
      org: ORG,
      name: `${PREFIX}ui-workflow-box`,
      task_type: "coding",
      skill_groups: ["octo-xzf-implementer"],
      preset: { org: ORG, projects: [] },
    }),
  })
  if (!createResp.ok) {
    console.error("Failed to create task:", createResp.text)
    process.exit(1)
  }
  const taskId = createResp.data.id
  createdTaskIds.push(taskId)
  console.log(`[info] Created task ${taskId}`)

  // Fill in goal + ac so the task has content
  await fetchJSON(`${API}/api/tasks/${taskId}`, {
    method: "PUT",
    headers: { "If-Match": String(createResp.data.version) },
    body: JSON.stringify({
      task_spec: {
        goal: "E2E_TEST: WorkflowBox UI verification",
        ac: ["WorkflowBox renders", "Binding dialog works", "Preset pre-fills inputs"],
        task_type: "coding",
        skill_groups: ["octo-xzf-implementer"],
        goal_confirmed: true,
        ac_confirmed: [
          "WorkflowBox renders",
          "Binding dialog works",
          "Preset pre-fills inputs"
        ],
      },
    }),
  })

  // ─── Launch browser ───────────────────────────────────────────────
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()

  try {
    // ─── Navigate to tasks page ─────────────────────────────────────
    await page.goto(`${WEB}/tasks`, { waitUntil: "domcontentloaded", timeout: 30000 })
    await page.waitForTimeout(2000)
    await screenshot(page, "01-tasks-page")

    // ─── Click on the test task card ────────────────────────────────
    const taskCard = page.locator(`[data-task-id="${taskId}"]`)
    const taskCardExists = await taskCard.count() > 0

    if (!taskCardExists) {
      // Try to find by name text
      const byName = page.locator(`text=${PREFIX}ui-workflow-box`)
      const byNameExists = await byName.count() > 0
      if (byNameExists) {
        await byName.first().click()
      } else {
        // Screenshot and fail
        await screenshot(page, "01b-tasks-page-no-task")
        record("UI1: Task card visible on tasks page", false, "task card not found")
        await browser.close()
        await cleanup()
        process.exit(1)
      }
    } else {
      await taskCard.click()
    }

    await page.waitForTimeout(2000)
    await screenshot(page, "02-task-modal-open")

    // ─── Check WorkflowBox renders ──────────────────────────────────
    const workflowBox = page.locator("[data-workflow-box]")
    const workflowBoxExists = await workflowBox.count() > 0
    record("UI1: WorkflowBox renders in v3 authoring workspace", workflowBoxExists)
    await screenshot(page, "03-workflow-box-visible")

    // ─── Check unbound state ────────────────────────────────────────
    const unboundLabel = page.locator("[data-workflow-unbound]")
    const isUnbound = await unboundLabel.count() > 0
    record("UI2: WorkflowBox shows '未绑定' when no workflow_ref", isUnbound)

    // ─── Open binding dialog ────────────────────────────────────────
    const bindButton = page.locator("[data-workflow-bind-button]")
    await bindButton.click()
    await page.waitForTimeout(1500)
    await screenshot(page, "04-binding-dialog-open")

    // ─── Check dialog content ───────────────────────────────────────
    // Preset items should be visible
    const presetItems = page.locator("[data-preset-item]")
    const presetCount = await presetItems.count()
    record("UI3: Binding dialog shows preset recommendations", presetCount > 0,
      `preset count=${presetCount}`)

    // Check that general-dev preset is visible
    const generalPreset = page.locator('[data-preset-item="general-dev"]')
    const hasGeneral = await generalPreset.count() > 0
    record("UI4: general-dev preset visible in recommendations", hasGeneral)

    // Check that xzf-dev preset is visible (because task has octo-xzf-implementer skill group)
    const xzfPreset = page.locator('[data-preset-item="xzf-dev"]')
    const hasXzf = await xzfPreset.count() > 0
    record("UI5: xzf-dev preset visible (skill group match)", hasXzf)

    // Check workflow items (all built-in workflows)
    const workflowItems = page.locator("[data-workflow-item]")
    const workflowCount = await workflowItems.count()
    record("UI6: All built-in workflows listed", workflowCount > 0,
      `workflow count=${workflowCount}`)

    await screenshot(page, "05-binding-dialog-content")

    // ─── Test search ────────────────────────────────────────────────
    const searchInput = page.locator("input[placeholder='搜索工作流…']")
    await searchInput.fill("matt")
    await page.waitForTimeout(500)

    const filteredWorkflows = page.locator("[data-workflow-item]")
    const filteredCount = await filteredWorkflows.count()
    record("UI7: Search filters workflows", filteredCount > 0 && filteredCount < workflowCount,
      `filtered=${filteredCount} (was ${workflowCount})`)

    await screenshot(page, "06-search-results")

    // Clear search
    await searchInput.fill("")
    await page.waitForTimeout(500)

    // ─── Click a preset to pre-fill inputs ──────────────────────────
    await generalPreset.click()
    await page.waitForTimeout(1500)
    await screenshot(page, "07-preset-selected")

    // Check that the input field for 'idea' is pre-filled with ${goal}
    const ideaInput = page.locator("[data-input-field='idea']")
    const ideaValue = await ideaInput.inputValue()
    record("UI8: Preset click pre-fills idea with ${goal} template",
      ideaValue === "${goal}",
      `value="${ideaValue}"`)

    // ─── Save binding ───────────────────────────────────────────────
    const saveButton = page.locator("[data-bind-save-button]")
    await saveButton.click()
    await page.waitForTimeout(2000)
    await screenshot(page, "08-after-save")

    // ─── Verify bound state ─────────────────────────────────────────
    // WorkflowBox should now show the workflow ref badge
    const refBadge = page.locator("[data-workflow-ref-badge]")
    const isBound = await refBadge.count() > 0
    const refText = isBound ? await refBadge.textContent() : ""
    record("UI9: WorkflowBox shows bound workflow_ref badge", isBound,
      `ref="${refText}"`)

    // Input chips should be visible
    const inputChips = page.locator("[data-input-chips]")
    const hasChips = await inputChips.count() > 0
    record("UI10: Input value chips visible after binding", hasChips)

    await screenshot(page, "09-bound-state")

    // ─── Verify API data matches ────────────────────────────────────
    const taskResp = await fetchJSON(`${API}/api/tasks/${taskId}`)
    const apiWorkflowRef = taskResp.data?.workflow_ref
    const apiInputValues = taskResp.data?.task_spec?.input_values
    record("UI11: API confirms workflow_ref persisted",
      apiWorkflowRef === "built-in/matt-dev-pipeline",
      `api.workflow_ref="${apiWorkflowRef}"`)

    record("UI12: API confirms input_values persisted",
      apiInputValues?.idea === "${goal}",
      `api.input_values=${JSON.stringify(apiInputValues)}`)

    fs.writeFileSync(path.join(E2E_DATA, "ui-api-verification.json"), JSON.stringify({
      workflow_ref: apiWorkflowRef,
      input_values: apiInputValues,
    }, null, 2))

    // ─── Re-open dialog to verify "更换工作流" ──────────────────────
    const bindButton2 = page.locator("[data-workflow-bind-button]")
    await bindButton2.click()
    await page.waitForTimeout(1000)

    // Button text should say "更换工作流" now
    const buttonText = await bindButton2.textContent()
    record("UI13: Button text changes to '更换工作流' when bound",
      buttonText?.includes("更换工作流") ?? false,
      `text="${buttonText}"`)

    await screenshot(page, "10-rebind-dialog")

    // Close dialog
    await page.keyboard.press("Escape")
    await page.waitForTimeout(500)

  } catch (err) {
    console.error("Browser test error:", err)
    await screenshot(page, "error-state")
  } finally {
    await browser.close()
  }

  // ─── Summary ────────────────────────────────────────────────────────
  const passed = results.filter(r => r.pass).length
  const failed = results.filter(r => !r.pass).length
  console.log(`\n=== Browser E2E Summary: ${passed} PASS, ${failed} FAIL out of ${results.length} tests ===`)

  await cleanup()

  if (failed > 0) {
    process.exit(1)
  }
}

main().catch(err => {
  console.error("Test crashed:", err)
  cleanup().finally(() => process.exit(1))
})
