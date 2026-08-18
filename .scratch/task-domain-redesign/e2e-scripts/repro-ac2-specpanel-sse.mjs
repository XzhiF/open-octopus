// .scratch/task-domain-redesign/e2e-scripts/repro-ac2-specpanel-sse.mjs
//
// Tight feedback loop for AC2: SpecPanel doesn't apply spec_field_update SSE
// when the field already has a value (agent pre-set goal during chat).
//
// Reproduces the bug pattern WITHOUT the 2m task-author chat:
//   1. POST /api/tasks — create a draft task (simulating autosave)
//   2. POST /api/tasks/:id/spec-field {field: "goal", value: "AGENT_GOAL"} —
//      simulates the agent setting a goal during chat
//   3. Open /tasks, click the card → SpecPanel mounts, loads AGENT_GOAL
//   4. POST /api/tasks/:id/spec-field {field: "goal", value: "NEW_GOAL"} —
//      the test's updateSpecField call
//   5. Capture browser console ([DEBUG-sse] + [DEBUG-reseed] logs) for 10s
//   6. Assert: #task-goal textarea === NEW_GOAL (the SSE should have applied)
//
// Usage: node e2e-scripts/repro-ac2-specpanel-sse.mjs
import { chromium } from "playwright"

const SERVER = process.env.OCTOPUS_SERVER_URL ?? "http://localhost:3001"
const WEB = "http://localhost:3000"
const ORG = "E2E_TD_org"
const TASK_NAME = "E2E_TD_repro-ac2-" + Date.now()
const AGENT_GOAL = "E2E 验证 agent 预设的 goal（模拟对话中 agent 绑定）"
const NEW_GOAL = "Design a task with resource loading and spec linkage."

async function main() {
  // 0. Create a task-author chat session (simulating the autosave-linked session)
  const sessRes = await fetch(`${SERVER}/api/clones/task-author/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Octopus-Org": ORG },
    body: JSON.stringify({ title: TASK_NAME }),
  })
  if (!sessRes.ok) throw new Error(`createCloneSession failed: ${sessRes.status}`)
  const session = await sessRes.json()
  console.log(`[repro] created task-author session ${session.id} (linked to task)`)

  // 1. Create draft task WITH source_chat_session_id (simulates autosave)
  const createRes = await fetch(`${SERVER}/api/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ org: ORG, name: TASK_NAME, source_chat_session_id: session.id }),
  })
  if (!createRes.ok) throw new Error(`createTask failed: ${createRes.status}`)
  const task = await createRes.json()
  console.log(`[repro] created task ${task.id} (status=${task.status}, session=${session.id})`)

  try {
    // 2. Simulate agent setting a goal (the "agent pre-set during chat" step)
    const agentGoalRes = await fetch(`${SERVER}/api/tasks/${task.id}/spec-field`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ field: "goal", value: AGENT_GOAL }),
    })
    if (!agentGoalRes.ok) throw new Error(`agent goal set failed: ${agentGoalRes.status}`)
    console.log(`[repro] agent set goal="${AGENT_GOAL.slice(0, 40)}..."`)

    // 3. Launch browser + navigate to /tasks
    const browser = await chromium.launch({ headless: true })
    const context = await browser.newContext()
    const page = await context.newPage()

    // Capture ALL console logs
    const consoleLogs = []
    page.on("console", (msg) => {
      const text = msg.text()
      if (text.includes("[DEBUG-")) {
        consoleLogs.push({ type: msg.type(), text })
      }
    })

    await page.goto(`${WEB}/tasks`)
    await page.waitForLoadState("domcontentloaded")
    await page.locator('[data-task-column="draft"]').waitFor({ state: "visible", timeout: 15000 })

    // Find + click the task card
    const card = page.locator('[data-task-card]', { hasText: TASK_NAME }).first()
    await card.waitFor({ state: "visible", timeout: 10000 })
    await card.click()
    console.log(`[repro] clicked card, modal opening...`)

    // Wait for modal dialog to be visible (matches the test's expect(dialog).toBeVisible)
    const dialog = page.getByRole("dialog")
    await dialog.waitFor({ state: "visible", timeout: 10000 })

    // Print console logs so far (should have [DEBUG-reseed] + [DEBUG-sse] SUBSCRIBE)
    console.log(`[repro] console logs after dialog visible (before NEW goal):`)
    for (const log of consoleLogs) console.log(`  ${log.type}: ${log.text}`)

    // Check the textarea value IF it's rendered (don't wait for it — the test doesn't)
    let initialValue = "(not yet rendered)"
    try {
      const goalInput = dialog.locator("#task-goal")
      initialValue = await goalInput.inputValue({ timeout: 2000 }).catch(() => "(timeout)")
    } catch { /* may not be rendered yet */ }
    console.log(`[repro] textarea value (2s probe): "${String(initialValue).slice(0, 60)}..."`)

    // 4. Set NEW goal via spec-field IMMEDIATELY (matches the test — no extra wait for textarea)
    console.log(`[repro] setting NEW goal="${NEW_GOAL.slice(0, 40)}..." (immediately after dialog visible)`)
    const newGoalRes = await fetch(`${SERVER}/api/tasks/${task.id}/spec-field`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ field: "goal", value: NEW_GOAL }),
    })
    if (!newGoalRes.ok) throw new Error(`new goal set failed: ${newGoalRes.status}`)
    const newGoalBody = await newGoalRes.json()
    console.log(`[repro] spec-field POST returned version=${newGoalBody.version}`)

    // 5. Wait for the SSE to apply (or not) — check the textarea for 10s
    const goalInput = dialog.locator("#task-goal")
    let finalValue = initialValue
    const deadline = Date.now() + 10000
    while (Date.now() < deadline) {
      await page.waitForTimeout(500)
      const currentValue = await goalInput.inputValue().catch(() => "(error)")
      if (currentValue !== finalValue) {
        console.log(`[repro] textarea CHANGED at ${Date.now()}ms: "${String(currentValue).slice(0, 60)}..."`)
        finalValue = currentValue
      }
    }

    // Print ALL console logs (should include [DEBUG-sse] APPLY if SSE fired)
    console.log(`\n[repro] ALL console logs after NEW goal:`)
    for (const log of consoleLogs) console.log(`  ${log.type}: ${log.text}`)

    // 6. Assert
    console.log(`\n[repro] FINAL textarea value: "${finalValue.slice(0, 60)}..."`)
    console.log(`[repro] EXPECTED: "${NEW_GOAL.slice(0, 60)}..."`)
    if (finalValue === NEW_GOAL) {
      console.log(`[repro] PASS — SSE applied, textarea reflects NEW_GOAL`)
    } else {
      console.log(`[repro] FAIL — SSE did NOT apply, textarea still shows old value`)
    }

    // Screenshot
    const ssDir = process.env.E2E_ARTIFACTS_DIR
      ? `${process.env.E2E_ARTIFACTS_DIR}/e2e-screenshots/task-domain`
      : "."
    await page.screenshot({ path: `${ssDir}/repro-ac2-console.png`, fullPage: true })
    console.log(`[repro] screenshot: ${ssDir}/repro-ac2-console.png`)

    await browser.close()
  } finally {
    // Cleanup
    try {
      await fetch(`${SERVER}/api/tasks/${task.id}/abort`, { method: "POST" })
    } catch {}
    try {
      await fetch(`${SERVER}/api/tasks/${task.id}`, { method: "DELETE" })
    } catch {}
    console.log(`[repro] cleaned up task ${task.id}`)
  }
}

main().catch((e) => {
  console.error("[repro] ERROR:", e.message)
  process.exit(1)
})
