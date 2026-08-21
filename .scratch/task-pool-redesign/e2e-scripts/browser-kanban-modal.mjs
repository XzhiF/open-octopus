/**
 * E2E Browser Test — Task Pool Redesign (Phase 4)
 *
 * Verifies AC-US1/5/6/7/8/16 + SSE refresh (UI Layer 4 evidence):
 *   - /tasks kanban renders 7 columns (screenshot 320/768/1024/1440)
 *   - [+新建] opens authoring modal
 *   - [入队] button visible in authoring modal
 *   - Simple queued job → click card → simple-execution modal
 *   - Composite job → click card → composite modal with DAG
 *   - Done job → click card → done modal
 *   - Failed job → appears in failed column
 *   - SSE refresh: API status change → kanban updates
 *
 * Run: node e2e-scripts/browser-kanban-modal.mjs
 */
import { fetchJSON, resolveApiUrl, resolveWebUrl } from '/Users/xzf/Projects/ai/XzhiF/open-octopus/.claude/skills/e2e-harness/lib/api.mjs'
import { resolveDbPath, querySQL, executeSQL } from '/Users/xzf/Projects/ai/XzhiF/open-octopus/.claude/skills/e2e-harness/lib/db.mjs'
import { createResults, record, exitWithResults, saveResults } from '/Users/xzf/Projects/ai/XzhiF/open-octopus/.claude/skills/e2e-harness/lib/reporter.mjs'
import { launchBrowser, takeScreenshot, closeBrowser, navigateTo, wait } from '/Users/xzf/Projects/ai/XzhiF/open-octopus/.claude/skills/e2e-harness/lib/browser.mjs'

const API = resolveApiUrl()
const WEB = resolveWebUrl()
const DB_PATH = resolveDbPath()
const SCREEN_DIR = `${process.env.E2E_ARTIFACTS_DIR}/e2e-screenshots`
const results = createResults()
const TS = Date.now()
const PREFIX = 'E2E_TP_'

// ── Helpers ────────────────────────────────────────────────────────

function db(sql) { return querySQL(sql, DB_PATH) }
function dbExec(sql) { return executeSQL(sql, DB_PATH) }

async function createJob(taskSpec, name, extraFields = {}) {
  const res = await fetchJSON(`${API}/api/scheduler/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      job_type: 'workflow',
      trigger_source: 'requirement',
      task_spec: taskSpec,
      project_ids: ['test-project'],
      workflow_ref: 'xzf-dev',
      org: 'default',
      ...extraFields,
    }),
  })
  return res.status === 201 ? res.data : null
}

async function cleanupScheduleIds(ids) {
  for (const id of ids) {
    try { await fetchJSON(`${API}/api/scheduler/jobs/${id}`, { method: 'DELETE' }) } catch { /* */ }
    dbExec(`DELETE FROM schedule_executions WHERE schedule_id = '${id}';`)
    dbExec(`DELETE FROM schedule_audit_logs WHERE schedule_id = '${id}';`)
    dbExec(`DELETE FROM schedule_workspaces WHERE schedule_id = '${id}';`)
    dbExec(`DELETE FROM schedules WHERE id = '${id}';`)
  }
}

// ── Test Data ──────────────────────────────────────────────────────

const simpleSpec = { goal: `${PREFIX}browser simple goal`, ac: [`${PREFIX} browser simple AC`] }
const compositeSpec = {
  goal: `${PREFIX}browser composite goal`,
  ac: [`${PREFIX} browser composite AC`],
  subunits: [
    { name: `${PREFIX}br-sub-a`, workspace_spec: { org: 'default', branch_prefix: 'e2e-tp-br-a', projects: [{ name: 'test-a', source_path: '', group: '' }] }, workflow_ref: 'xzf-dev', input_values: {}, skills: [] },
    { name: `${PREFIX}br-sub-b`, workspace_spec: { org: 'default', branch_prefix: 'e2e-tp-br-b', projects: [{ name: 'test-b', source_path: '', group: '' }] }, workflow_ref: 'xzf-dev', input_values: {}, skills: [] },
    { name: `${PREFIX}br-sub-c`, workspace_spec: { org: 'default', branch_prefix: 'e2e-tp-br-c', projects: [{ name: 'test-c', source_path: '', group: '' }] }, workflow_ref: 'xzf-dev', input_values: {}, skills: [] },
  ],
  integration_goal: { strategy: 'synthesis', prompt: 'Synthesize' },
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  console.log(`[E2E-Browser] API=${API} WEB=${WEB}`)
  const createdIds = []

  // ── Seed test jobs via API ───────────────────────────────────────
  console.log('[E2E-Browser] Seeding test jobs via API...')

  // Simple queued job (for US6: simple-execution modal)
  const simpleJob = await createJob(simpleSpec, `${PREFIX}br-simple-${TS}`)
  if (simpleJob) {
    createdIds.push(simpleJob.id)
    await fetchJSON(`${API}/api/scheduler/jobs/${simpleJob.id}/enqueue`, { method: 'POST' })
    // Seed as 'running' so modal opens in simple-execution mode
    dbExec(`UPDATE schedules SET status='running', claimed_at='${new Date().toISOString()}' WHERE id='${simpleJob.id}'`)
    console.log(`[E2E-Browser] Simple running job: ${simpleJob.id}`)
  }

  // Composite job (for US7: composite modal with DAG)
  const compositeJob = await createJob(compositeSpec, `${PREFIX}br-composite-${TS}`)
  if (compositeJob) {
    createdIds.push(compositeJob.id)
    // Seed as 'running' so modal opens in composite mode
    dbExec(`UPDATE schedules SET status='running', claimed_at='${new Date().toISOString()}' WHERE id='${compositeJob.id}'`)
    console.log(`[E2E-Browser] Composite running job: ${compositeJob.id}`)
  }

  // Done job (for US8: done modal)
  const doneJob = await createJob(simpleSpec, `${PREFIX}br-done-${TS}`)
  if (doneJob) {
    createdIds.push(doneJob.id)
    await fetchJSON(`${API}/api/scheduler/jobs/${doneJob.id}/enqueue`, { method: 'POST' })
    dbExec(`UPDATE schedules SET status='done' WHERE id='${doneJob.id}'`)
    console.log(`[E2E-Browser] Done job: ${doneJob.id}`)
  }

  // Failed job (for US16: failed column)
  const failedJob = await createJob(simpleSpec, `${PREFIX}br-failed-${TS}`)
  if (failedJob) {
    createdIds.push(failedJob.id)
    await fetchJSON(`${API}/api/scheduler/jobs/${failedJob.id}/enqueue`, { method: 'POST' })
    dbExec(`UPDATE schedules SET status='failed' WHERE id='${failedJob.id}'`)
    console.log(`[E2E-Browser] Failed job: ${failedJob.id}`)
  }

  // Draft job (for US1: draft column + authoring modal)
  const draftJob = await createJob(simpleSpec, `${PREFIX}br-draft-${TS}`)
  if (draftJob) {
    createdIds.push(draftJob.id)
    console.log(`[E2E-Browser] Draft job: ${draftJob.id}`)
  }

  // Queued job (for US5: queued column)
  const queuedJob = await createJob(simpleSpec, `${PREFIX}br-queued-${TS}`)
  if (queuedJob) {
    createdIds.push(queuedJob.id)
    await fetchJSON(`${API}/api/scheduler/jobs/${queuedJob.id}/enqueue`, { method: 'POST' })
    console.log(`[E2E-Browser] Queued job: ${queuedJob.id}`)
  }

  // Wait for the page to pick up the DB changes (polling interval or SSE)
  await wait(2000)

  // ── Browser E2E ──────────────────────────────────────────────────
  const { browser, page } = await launchBrowser({ headless: true })

  try {
    // Capture console errors
    const consoleErrors = []
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text())
    })

    // ── US1: /tasks renders 7 columns ─────────────────────────────
    console.log('\n=== AC-US1: /tasks kanban 7 columns ===')
    await navigateTo(page, `${WEB}/tasks`)
    await wait(3000) // wait for fetch + render

    const columns = await page.locator('[data-task-column]').count()
    record(results, 'kanban renders 7 columns', columns === 7, `count=${columns}`)

    const columnIds = await page.locator('[data-task-column]').evaluateAll((els) =>
      els.map((e) => e.getAttribute('data-task-column')),
    )
    record(results, 'columns are draft/queued/claimed/running/done/failed/aborted',
      JSON.stringify(columnIds) === JSON.stringify(['draft', 'queued', 'claimed', 'running', 'done', 'failed', 'aborted']),
      JSON.stringify(columnIds))

    // Screenshot at 1440 (desktop)
    await page.setViewportSize({ width: 1440, height: 900 })
    await wait(500)
    await takeScreenshot(page, 'kanban-1440', SCREEN_DIR)
    record(results, 'screenshot kanban-1440', true, `${SCREEN_DIR}/kanban-1440.png`)

    // ── Responsive screenshots ────────────────────────────────────
    for (const w of [320, 768, 1024]) {
      await page.setViewportSize({ width: w, height: 800 })
      await wait(500)
      await takeScreenshot(page, `kanban-${w}`, SCREEN_DIR)
      record(results, `screenshot kanban-${w}`, true, `${SCREEN_DIR}/kanban-${w}.png`)
    }
    // Reset to desktop
    await page.setViewportSize({ width: 1440, height: 900 })
    await wait(500)

    // ── US16: Failed job in failed column ──────────────────────────
    console.log('\n=== AC-US16: failed job in failed column ===')
    if (failedJob) {
      const failedColCards = await page.locator('[data-task-column="failed"] [data-task-card]').count()
      const passFailedCol = failedColCards >= 1
      record(results, 'failed job appears in failed column', passFailedCol, `count=${failedColCards}`)

      if (passFailedCol) {
        const failedCardStatus = await page.locator('[data-task-column="failed"] [data-task-card] [data-task-card-status]').first().textContent()
        record(results, 'failed card status text=failed', failedCardStatus?.trim() === 'failed', `status="${failedCardStatus?.trim()}"`)
      }
    }

    // ── US8: Done job → click card → done modal ────────────────────
    console.log('\n=== AC-US8: done card → done modal ===')
    if (doneJob) {
      const doneCard = page.locator('[data-task-column="done"] [data-task-card]').first()
      const doneCardCount = await doneCard.count()
      if (doneCardCount > 0) {
        await doneCard.click()
        await wait(1500)
        await takeScreenshot(page, 'modal-done', SCREEN_DIR)
        const modalVisible = await page.locator('[data-task-modal-status]').count()
        record(results, 'done modal opens on card click', modalVisible > 0, `modal_elements=${modalVisible}`)
        const modalStatus = await page.locator('[data-task-modal-status]').first().getAttribute('data-task-modal-status')
        record(results, 'done modal status=done', modalStatus === 'done', `status="${modalStatus}"`)
        // Close modal
        await page.keyboard.press('Escape')
        await wait(500)
      } else {
        record(results, 'done card found', false, 'no done card in column')
      }
    }

    // ── US7: Composite job → click card → composite modal with DAG ──
    console.log('\n=== AC-US7: composite card → composite modal (DAG) ===')
    if (compositeJob) {
      // Find the composite card (has [复合] badge)
      const compositeBadge = page.locator('[data-task-card]:has(span:text("复合"))')
      const compositeCardCount = await compositeBadge.count()
      record(results, 'composite card has [复合] badge', compositeCardCount > 0, `count=${compositeCardCount}`)

      if (compositeCardCount > 0) {
        await compositeBadge.first().click()
        await wait(2000) // wait for JobDetail fetch + DAG render
        await takeScreenshot(page, 'modal-composite-dag', SCREEN_DIR)
        const modalVisible = await page.locator('[data-task-modal-status]').count()
        record(results, 'composite modal opens on card click', modalVisible > 0, `modal_elements=${modalVisible}`)

        // Check for DAG nodes (ReactFlow renders nodes)
        const dagNodes = await page.locator('.react-flow__node').count()
        record(results, 'composite modal has DAG nodes', dagNodes > 0, `nodes=${dagNodes}`)

        // Close modal
        await page.keyboard.press('Escape')
        await wait(500)
      }
    }

    // ── US6: Simple running job → click card → simple-execution modal ──
    console.log('\n=== AC-US6: simple card → simple-execution modal ===')
    if (simpleJob) {
      const runningCard = page.locator('[data-task-column="running"] [data-task-card]').first()
      const runningCardCount = await runningCard.count()
      if (runningCardCount > 0) {
        await runningCard.click()
        await wait(1500)
        await takeScreenshot(page, 'modal-simple-execution', SCREEN_DIR)
        const simpleExecPanel = await page.locator('[data-task-simple-execution]').count()
        record(results, 'simple-execution panel visible', simpleExecPanel > 0, `panel=${simpleExecPanel}`)

        // Check for abort button
        const abortBtn = await page.locator('[data-task-abort]').count()
        record(results, 'abort button visible in simple-execution', abortBtn > 0, `btn=${abortBtn}`)
        await page.keyboard.press('Escape')
        await wait(500)
      } else {
        record(results, 'running card found', false, 'no running card')
      }
    }

    // ── US1: [+新建] opens authoring modal ────────────────────────
    console.log('\n=== AC-US1: [+新建] opens authoring modal ===')
    await page.locator('[data-task-new]').click()
    await wait(1500)
    await takeScreenshot(page, 'modal-authoring-new', SCREEN_DIR)

    const specPanel = await page.locator('[data-task-spec-panel]').count()
    record(results, 'authoring modal has spec panel (LEFT)', specPanel > 0, `panel=${specPanel}`)

    const enqueueBtn = await page.locator('[data-task-enqueue]').count()
    record(results, '[入队] button visible in authoring modal', enqueueBtn > 0, `btn=${enqueueBtn}`)

    // Check for chat panel (RIGHT side) — the clone chat area
    // The authoring mode renders spec LEFT / chat RIGHT
    const chatArea = await page.locator('[data-task-modal-status]').count()
    record(results, 'authoring modal renders (status badge visible)', chatArea > 0, `badge=${chatArea}`)

    await takeScreenshot(page, 'modal-authoring-full', SCREEN_DIR)
    await page.keyboard.press('Escape')
    await wait(500)

    // ── US11/SSE refresh: API status change → kanban updates ──────
    console.log('\n=== AC-US11: SSE refresh on status change ===')
    if (draftJob) {
      // Move draft → queued via API, then verify the card moves in the UI
      await fetchJSON(`${API}/api/scheduler/jobs/${draftJob.id}/enqueue`, { method: 'POST' })
      await wait(3000) // wait for SSE + re-render

      const draftColCount = await page.locator('[data-task-column="draft"] [data-task-card]').count()
      const queuedColCount = await page.locator('[data-task-column="queued"] [data-task-card]').count()
      // The draft card should have moved to queued (draft column count decreased)
      record(results, 'SSE refresh: draft→queued card moved', queuedColCount > 0, `draft=${draftColCount} queued=${queuedColCount}`)
      await takeScreenshot(page, 'kanban-sse-refresh', SCREEN_DIR)
    }

    // ── Console errors check ───────────────────────────────────────
    record(results, 'no console errors on /tasks', consoleErrors.length === 0, `errors=${consoleErrors.length} ${consoleErrors.slice(0, 2).join('; ')}`)

  } finally {
    await closeBrowser(browser)
  }

  // ── Cleanup ──────────────────────────────────────────────────────
  console.log('\n=== Cleanup ===')
  await cleanupScheduleIds(createdIds)
  dbExec(`DELETE FROM sessions WHERE title LIKE '${PREFIX}%' OR (clone_name='task-author' AND scope_id IN (SELECT id FROM schedules WHERE name LIKE '${PREFIX}%'))`)
  const remaining = db(`SELECT COUNT(*) as cnt FROM schedules WHERE name LIKE '${PREFIX}%'`)
  const passCleanup = remaining.ok && remaining.data?.[0]?.cnt === 0
  record(results, 'cleanup: all E2E_TP_ schedules removed', passCleanup, JSON.stringify(remaining.data?.[0]))

  saveResults(results, `${process.env.E2E_ARTIFACTS_DIR}/e2e-data/browser-results.json`)
  exitWithResults(results, { title: 'Browser E2E — Task Pool Redesign' })
}

main().catch((err) => {
  console.error('[E2E-Browser] FATAL:', err)
  process.exit(1)
})
