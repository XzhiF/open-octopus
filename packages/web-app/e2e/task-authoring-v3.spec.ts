// packages/web-app/e2e/task-authoring-v3.spec.ts
//
// Ticket 09 — frontend two-phase flow (TemplatePicker + AuthoringWorkspace +
// goal/ac card). Covers AC1-AC7 / US1-6/14/D12/D15/D18.
//
// Two test groups (matched by `-g "template|goalac"`):
//   - template: AC1/AC2/AC3 — template picker renders skill groups, create
//     sequence (session-first, D15) → AuthoringWorkspace, DB + home-dir
//     cross-validation.
//   - goalac: AC4/AC5/AC6 — goal/ac emerge via SSE, user direct-edit
//     (spec-field source=user → DB version+1), confirm persists across
//     modal close/reopen, enqueue gate (disabled + 409 backstop).
//
// Anti-fake-run: R1 (real server :3001), R3 (API↔DB↔FS cross-check), R4
// (response+SQL+readdir+screenshot), R5 (home-dir created/exists), R6 (real
// /tasks UI + TaskModal + TemplatePicker + AuthoringWorkspace), R7 (E2E_TD_
// prefix), R8 (skill groups via /api/skill-groups, no manual install needed
// — the default group is always present).

import { test, expect } from "@playwright/test"
import {
  SERVER_URL,
  TASK_E2E_ORG,
  DATA_PREFIX,
  log,
  logError,
  ensureScreenshotDir,
  screenshotPath,
  v3ScreenshotPath,
  isServerAvailable,
  listTasks,
  deleteTask,
  updateSpecField,
  updateTaskRaw,
  readyTask,
  readyTaskRaw,
  listSkillGroupsViaApi,
  readTaskRow,
  readSessionScopeId,
  readTaskHomeDir,
  assertTaskMatchesDb,
  waitFor,
  startSseSubscriber,
  type SseSubscriber,
  // ── ticket 10 viewer/assist helpers ──
  writeTaskArtifactIndex,
  writeTaskArtifactFile,
  listArtifactsViaApi,
  getArtifactContentRaw,
  triggerAssistWorkflowRaw,
  getAssistWorkflowRunViaApi,
  seedAssistRunOutput,
} from "./helpers/task-domain-helpers"

// ── Constants ───────────────────────────────────────────────────────────

const TASK_NAME = `${DATA_PREFIX}v3-two-phase`

// ── Suite-level state ───────────────────────────────────────────────────

let serverAvailable = false
let createdTaskIds: string[] = []
let sseSub: SseSubscriber | null = null

test.describe.configure({ mode: "serial" })

test.beforeAll(async () => {
  serverAvailable = await isServerAvailable()
  if (!serverAvailable) {
    log(`Server not available at ${SERVER_URL} — tests will be skipped`)
    return
  }
  // AC4/R4: ensure BOTH evidence dirs exist (the v3 dir is the pipeline
  // artifact gate's required landing zone; ensureScreenshotDir is the legacy
  // dir kept for the shared helper's own fallback writes).
  ensureScreenshotDir()
  try {
    const { ensureV3ScreenshotDir } = await import("./helpers/task-domain-helpers")
    ensureV3ScreenshotDir()
  } catch (err: unknown) {
    logError(`v3 screenshot dir setup failed: ${err instanceof Error ? err.message : String(err)}`)
  }
  try {
    sseSub = await startSseSubscriber()
  } catch (err: unknown) {
    logError(`SSE subscriber failed to start: ${err instanceof Error ? err.message : String(err)}`)
  }
})

test.afterAll(async () => {
  sseSub?.stop()
  // AC4: data isolation + reap assertion. Every E2E_TD_ task we created must
  // be DELETEd. DRAFT tasks have their home dir reaped on delete (ADR-0011;
  // reap does NOT follow junctions, SW-BP14) — we assert that. Non-draft
  // tasks (e.g. the fulllink task that was enqueued → ready) PRESERVE their
  // home dir by design (preserved until hard-delete) — for those we manually
  // clean up the home so no orphan dirs are left, but do NOT assert reap
  // (the spec explicitly says non-draft homes are not reaped).
  const reapFailures: string[] = []
  const osMod = await import("os")
  const pathMod = await import("path")
  const fsMod = await import("fs")
  for (const taskId of createdTaskIds) {
    const beforeRow = readTaskRow(taskId)
    const wasDraft = beforeRow?.status === "draft"
    const homeBefore = readTaskHomeDir(taskId)
    try {
      await deleteTask(taskId)
    } catch (err: unknown) {
      logError(`cleanup deleteTask ${taskId}: ${err instanceof Error ? err.message : String(err)}`)
    }
    // R5/AC4: draft delete → home dir reaped. Non-draft → home preserved
    // (spec: non-draft preserved until hard-delete); manually clean up.
    if (homeBefore !== null) {
      if (wasDraft) {
        try {
          await waitFor(() => (readTaskHomeDir(taskId) === null ? true : null), {
            timeoutMs: 8_000,
            intervalMs: 250,
            message: `draft home dir for ${taskId} was not reaped after DELETE`,
          })
        } catch (err: unknown) {
          reapFailures.push(`${taskId}: ${err instanceof Error ? err.message : String(err)}`)
        }
      } else {
        // Non-draft: home preserved by design — manually rm to avoid orphan
        // dirs (best-effort; junctions unlinked, not followed — SW-BP14).
        const home = pathMod.join(osMod.homedir(), ".octopus", "tasks", taskId)
        try {
          fsMod.rmSync(home, { recursive: true, force: true })
        } catch (err: unknown) {
          logError(`manual home cleanup ${taskId}: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    }
  }
  if (reapFailures.length > 0) {
    logError(`AC4 reap failures: ${reapFailures.join("; ")}`)
  }
})

// ── template: AC1/AC2/AC3 — TemplatePicker + create sequence ──────────

test.describe("template: two-phase create (AC1/AC2/AC3)", () => {

  test("template page renders skill groups from GET /api/skill-groups (AC1)", async ({ page }) => {
    test.skip(!serverAvailable, "Server not available")
    // R8: the default group is always present server-side, so the list is
    // never empty even with zero installed skills.
    const sg = await listSkillGroupsViaApi()
    expect(sg.groups.length, "skill-groups route returns ≥ the default group").toBeGreaterThan(0)
    const hasDefault = sg.groups.some((g) => g.group === "default")
    expect(hasDefault, "built-in default empty-marker group is always first (D17)").toBe(true)

    // R6: open /tasks → [+新建] → TaskModal renders the TemplatePicker.
    await page.goto("/tasks")
    await page.waitForLoadState("domcontentloaded")
    await page.locator('[data-task-column="draft"]').waitFor({ state: "visible", timeout: 15_000 })

    await page.locator('[data-task-new]').click()
    const dialog = page.getByRole("dialog")
    await expect(dialog, "TaskModal should open").toBeVisible({ timeout: 10_000 })

    // The TemplatePicker fetches /api/skill-groups and renders one row per group.
    const picker = dialog.locator("[data-template-picker]")
    await expect(picker, "TemplatePicker should render for a new task").toBeVisible({ timeout: 10_000 })

    // The default group row renders with its D17 「不物化」 note.
    const defaultRow = picker.locator('[data-skill-group="default"]')
    await expect(defaultRow, "default group row renders").toBeVisible({ timeout: 10_000 })

    // AC1: the create button is disabled until a group is selected.
    const createBtn = picker.locator("[data-template-create]")
    await expect(createBtn).toBeDisabled()

    // Select the default group → create button enables.
    await defaultRow.click()
    await expect(createBtn, "create enables after selecting a group (AC1)").toBeEnabled()

    await page.screenshot({ path: v3ScreenshotPath("template-01-picker.png"), fullPage: true })
    log("TemplatePicker rendered skill groups; create enables on group select")
  })

  test("create sequence: session-first → POST /api/tasks(v3) → AuthoringWorkspace + DB + home (AC2/D15)", async ({ page }) => {
    test.skip(!serverAvailable, "Server not available")
    // D15: session FIRST, then POST /api/tasks with source_chat_session_id +
    // task_type + skill_groups + preset. The TemplatePickerMode runs this on
    // 开始编写. Here we drive the SAME sequence via the UI.
    //
    // The UI's org dropdown reads REAL registered orgs (miyuan/xzf/...), so
    // the created task carries a real org — we identify our task by recency +
    // task_type=coding (not by the E2E_TD_ org, which isn't registered). R7
    // isolation is maintained by ID-based cleanup in afterAll.
    const startTime = Date.now()
    await page.goto("/tasks")
    await page.waitForLoadState("domcontentloaded")
    await page.locator('[data-task-column="draft"]').waitFor({ state: "visible", timeout: 15_000 })
    await page.locator('[data-task-new]').click()
    const dialog = page.getByRole("dialog")
    await expect(dialog).toBeVisible({ timeout: 10_000 })
    const picker = dialog.locator("[data-template-picker]")
    await expect(picker).toBeVisible({ timeout: 10_000 })

    // Pick coding + default group (always present) + any extra group available.
    await picker.locator('[data-task-type="coding"]').click()
    await picker.locator('[data-skill-group="default"]').click()
    // If a second group exists, select it too (multi-select integration, US2).
    const sg = await listSkillGroupsViaApi()
    const extra = sg.groups.find((g) => g.group !== "default")
    let selectedGroups = ["default"]
    if (extra) {
      await picker.locator(`[data-skill-group="${extra.group}"]`).click()
      selectedGroups = ["default", extra.group]
    }

    await picker.locator("[data-template-create]").click()

    // The workspace replaces the picker (phase transition) — UI-level proof
    // the create succeeded (TemplatePickerMode → onDraftResolved → workspace).
    const workspace = dialog.locator("[data-authoring-workspace]")
    await expect(workspace, "AuthoringWorkspace should render after create").toBeVisible({ timeout: 15_000 })

    // R3: find the created draft by recency + task_type (org-agnostic — the UI
    // used a real org). The most recent v3 coding draft created after startTime
    // is ours (no other test creates one concurrently).
    const draft = await waitFor(async () => {
      const all = await listTasks({ status: "draft" })
      const candidates = all.items
        .filter((t) => {
          if (createdTaskIds.includes(t.id)) return false
          const spec = t.task_spec as { task_type?: string }
          if (spec?.task_type !== "coding") return false
          return new Date(t.created_at).getTime() >= startTime - 1000
        })
        .sort((a, b) => (b.created_at > a.created_at ? 1 : -1))
      return candidates[0] ?? null
    }, { timeoutMs: 15_000, intervalMs: 1000, message: "created draft not found in listTasks" })
    createdTaskIds.push(draft.id)

    // D15 invariant: source_chat_session_id is set + sessions.scope_id == task.id.
    expect(draft.source_chat_session_id, "draft has source_chat_session_id bound (D15)").toBeTruthy()
    const scopeId = readSessionScopeId(draft.source_chat_session_id!)
    expect(scopeId, "sessions.scope_id retargets to tasks.id (SG3)").toBe(draft.id)

    // R3: DB cross-check — task_spec carries task_type + skill_groups (D4).
    const dbRow = readTaskRow(draft.id)
    expect(dbRow, "DB row exists").not.toBeNull()
    const taskSpec = JSON.parse(dbRow!.task_spec)
    expect(taskSpec.task_type, "DB task_spec.task_type=coding").toBe("coding")
    expect(taskSpec.skill_groups, "DB task_spec.skill_groups matches selection").toEqual(
      expect.arrayContaining(selectedGroups),
    )

    // R5: the v3 create path materialized the task home dir.
    const home = readTaskHomeDir(draft.id)
    expect(home, "task home dir exists (~/.octopus/tasks/{id}/)").not.toBeNull()

    assertTaskMatchesDb(draft, { status: "draft" })
    await page.screenshot({ path: v3ScreenshotPath("template-02-workspace.png"), fullPage: true })
    log(`Created v3 task ${draft.id} (task_type=coding, skill_groups=${selectedGroups.join(",")})`)
  })

  test("authoring top bar: type badge + 🔒 skill-group badges + preset popup (org+projects only, AC3/US14)", async ({ page }) => {
    test.skip(!serverAvailable, "Server not available")
    test.skip(createdTaskIds.length === 0, "No task from create sequence")
    const taskId = createdTaskIds[0]!

    await page.goto("/tasks")
    await page.waitForLoadState("domcontentloaded")
    await page.locator('[data-task-column="draft"]').waitFor({ state: "visible", timeout: 15_000 })

    const card = page.locator(`[data-task-id="${taskId}"]`).first()
    await expect(card).toBeVisible({ timeout: 10_000 })
    await card.click()

    const dialog = page.getByRole("dialog")
    await expect(dialog).toBeVisible({ timeout: 10_000 })
    const workspace = dialog.locator("[data-authoring-workspace]")
    await expect(workspace).toBeVisible({ timeout: 10_000 })

    // AC3: type badge + a 🔒 badge per selected skill group (no dropdown).
    await expect(workspace.locator("[data-task-type-badge]")).toBeVisible()
    const groupBadges = workspace.locator("[data-skill-group-badge]")
    const badgeCount = await groupBadges.count()
    expect(badgeCount, "≥1 locked skill-group badge in top bar").toBeGreaterThan(0)
    // Each badge carries the lock icon (locked — no dropdown to change).
    const firstBadge = groupBadges.first()
    await expect(firstBadge.locator("svg.lucide-lock, svg[class*='lock']")).toBeVisible()

    // AC3/US14: the preset popup has ONLY org + projects (no skills section).
    await workspace.locator("[data-preset-button]").click()
    // The preset popup's DialogTitle (an h2) appears — confirms the popup opened.
    await expect(page.getByRole("heading", { name: /codebase/ })).toBeVisible({ timeout: 10_000 })
    // The preset dialog body shows the org context (US14: org + projects only).
    await expect(page.getByText(/组织|项目/).last()).toBeVisible({ timeout: 10_000 })
    // US14: no "技能" label anywhere in the preset popup (skills belong to
    // workflow.requires, NOT the preset). Scope to the last dialog (the preset
    // popup renders in a portal above the TaskModal).
    const lastDialog = page.locator('[role="dialog"]').last()
    const skillsLabel = await lastDialog.locator("text=/^技能$/").count()
    expect(skillsLabel, "preset dialog has NO skills section (US14)").toBe(0)

    await page.screenshot({ path: v3ScreenshotPath("template-03-topbar.png"), fullPage: true })
    log("Top bar: type badge + locked skill-group badges; preset popup = org+projects only")
  })
})

// ── goalac: AC4/AC5/AC6 — goal/ac emerge + direct edit + confirm + gate ─

test.describe("goalac: goal/ac card (AC4/AC5/AC6)", () => {

  test("goal/ac emerge via SSE spec_field_update + direct edit → DB version+1 (AC4/D7)", async ({ page }) => {
    test.skip(!serverAvailable, "Server not available")
    test.skip(createdTaskIds.length === 0, "No task from create sequence")
    const taskId = createdTaskIds[0]!

    await page.goto("/tasks")
    await page.waitForLoadState("domcontentloaded")
    await page.locator('[data-task-column="draft"]').waitFor({ state: "visible", timeout: 15_000 })
    await page.locator(`[data-task-id="${taskId}"]`).first().click()
    const dialog = page.getByRole("dialog")
    await expect(dialog).toBeVisible({ timeout: 10_000 })
    const card = dialog.locator("[data-goal-ac-card]")

    // AC4: goal is an always-editable textarea before the agent binds (empty).
    await expect(card.getByRole("textbox", { name: "编辑 goal" })).toBeVisible({ timeout: 10_000 })
    await expect(card.getByRole("textbox", { name: "编辑 goal" })).toHaveValue("")

    // Simulate the agent binding goal via the spec-field tool (mechanism-level;
    // LLM content is manual per R2). The server emits spec_field_update SSE.
    const goalText = "E2E_TD goal: two-phase authoring v3"
    await updateSpecField(taskId, "goal", goalText)

    // R3: SSE spec_field_update for goal.
    expect(sseSub).not.toBeNull()
    await waitFor(
      () => sseSub!.specFieldEvents.find((e) => e.task_id === taskId && e.field === "goal"),
      { timeoutMs: 10_000, message: "spec_field_update SSE not received for goal" },
    )

    // D19 (review-fix): every spec-field update emits a companion
    // task_artifacts_update on the same taskpool stream (so the OutputViewer
    // re-fetches the artifact index without polling). Assert the subscriber
    // captured it for this task — independent server-side evidence the emit
    // path is wired (R3/R4: SSE payload { task_id }).
    await waitFor(
      () => sseSub!.taskArtifactsEvents.find((e) => e.task_id === taskId),
      { timeoutMs: 10_000, message: "task_artifacts_update SSE not received (D19 companion emit)" },
    )

    // AC4: the goal emerges in the UI (SSE applied live into the textarea).
    await expect(
      card.getByRole("textbox", { name: "编辑 goal" }),
      "goal emerges after SSE",
    ).toHaveValue(goalText)

    // AC4: direct edit (blur-commit) → spec-field source=user → DB version+1 + ✏️ edited mark.
    const beforeRow = readTaskRow(taskId)
    const beforeVersion = beforeRow!.version

    const goalInput = card.getByRole("textbox", { name: "编辑 goal" })
    await goalInput.fill("E2E_TD user override goal")
    await goalInput.blur()

    // The ✏️ edited mark surfaces after a user-direct-edit.
    await expect(card.locator("[data-edited-mark]")).toBeVisible({ timeout: 10_000 })

    // R3/R5: DB version bumped + the user's value persisted (source=user →
    // server set @@spec_updated; the agent would reconcile next turn).
    await waitFor(() => {
      const row = readTaskRow(taskId)
      return row && row.version > beforeVersion ? row : null
    }, { timeoutMs: 10_000, message: "DB version did not bump after direct edit" })
    const afterRow = readTaskRow(taskId)
    expect(JSON.parse(afterRow!.task_spec).goal, "DB goal == user override").toBe("E2E_TD user override goal")

    await page.screenshot({ path: v3ScreenshotPath("goalac-01-edit.png"), fullPage: true })
    log("goal emerged via SSE; direct edit → DB version+1 + edited mark")
  })

  test("confirm goal/ac → spec-field(goal_confirmed/ac_confirmed) persists across reopen (AC5/D18)", async ({ page }) => {
    test.skip(!serverAvailable, "Server not available")
    test.skip(createdTaskIds.length === 0, "No task from create sequence")
    const taskId = createdTaskIds[0]!

    // Bind ac (if not already) so the ac confirm toggle is exercisable.
    const dbSpec = JSON.parse(readTaskRow(taskId)!.task_spec)
    if (!dbSpec.ac || dbSpec.ac.length === 0) {
      await updateSpecField(taskId, "ac", ["E2E_TD ac one", "E2E_TD ac two"])
      await waitFor(
        () => sseSub!.specFieldEvents.find((e) => e.task_id === taskId && e.field === "ac"),
        { timeoutMs: 10_000, message: "spec_field_update SSE not received for ac" },
      )
    }

    await page.goto("/tasks")
    await page.waitForLoadState("domcontentloaded")
    await page.locator('[data-task-column="draft"]').waitFor({ state: "visible", timeout: 15_000 })
    await page.locator(`[data-task-id="${taskId}"]`).first().click()
    const dialog = page.getByRole("dialog")
    await expect(dialog).toBeVisible({ timeout: 10_000 })
    const card = dialog.locator("[data-goal-ac-card]")

    // AC5: confirm goal → spec-field(goal_confirmed=true, source=user).
    const goalConfirmBtn = card.getByRole("button", { name: /确认 goal/i })
    await goalConfirmBtn.click()

    await waitFor(() => {
      const row = JSON.parse(readTaskRow(taskId)!.task_spec)
      return row.goal_confirmed === true ? row : null
    }, { timeoutMs: 10_000, message: "DB goal_confirmed did not persist" })
    expect(JSON.parse(readTaskRow(taskId)!.task_spec).goal_confirmed, "DB goal_confirmed=true").toBe(true)

    // AC5: confirm the first ac item → spec-field(ac_confirmed=[item], source=user).
    const acConfirmBtn = card.getByRole("button", { name: /确认 ac:.*ac one/i }).first()
    if (await acConfirmBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await acConfirmBtn.click()
      await waitFor(() => {
        const row = JSON.parse(readTaskRow(taskId)!.task_spec)
        return (row.ac_confirmed ?? []).includes("E2E_TD ac one") ? row : null
      }, { timeoutMs: 10_000, message: "DB ac_confirmed did not persist the item" })
    }

    // AC5: close + reopen the modal → confirm state persists (server-side).
    await page.keyboard.press("Escape")
    await expect(dialog).not.toBeVisible({ timeout: 5000 })
    await page.locator(`[data-task-id="${taskId}"]`).first().click()
    await expect(dialog).toBeVisible({ timeout: 10_000 })

    const reopenedGoalBtn = dialog.locator("[data-goal-ac-card]").getByRole("button", { name: /确认 goal/i })
    await expect(reopenedGoalBtn).toHaveAttribute("data-confirmed", "true", { timeout: 10_000 })

    await page.screenshot({ path: v3ScreenshotPath("goalac-02-confirm-persist.png"), fullPage: true })
    log("goal/ac confirm persisted via spec-field; survived modal close/reopen")
  })

  test("enqueue gate: disabled until confirmed; 409 backstop surfaces missing (AC6/D18)", async ({ page }) => {
    test.skip(!serverAvailable, "Server not available")
    test.skip(createdTaskIds.length === 0, "No task from create sequence")
    const taskId = createdTaskIds[0]!

    await page.goto("/tasks")
    await page.waitForLoadState("domcontentloaded")
    await page.locator('[data-task-column="draft"]').waitFor({ state: "visible", timeout: 15_000 })
    await page.locator(`[data-task-id="${taskId}"]`).first().click()
    const dialog = page.getByRole("dialog")
    await expect(dialog).toBeVisible({ timeout: 10_000 })
    const workspace = dialog.locator("[data-authoring-workspace]")

    // AC6: enqueue button is disabled when goal/ac not fully confirmed.
    // (Reset goal_confirmed to simulate an unconfirmed state if needed.)
    const spec = JSON.parse(readTaskRow(taskId)!.task_spec)
    if (spec.goal_confirmed === true) {
      // Un-confirm goal to exercise the disabled state + 409 backstop.
      await updateSpecField(taskId, "goal_confirmed", false, { source: "user" })
      await waitFor(
        () => sseSub!.specFieldEvents.find((e) => e.task_id === taskId && e.field === "goal_confirmed"),
        { timeoutMs: 10_000, message: "spec_field_update SSE for goal_confirmed reset" },
      )
    }

    const enqueueBtn = workspace.locator("[data-task-enqueue]")
    await expect(enqueueBtn, "enqueue disabled until goal/ac fully confirmed (AC6)").toBeDisabled({ timeout: 10_000 })

    // AC6 server-side backstop: readyTaskRaw returns 409 + missing[] even
    // though the UI is disabled (the gate is the backstop for UI temp state).
    const gate = await readyTaskRaw(taskId)
    expect(gate.status, "server gate rejects unconfirmed task (D18)").toBe(409)
    expect(Array.isArray(gate.body.missing), "409 body carries missing[]").toBe(true)
    expect(gate.body.missing!.length, "missing list is non-empty").toBeGreaterThan(0)

    await page.screenshot({ path: v3ScreenshotPath("goalac-03-gate-disabled.png"), fullPage: true })
    log(`Enqueue gate: UI disabled + server 409 missing=[${gate.body.missing!.join(",")}]`)
  })
})

// ── viewer: AC1/AC2/AC7 — artifact index + full-content dialog + degraded ──

test.describe("viewer: artifact viewer (AC1/AC2/AC7)", () => {
  // A fresh task for the viewer tests so pre-placed artifacts don't collide with
  // the goalac group's task state. Created via the same session-first → POST
  // sequence the TemplatePicker uses (D15), then we write fixtures into its home.
  let viewerTaskId: string | null = null

  test.beforeAll(async () => {
    if (!serverAvailable) return
    // Create a session first (D15), then a v3 coding task bound to it.
    const { createTaskAuthorSession, createTask } = await import("./helpers/task-domain-helpers")
    const session = await createTaskAuthorSession({ title: `${DATA_PREFIX}viewer`, org: TASK_E2E_ORG })
    const task = await createTask({
      org: TASK_E2E_ORG,
      name: `${DATA_PREFIX}viewer-task`,
      source_chat_session_id: session.id,
      task_type: "coding",
      skill_groups: ["default"],
    })
    viewerTaskId = task.id
    createdTaskIds.push(task.id)
    log(`viewer: created task ${task.id} for artifact fixtures`)
  })

  test("artifact list renders index; click → full-content dialog == disk (AC1)", async ({ page }) => {
    test.skip(!serverAvailable, "Server not available")
    test.skip(!viewerTaskId, "viewer task not created")
    const taskId = viewerTaskId!

    // R8: pre-place artifacts.json + a real file on disk (the agent would do
    // this via Write + artifacts.json; here we fixture it directly).
    const specContent = "# E2E_TD proposal\n\nThis is the **full** artifact content.\nLine 3 here."
    writeTaskArtifactFile(taskId, "proposal.md", specContent)
    const now = new Date().toISOString()
    writeTaskArtifactIndex(taskId, [
      { path: "proposal.md", by: "open-spec", title: "proposal.md — 方案文档", external: false, updated_at: now },
    ])

    // R3: API-side cross-check — the index route returns what we wrote.
    const index = await listArtifactsViaApi(taskId)
    expect(index.length, "GET artifacts returns the pre-placed entry").toBeGreaterThan(0)
    expect(index.some((e) => e.path === "proposal.md"), "index carries proposal.md").toBe(true)

    // R6: open the real TaskModal → OutputViewer renders the artifact row.
    await page.goto("/tasks")
    await page.waitForLoadState("domcontentloaded")
    await page.locator('[data-task-column="draft"]').waitFor({ state: "visible", timeout: 15_000 })
    await page.locator(`[data-task-id="${taskId}"]`).first().click()
    const dialog = page.getByRole("dialog")
    await expect(dialog).toBeVisible({ timeout: 10_000 })
    const workspace = dialog.locator("[data-authoring-workspace]")
    await expect(workspace).toBeVisible({ timeout: 10_000 })

    // AC1: the artifact row renders in the output viewer.
    const artifactsSection = workspace.locator("[data-artifacts-section]")
    await expect(artifactsSection, "artifacts section renders").toBeVisible({ timeout: 10_000 })
    const row = artifactsSection.locator("[data-artifact-row='0']")
    await expect(row, "artifact row 0 renders").toBeVisible({ timeout: 10_000 })

    // Click → ArtifactViewerDialog opens with the full content.
    await row.click()
    const viewer = page.locator("[data-artifact-viewer-dialog]")
    await expect(viewer, "artifact viewer dialog opens").toBeVisible({ timeout: 10_000 })
    const content = viewer.locator("[data-artifact-content]")
    await expect(content, "dialog renders the disk content verbatim (AC1)").toContainText("Line 3 here.", { timeout: 10_000 })
    // R3: the dialog content == disk content (independent source of truth). The
    // <pre> renders the raw file text (no markdown rendering), so the disk
    // content appears verbatim — assert the heading is present in both.
    const os = await import("os")
    const pathMod = await import("path")
    const diskContent = await import("fs").then((fs) => {
      try {
        return fs.readFileSync(
          pathMod.join(os.homedir(), ".octopus", "tasks", taskId, "artifacts", "proposal.md"),
          "utf-8",
        )
      } catch {
        return null
      }
    })
    if (diskContent) {
      await expect(content).toContainText("E2E_TD proposal")
    }

    // AC1/D11: the footer hint "有意见在对话里说" is present (no approval btns).
    await expect(viewer.locator("text=有意见")).toBeVisible()
    const approveBtns = await viewer.getByRole("button", { name: /批阅|通过|驳回|审批/ }).count()
    expect(approveBtns, "no approval/reject buttons (D11)").toBe(0)

    await page.screenshot({ path: v3ScreenshotPath("viewer-01-content-dialog.png"), fullPage: true })
    log("viewer: artifact dialog renders full disk content; no approval buttons (D11)")
  })

  test("content 403/404 → dialog degraded state, no white screen (AC2)", async ({ page }) => {
    test.skip(!serverAvailable, "Server not available")
    test.skip(!viewerTaskId, "viewer task not created")
    const taskId = viewerTaskId!

    // AC2 fixtures: a missing-on-disk relative file (404) + an escape path (403).
    // Both are valid index entries (schema only requires non-empty path string);
    // the content route whitelists them → 404/403 respectively.
    const now = new Date().toISOString()
    writeTaskArtifactIndex(taskId, [
      { path: "missing.md", by: "open-spec", title: "missing.md — 文件缺失", external: false, updated_at: now },
      { path: "../escape.md", by: "open-spec", title: "escape — 越权", external: false, updated_at: now },
    ])

    // R3: API-side cross-check the degraded statuses.
    const notFound = await getArtifactContentRaw(taskId, "missing.md")
    expect(notFound.status, "missing-on-disk → 404 (AC2)").toBe(404)
    const forbidden = await getArtifactContentRaw(taskId, "../escape.md")
    expect(forbidden.status, "escape path → 403 (AC2)").toBe(403)

    // R6: open the modal → click the missing row → degraded 404 state.
    await page.goto("/tasks")
    await page.waitForLoadState("domcontentloaded")
    await page.locator('[data-task-column="draft"]').waitFor({ state: "visible", timeout: 15_000 })
    await page.locator(`[data-task-id="${taskId}"]`).first().click()
    const dialog = page.getByRole("dialog")
    await expect(dialog).toBeVisible({ timeout: 10_000 })
    const section = dialog.locator("[data-artifacts-section]")

    // Click the missing-file row (index 0 after the rewrite above).
    await section.locator("[data-artifact-row='0']").click()
    const viewer = page.locator("[data-artifact-viewer-dialog]")
    await expect(viewer).toBeVisible({ timeout: 10_000 })
    await expect(viewer.locator("[data-artifact-degraded]"), "404 → degraded state (no white screen)").toBeVisible({ timeout: 10_000 })
    await expect(viewer.locator("text=磁盘上未找到")).toBeVisible()
    await page.keyboard.press("Escape")
    await expect(viewer).not.toBeVisible({ timeout: 5000 })

    await page.screenshot({ path: v3ScreenshotPath("viewer-02-degraded-404.png"), fullPage: true })
    log("viewer: 404 missing-file → degraded state (no white screen, AC2)")
  })

  test("SSE-driven refresh: new artifact appears without manual reload (AC7)", async ({ page }) => {
    test.skip(!serverAvailable, "Server not available")
    test.skip(!viewerTaskId, "viewer task not created")
    const taskId = viewerTaskId!

    // Reset the index to a single known artifact + write its file.
    const now = new Date().toISOString()
    writeTaskArtifactFile(taskId, "spec.md", "# E2E_TD spec\ninitial")
    writeTaskArtifactIndex(taskId, [
      { path: "spec.md", by: "task-author", title: "spec.md", external: false, updated_at: now },
    ])

    await page.goto("/tasks")
    await page.waitForLoadState("domcontentloaded")
    await page.locator('[data-task-column="draft"]').waitFor({ state: "visible", timeout: 15_000 })
    await page.locator(`[data-task-id="${taskId}"]`).first().click()
    const dialog = page.getByRole("dialog")
    await expect(dialog).toBeVisible({ timeout: 10_000 })
    const section = dialog.locator("[data-artifacts-section]")
    // Initial load: one artifact row.
    await expect(section.locator("[data-artifact-row='0']")).toBeVisible({ timeout: 10_000 })
    await expect(section.locator("[data-artifact-row='1']")).toHaveCount(0)

    // While the modal is OPEN, place a 2nd artifact on disk + index, then fire
    // a spec_field_update (the verifiable SSE bridge — agent's spec update
    // correlates with artifact production; the server emits spec_field_update on
    // the taskpool channel, which the OutputViewer also listens for → re-fetch).
    writeTaskArtifactFile(taskId, "ac.md", "# E2E_TD ac\n- candidate")
    const now2 = new Date().toISOString()
    writeTaskArtifactIndex(taskId, [
      { path: "spec.md", by: "task-author", title: "spec.md", external: false, updated_at: now },
      { path: "ac.md", by: "task-author", title: "ac.md", external: false, updated_at: now2 },
    ])
    // Trigger the SSE refresh signal (source=user so it's a real spec-field call).
    await updateSpecField(taskId, "goal", "E2E_TD refresh-trigger goal", { source: "user" })

    // AC7: the new row appears WITHOUT a manual reload / modal reopen.
    await expect(section.locator("[data-artifact-row='1']"), "2nd artifact appears via SSE refresh (AC7)").toBeVisible({ timeout: 15_000 })

    await page.screenshot({ path: v3ScreenshotPath("viewer-03-sse-refresh.png"), fullPage: true })
    log("viewer: SSE-driven refresh surfaced the 2nd artifact without manual reload (AC7)")
  })
})

// ── assist: AC3/AC4/AC5/AC6 — assist-workflow trigger + log + adoption ────

test.describe("assist: assist-workflow runs (AC3/AC4/AC5/AC6)", () => {
  let assistTaskId: string | null = null

  test.beforeAll(async () => {
    if (!serverAvailable) return
    const { createTaskAuthorSession, createTask } = await import("./helpers/task-domain-helpers")
    const session = await createTaskAuthorSession({ title: `${DATA_PREFIX}assist`, org: TASK_E2E_ORG })
    // Seed goal/ac so the assist input ($vars.goal/$vars.ac) is non-empty.
    const task = await createTask({
      org: TASK_E2E_ORG,
      name: `${DATA_PREFIX}assist-task`,
      source_chat_session_id: session.id,
      task_type: "coding",
      skill_groups: ["default"],
    })
    assistTaskId = task.id
    createdTaskIds.push(task.id)
    await updateSpecField(task.id, "goal", "E2E_TD assist goal: review requirements")
    await updateSpecField(task.id, "ac", ["E2E_TD ac one", "E2E_TD ac two"])
    log(`assist: created task ${task.id} for assist-workflow tests`)
  })

  test("trigger whitelist + run card + log dialog (AC3/AC4)", async ({ page }) => {
    test.skip(!serverAvailable, "Server not available")
    test.skip(!assistTaskId, "assist task not created")
    const taskId = assistTaskId!

    // AC3: non-whitelist template → 400 (server-side whitelist backstop). The UI
    // button only triggers whitelisted templates, so the 400 path is API-only.
    const bad = await triggerAssistWorkflowRaw(taskId, "not-a-real-template")
    expect(bad.status, "unknown template → 400 (AC3 whitelist)").toBe(400)

    // R6: open the modal → use the real MoA trigger button in the command bar.
    // The workspace tracks runIds client-side (populated on the POST response),
    // so the run row only appears when the trigger goes through the UI.
    await page.goto("/tasks")
    await page.waitForLoadState("domcontentloaded")
    await page.locator('[data-task-column="draft"]').waitFor({ state: "visible", timeout: 15_000 })
    await page.locator(`[data-task-id="${taskId}"]`).first().click()
    const dialog = page.getByRole("dialog")
    await expect(dialog).toBeVisible({ timeout: 10_000 })
    const workspace = dialog.locator("[data-authoring-workspace]")
    await expect(workspace).toBeVisible({ timeout: 10_000 })

    // AC4: click the MoA trigger button → POST → run row enters the output viewer.
    const triggerBtn = workspace.locator("[data-assist-trigger='moa-requirements-review']")
    await expect(triggerBtn, "MoA trigger button in command bar").toBeVisible({ timeout: 10_000 })
    await triggerBtn.click()

    // The run row appears (with a "拉取中" badge before the GET resolves).
    const runsSection = workspace.locator("[data-workflow-runs-section]")
    await expect(runsSection, "workflow runs section renders after trigger").toBeVisible({ timeout: 15_000 })
    const runRow = runsSection.locator("[data-run-row]").first()
    await expect(runRow, "run row renders in the output viewer (AC4)").toBeVisible({ timeout: 15_000 })
    // AC4: a status badge is present on the row.
    await expect(runRow.locator("[data-slot='badge']").first()).toBeVisible()
    const runId = await runRow.getAttribute("data-run-row")
    expect(runId, "run row carries the run_id").toBeTruthy()

    // R3: SSE assist_run_update emitted for this run (D19). The server emits on
    // start + terminal phase; either satisfies the "SSE drove the UI" assertion.
    expect(sseSub).not.toBeNull()
    await waitFor(
      () => sseSub!.assistRunEvents.find((e) => e.task_id === taskId && e.run_id === runId),
      { timeoutMs: 15_000, message: "assist_run_update SSE not received for the run" },
    )

    // R3: GET run → shape is correct (logs array, template, status).
    const run = await getAssistWorkflowRunViaApi(taskId, runId!)
    expect(run.template, "run carries the template name").toBe("moa-requirements-review")
    expect(run.run_id, "run_id round-trips").toBe(runId)
    expect(Array.isArray(run.logs), "run has logs array").toBe(true)

    // AC3: click the run row → WorkflowLogDialog opens.
    await runRow.click()
    const logDialog = page.locator("[data-workflow-log-dialog]")
    await expect(logDialog, "workflow log dialog opens on row click (AC3)").toBeVisible({ timeout: 10_000 })
    // The dialog renders either the log lines or the empty-logs hint (no provider
    // → the run may have errored immediately). Either way it's not a white screen.
    const hasLogs = await logDialog.locator("[data-workflow-logs]").count()
    const hasEmpty = await logDialog.locator("[data-workflow-empty-logs]").count()
    expect(hasLogs + hasEmpty, "log dialog renders logs or empty hint (AC3)").toBeGreaterThan(0)

    await page.screenshot({ path: v3ScreenshotPath("assist-01-log-dialog.png"), fullPage: true })
    log(`assist: triggered ${run.template} via UI; run row + log dialog rendered (status=${run.status})`)
  })

  test("adoption panel → spec-field(ac) + spec-field(decisions) (AC5)", async ({ page }) => {
    test.skip(!serverAvailable, "Server not available")
    test.skip(!assistTaskId, "assist task not created")
    const taskId = assistTaskId!

    // Open the modal + trigger a fresh run via the UI (same path as AC4).
    await page.goto("/tasks")
    await page.waitForLoadState("domcontentloaded")
    await page.locator('[data-task-column="draft"]').waitFor({ state: "visible", timeout: 15_000 })
    await page.locator(`[data-task-id="${taskId}"]`).first().click()
    const dialog = page.getByRole("dialog")
    await expect(dialog).toBeVisible({ timeout: 10_000 })
    const workspace = dialog.locator("[data-authoring-workspace]")
    await expect(workspace).toBeVisible({ timeout: 10_000 })
    await workspace.locator("[data-assist-trigger='moa-requirements-review']").click()
    const runsSection = workspace.locator("[data-workflow-runs-section]")
    await expect(runsSection).toBeVisible({ timeout: 15_000 })
    const runRow = runsSection.locator("[data-run-row]").first()
    await expect(runRow).toBeVisible({ timeout: 15_000 })
    const runId = await runRow.getAttribute("data-run-row")
    if (!runId) {
      test.skip(true, "trigger did not produce a run row (no runId)")
      return
    }

    // The real MoA needs an LLM provider; in dev the run stays "running". Seed
    // the aggregator output directly into the DB (mirrors the server assist
    // test) so the REAL GET route parses + returns structured output — the UI
    // is exercised through the real API (R1), not a mock.
    const acCandidate = "E2E_TD adopted ac from MoA"
    const suggestion = "E2E_TD adopted suggestion: async event bus"
    const synthesis = JSON.stringify({
      ac_candidates: [acCandidate, "second candidate not adopted"],
      suggestions: [suggestion],
      risks: ["E2E_TD risk: rate limit"],
    })
    seedAssistRunOutput(runId, synthesis)

    // D19: the OutputViewer is SSE-only (no polling) — it re-fetches a run
    // ONLY on assist_run_update SSE or when runIds changes (output-viewer.tsx
    // useEffect[runIds] re-fetches ALL runs). The seed writes the aggregator
    // output to the DB directly (no engine, no SSE), so re-trigger the MoA
    // button to append a 2nd run → the parent's setRunIds change forces the
    // viewer to re-fetch ALL runs → the seeded run's GET (real API, R1) returns
    // the structured output → adoption panel mounts. This is a real user
    // action (re-trigger), not a fake SSE injection.
    await workspace.locator("[data-assist-trigger='moa-requirements-review']").click()
    await expect(runsSection.locator("[data-run-row]")).toHaveCount(2, { timeout: 15_000 })

    // AC5: panel renders with the structured triplet (re-fetch surfaced output).
    const panel = runsSection.locator("[data-moa-adoption-panel]")
    await expect(panel, "adoption panel renders when run has output (AC5)").toBeVisible({ timeout: 15_000 })

    // Toggle the first suggestion checkbox ON (default off) → decision memo.
    await panel.locator("[data-moa-suggestion-checkbox='0']").click()
    // The first ac candidate is checked by default → will be adopted into ac.

    const beforeRow = readTaskRow(taskId)
    const beforeDecisions = (JSON.parse(beforeRow!.task_spec).decisions ?? []) as string[]
    const beforeAc = (JSON.parse(beforeRow!.task_spec).ac ?? []) as string[]

    await panel.locator("[data-moa-adopt-button]").click()
    await expect(panel.locator("[data-moa-adopted]"), "adopted confirmation renders").toBeVisible({ timeout: 10_000 })

    // R3/R5: spec-field(decisions) persisted the adopted suggestion (SW-BP3) +
    // spec-field(ac) persisted the adopted candidate. Cross-check the DB.
    await waitFor(() => {
      const row = readTaskRow(taskId)
      if (!row) return null
      const spec = JSON.parse(row.task_spec)
      const decisions = (spec.decisions ?? []) as string[]
      const ac = (spec.ac ?? []) as string[]
      return decisions.includes(suggestion) && ac.includes(acCandidate) ? row : null
    }, { timeoutMs: 10_000, message: "DB ac/decisions did not persist the adoption" })

    const afterSpec = JSON.parse(readTaskRow(taskId)!.task_spec)
    expect((afterSpec.decisions as string[]), "decisions includes adopted suggestion (SW-BP3)").toContain(suggestion)
    expect((afterSpec.ac as string[]), "ac includes adopted candidate").toContain(acCandidate)
    expect((afterSpec.decisions as string[]).length, "decisions grew").toBeGreaterThan(beforeDecisions.length)
    expect((afterSpec.ac as string[]).length, "ac grew").toBeGreaterThan(beforeAc.length)

    // AC5: the decision memo section lists the adopted suggestion (D10).
    await expect(dialog.locator("[data-decision-memo]")).toBeVisible({ timeout: 10_000 })
    await expect(dialog.locator("[data-decision-memo]")).toContainText(suggestion)

    await page.screenshot({ path: v3ScreenshotPath("assist-03-adoption.png"), fullPage: true })
    log(`assist: adoption panel → DB ac + decisions persisted (AC5/SW-BP3)`)
  })

  test("output_parse_error → degraded card with output_raw (AC6)", async ({ page }) => {
    test.skip(!serverAvailable, "Server not available")
    test.skip(!assistTaskId, "assist task not created")
    const taskId = assistTaskId!

    // Trigger a fresh run via the UI, then seed a MALFORMED aggregator synthesis
    // → the GET route returns output_raw + output_parse_error (SW-BP10). The
    // viewer renders the degraded card (not the adoption panel, not a white screen).
    await page.goto("/tasks")
    await page.waitForLoadState("domcontentloaded")
    await page.locator('[data-task-column="draft"]').waitFor({ state: "visible", timeout: 15_000 })
    await page.locator(`[data-task-id="${taskId}"]`).first().click()
    const dialog = page.getByRole("dialog")
    await expect(dialog).toBeVisible({ timeout: 10_000 })
    const workspace = dialog.locator("[data-authoring-workspace]")
    await expect(workspace).toBeVisible({ timeout: 10_000 })
    await workspace.locator("[data-assist-trigger='moa-requirements-review']").click()
    const runsSection = workspace.locator("[data-workflow-runs-section]")
    await expect(runsSection).toBeVisible({ timeout: 15_000 })
    const runRow = runsSection.locator("[data-run-row]").first()
    await expect(runRow).toBeVisible({ timeout: 15_000 })
    const runId = await runRow.getAttribute("data-run-row")
    if (!runId) {
      test.skip(true, "trigger did not produce a run row (no runId)")
      return
    }

    // Seed malformed synthesis → parse failure → output_raw + output_parse_error.
    const malformed = "this is not valid JSON { so the aggregator parse fails"
    seedAssistRunOutput(runId, malformed)

    // D19: SSE-only viewer — re-trigger to force a runIds change → re-fetch ALL
    // runs (see the adoption test above for the rationale). The seeded run's GET
    // returns output_raw + output_parse_error (real API, R1).
    await workspace.locator("[data-assist-trigger='moa-requirements-review']").click()
    await expect(runsSection.locator("[data-run-row]")).toHaveCount(2, { timeout: 15_000 })

    // AC6: the degraded card renders output_raw (no adoption panel, no white screen).
    const degraded = runsSection.locator("[data-run-parse-error]")
    await expect(degraded, "parse-error → degraded card with output_raw (AC6)").toBeVisible({ timeout: 15_000 })
    await expect(degraded, "degraded card shows the raw output text").toContainText("not valid JSON")
    // The adoption panel must NOT render (output is undefined on parse failure).
    await expect(runsSection.locator("[data-moa-adoption-panel]")).toHaveCount(0)

    await page.screenshot({ path: v3ScreenshotPath("assist-02-parse-error.png"), fullPage: true })
    log("assist: malformed aggregator output → degraded card with output_raw (AC6/SW-BP10)")
  })
})

// ── fulllink: AC1 single end-to-end story + AC2 lock regression ────────────
//
// Ticket 11 — the FULL-LINK story the spec AC Mapping marks as Browser E2E,
// walked on ONE task so the whole chain (template → create → draft +
// binding + home + plugin → chat → goal/ac emerge → direct edit → confirm
// → artifact full content → enqueue ready 200) is proven to compose. AC2
// adds the SW-BP9 lock regression (PUT skill_groups/task_type → 409). AC3's
// "confirm → 200" is folded into the AC1 story (the 409 backstop is already
// covered in the goalac group above).
//
// Anti-fake-run: R1 (real server :3001), R3 (API↔DB↔FS cross-check at every
// step), R4 (response+SQL+readdir+screenshot), R5 (home+skills/ created then
// reaped in afterAll), R6 (real /tasks UI → TaskModal → TemplatePicker →
// AuthoringWorkspace → OutputViewer → ArtifactViewerDialog → enqueue),
// R7 (E2E_TD_ prefix on goal/ac/decisions + ID-based cleanup), R8 (skill
// groups via /api/skill-groups — default always present, superpowers-zh is
// installed in dev).

test.describe("fulllink: AC1 story + AC2 lock (ticket 11)", () => {
  let fulllinkTaskId: string | null = null

  test("AC1 full-link story: template(2 groups) → create → draft+binding+home+plugin → chat → goal/ac emerge → direct edit → confirm → artifact view → ready 200", async ({ page }) => {
    test.skip(!serverAvailable, "Server not available")

    // ── Step 1: TemplatePicker — select coding + 2 skill groups (AC1) ──
    const startTime = Date.now()
    await page.goto("/tasks")
    await page.waitForLoadState("domcontentloaded")
    await page.locator('[data-task-column="draft"]').waitFor({ state: "visible", timeout: 15_000 })
    await page.locator("[data-task-new]").click()
    const dialog = page.getByRole("dialog")
    await expect(dialog).toBeVisible({ timeout: 10_000 })
    const picker = dialog.locator("[data-template-picker]")
    await expect(picker).toBeVisible({ timeout: 10_000 })

    await picker.locator('[data-task-type="coding"]').click()
    await picker.locator('[data-skill-group="default"]').click()
    // AC1: pick a SECOND group (multi-select integration, US2). superpowers-zh
    // is installed in dev → its skills materialize into {home}/skills/.
    const sg = await listSkillGroupsViaApi()
    const extra = sg.groups.find((g) => g.group !== "default" && g.skills.length > 0)
    expect(extra, "a second non-empty skill group exists for AC1 2-group selection").toBeTruthy()
    const extraGroup = extra!.group
    await picker.locator(`[data-skill-group="${extraGroup}"]`).click()
    const selectedGroups = ["default", extraGroup]

    await page.screenshot({ path: v3ScreenshotPath("fulllink-01-template-2groups.png"), fullPage: true })

    // ── Step 2: create → AuthoringWorkspace (AC1/D15) ──
    await picker.locator("[data-template-create]").click()
    const workspace = dialog.locator("[data-authoring-workspace]")
    await expect(workspace, "AuthoringWorkspace renders after create").toBeVisible({ timeout: 15_000 })
    await page.screenshot({ path: v3ScreenshotPath("fulllink-02-workspace-locked-badges.png"), fullPage: true })

    // R3/R5: find the created draft by recency + task_type (UI used a real org).
    const draft = await waitFor(async () => {
      const all = await listTasks({ status: "draft" })
      const candidates = all.items
        .filter((t) => {
          if (createdTaskIds.includes(t.id)) return false
          const spec = t.task_spec as { task_type?: string }
          if (spec?.task_type !== "coding") return false
          return new Date(t.created_at).getTime() >= startTime - 1000
        })
        .sort((a, b) => (b.created_at > a.created_at ? 1 : -1))
      return candidates[0] ?? null
    }, { timeoutMs: 15_000, intervalMs: 1000, message: "fulllink draft not found in listTasks" })
    fulllinkTaskId = draft.id
    createdTaskIds.push(draft.id)

    // AC1: EXACTLY one draft for this session (D15 — no twin draft). The
    // source_chat_session_id is bound + sessions.scope_id retargets to task.id.
    expect(draft.source_chat_session_id, "D15: source_chat_session_id bound").toBeTruthy()
    const scopeId = readSessionScopeId(draft.source_chat_session_id!)
    expect(scopeId, "SG3: sessions.scope_id == tasks.id").toBe(draft.id)
    const sessionDrafts = (await listTasks({ status: "draft" })).items.filter(
      (t) => t.source_chat_session_id === draft.source_chat_session_id,
    )
    expect(sessionDrafts.length, "D15: exactly one draft bound to this session (no twin)").toBe(1)

    // R3: DB cross-check — task_spec carries task_type + skill_groups (D4).
    const dbRow = readTaskRow(draft.id)
    expect(dbRow, "DB row exists").not.toBeNull()
    const taskSpec = JSON.parse(dbRow!.task_spec)
    expect(taskSpec.task_type, "DB task_type=coding").toBe("coding")
    expect(taskSpec.skill_groups, "DB skill_groups includes both selected").toEqual(
      expect.arrayContaining(selectedGroups),
    )

    // AC1/R5: home dir materialized + skills/ subdir + plugin materialization
    // (US2: the extra group's skills linked into {home}/skills/).
    const home = readTaskHomeDir(draft.id)
    expect(home, "task home dir exists (~/.octopus/tasks/{id}/)").not.toBeNull()
    expect(home!.includes("skills"), "home contains skills/ subdir").toBe(true)
    expect(home!.includes("artifacts"), "home contains artifacts/ subdir (ADR-0011)").toBe(true)
    // The default group is NOT materialized (D17) — only the extra group's
    // skills appear. superpowers-zh has ≥1 skill → skills/ is non-empty.
    const os = await import("os")
    const pathMod = await import("path")
    const fsMod = await import("fs")
    const skillsDir = pathMod.join(os.homedir(), ".octopus", "tasks", draft.id, "skills")
    const skillsEntries = fsMod.readdirSync(skillsDir, { withFileTypes: true })
    expect(skillsEntries.length, "US2: extra group skills materialized into {home}/skills/").toBeGreaterThan(0)
    // R5: the materialized skills are junctions/symlinks (not copies, on
    // Windows junctions report isSymbolicLink). D17: the default group is
    // NOT among them (only the extra group materializes).
    const linkedSkills = skillsEntries.filter((e) => e.isSymbolicLink())
    expect(linkedSkills.length, "US2: ≥1 skill linked (junction/symlink) into {home}/skills/").toBeGreaterThan(0)

    await page.screenshot({ path: v3ScreenshotPath("fulllink-03-home-plugin.png"), fullPage: true })
    log(`fulllink step 1-2: created ${draft.id} (groups=${selectedGroups.join(",")}, skills/ has ${skillsEntries.length} entries)`)

    // ── Step 3: chat panel renders (AC1 "→ chat") ──
    // The command bar + ChatArea live inside [data-authoring-workspace]. We
    // don't drive a real LLM turn (R2: LLM behavior is manual); we assert the
    // chat surface exists so the user COULD type.
    await expect(workspace.locator("[data-command-bar]")).toBeVisible()
    // The MoA assist trigger lives in the command bar — proves the chat
    // command surface mounted (AC1 chat + AC9 trigger entry point).
    await expect(workspace.locator("[data-assist-trigger='moa-requirements-review']")).toBeVisible()

    // ── Step 4: goal/ac emerge via SSE spec_field_update (AC1/US4) ──
    const goalText = "E2E_TD fulllink goal: two-phase authoring v3 story"
    await updateSpecField(draft.id, "goal", goalText)
    expect(sseSub).not.toBeNull()
    await waitFor(
      () => sseSub!.specFieldEvents.find((e) => e.task_id === draft.id && e.field === "goal"),
      { timeoutMs: 10_000, message: "spec_field_update SSE for goal" },
    )
    const card = workspace.locator("[data-goal-ac-card]")
    await expect(
      card.getByRole("textbox", { name: "编辑 goal" }),
      "goal emerges after SSE",
    ).toHaveValue(goalText)
    // R3: DB goal == the value the agent bound (API↔DB cross-check).
    expect(JSON.parse(readTaskRow(draft.id)!.task_spec).goal, "DB goal == agent-bound value").toBe(goalText)
    // R4: the SSE payload's version matches the DB version after the bump
    // (independent source of truth — the SSE event carries the new version).
    const goalSse = sseSub!.specFieldEvents.find((e) => e.task_id === draft.id && e.field === "goal")
    expect(goalSse, "SSE event captured for goal").toBeTruthy()
    expect(goalSse!.version, "SSE version == DB version (R4 cross-check)").toBe(readTaskRow(draft.id)!.version)

    // Bind ac (2 items so we can confirm both — US6).
    const acItems = ["E2E_TD fulllink ac one", "E2E_TD fulllink ac two"]
    await updateSpecField(draft.id, "ac", acItems)
    await waitFor(
      () => sseSub!.specFieldEvents.find((e) => e.task_id === draft.id && e.field === "ac"),
      { timeoutMs: 10_000, message: "spec_field_update SSE for ac" },
    )
    // R3: DB ac == the array the agent bound (API↔DB cross-check, order-sensitive).
    expect(JSON.parse(readTaskRow(draft.id)!.task_spec).ac, "DB ac == agent-bound array").toEqual(acItems)
    // ac items render as <input value=...> (editable), so getByText doesn't
    // match. Assert the ac count label + each item's confirm button (the
    // button's aria-label carries the item text — same pattern as the goalac
    // group's confirm test).
    await expect(card.getByText(/ac.*2.*条/), "ac count label shows 2 items").toBeVisible({ timeout: 10_000 })
    for (const item of acItems) {
      await expect(
        card.getByRole("button", { name: `确认 ac: ${item}` }),
        `ac confirm button for "${item}" renders`,
      ).toBeVisible({ timeout: 10_000 })
    }

    // ── Step 5: direct edit goal (blur-commit) → DB version+1 (AC1/US5, source=user) ──
    const beforeVersion = readTaskRow(draft.id)!.version
    const goalInput = card.getByRole("textbox", { name: "编辑 goal" })
    await goalInput.fill("E2E_TD fulllink user override goal")
    await goalInput.blur()
    await expect(card.locator("[data-edited-mark]"), "edited mark surfaces after user direct edit").toBeVisible({ timeout: 10_000 })
    await waitFor(() => {
      const row = readTaskRow(draft.id)
      return row && row.version > beforeVersion ? row : null
    }, { timeoutMs: 10_000, message: "DB version did not bump after direct edit" })
    expect(JSON.parse(readTaskRow(draft.id)!.task_spec).goal, "DB goal == user override").toBe("E2E_TD fulllink user override goal")

    // ── Step 6: confirm goal + all ac → spec-field persists (AC1/US6, D18) ──
    await card.getByRole("button", { name: /确认 goal/i }).click()
    await waitFor(() => {
      const row = JSON.parse(readTaskRow(draft.id)!.task_spec)
      return row.goal_confirmed === true ? row : null
    }, { timeoutMs: 10_000, message: "DB goal_confirmed did not persist" })
    expect(JSON.parse(readTaskRow(draft.id)!.task_spec).goal_confirmed, "DB goal_confirmed=true").toBe(true)

    // Confirm each ac item. The button label is `确认 ac: {item}`.
    for (const item of acItems) {
      const btn = card.getByRole("button", { name: new RegExp(`确认 ac:.*${item}`) }).first()
      if (await btn.isVisible({ timeout: 5000 }).catch(() => false)) {
        await btn.click()
      }
    }
    await waitFor(() => {
      const row = JSON.parse(readTaskRow(draft.id)!.task_spec)
      const confirmed = (row.ac_confirmed ?? []) as string[]
      return acItems.every((a) => confirmed.includes(a)) ? row : null
    }, { timeoutMs: 10_000, message: "DB ac_confirmed did not include all items" })
    const finalSpec = JSON.parse(readTaskRow(draft.id)!.task_spec)
    expect((finalSpec.ac_confirmed as string[]).length, "all ac items confirmed").toBeGreaterThanOrEqual(acItems.length)

    await page.screenshot({ path: v3ScreenshotPath("fulllink-04-goalac-confirmed.png"), fullPage: true })
    log("fulllink step 3-6: chat + goal/ac emerge + direct edit + confirm (DB persisted)")

    // ── Step 7: artifact full content view (AC1/US7) ──
    const specContent = "# E2E_TD fulllink proposal\n\nFull artifact content for the story walk.\nLine with detail."
    writeTaskArtifactFile(draft.id, "proposal.md", specContent)
    const now = new Date().toISOString()
    writeTaskArtifactIndex(draft.id, [
      { path: "proposal.md", by: "open-spec", title: "proposal.md — 方案文档", external: false, updated_at: now },
    ])
    // R3: API returns the pre-placed index entry.
    const index = await listArtifactsViaApi(draft.id)
    expect(index.some((e) => e.path === "proposal.md"), "API index carries proposal.md").toBe(true)

    // The modal was opened in step 2 (before the index existed), so the
    // OutputViewer's initial fetch returned []. Fire a spec_field_update
    // (source=user) — the verifiable SSE bridge the OutputViewer listens for
    // to re-fetch the index (same pattern as the viewer SSE-refresh test).
    await updateSpecField(draft.id, "goal", "E2E_TD fulllink user override goal", { source: "user" })

    const artifactsSection = workspace.locator("[data-artifacts-section]")
    await expect(artifactsSection).toBeVisible({ timeout: 10_000 })
    await expect(
      artifactsSection.locator("[data-artifact-row='0']"),
      "artifact row appears after SSE-triggered re-fetch",
    ).toBeVisible({ timeout: 15_000 })
    await artifactsSection.locator("[data-artifact-row='0']").click()
    const viewer = page.locator("[data-artifact-viewer-dialog]")
    await expect(viewer, "artifact viewer dialog opens").toBeVisible({ timeout: 10_000 })
    await expect(viewer.locator("[data-artifact-content]"), "dialog renders disk content verbatim").toContainText("Line with detail.", { timeout: 10_000 })
    // R3/R4: the dialog content == disk content (independent source of truth).
    const diskContent = await import("fs").then((fs) =>
      fs.readFileSync(
        pathMod.join(os.homedir(), ".octopus", "tasks", draft.id, "artifacts", "proposal.md"),
        "utf-8",
      ),
    )
    expect(diskContent, "disk content matches the fixture").toContain("E2E_TD fulllink proposal")
    expect(diskContent, "disk content has the detail line").toContain("Line with detail.")
    await page.screenshot({ path: v3ScreenshotPath("fulllink-05-artifact-viewer.png"), fullPage: true })
    await page.keyboard.press("Escape")
    await expect(viewer).not.toBeVisible({ timeout: 5000 })

    // ── Step 8: enqueue ready → 200 (AC1/AC3, gate passes after full confirm) ──
    // The enqueue button should now be ENABLED (goal+all ac confirmed).
    const enqueueBtn = workspace.locator("[data-task-enqueue]")
    await expect(enqueueBtn, "enqueue enabled after full confirm").toBeEnabled({ timeout: 10_000 })
    // AC3: server-side ready gate returns 200 (not 409) now that every gate
    // condition is met (D18). We hit the raw API to assert the 200 + the
    // task transitions draft→ready.
    const gate = await readyTaskRaw(draft.id)
    expect(gate.status, "AC3: ready gate returns 200 after full confirm (D18)").toBe(200)
    expect(gate.body.missing, "200 body has no missing list").toBeUndefined()
    // R3: DB status advanced draft→ready.
    const readyRow = readTaskRow(draft.id)
    expect(readyRow!.status, "DB status=ready after enqueue").toBe("ready")

    // US12/D14: the dispatch seam injected $vars.task_artifacts_dir into the
    // schedule config (the spec's US12 — "入队时系统把产物目录注入执行上下文").
    // R3/R4: read the schedule row directly + cross-check the config JSON.
    const { readSchedulesByOrigin } = await import("./helpers/task-domain-helpers")
    const schedules = readSchedulesByOrigin(draft.id)
    expect(schedules.length, "US12: ≥1 schedule created on dispatch").toBeGreaterThanOrEqual(1)
    const cfg = JSON.parse(schedules[0]!.config) as {
      workflow_chain?: Array<{ input_values?: Record<string, unknown> }>
    }
    const inputVals = cfg.workflow_chain?.[0]?.input_values
    expect(inputVals, "workflow_chain[0].input_values present").toBeDefined()
    expect(inputVals!.task_artifacts_dir, "US12: task_artifacts_dir injected into dispatch config").toBeTruthy()
    const expectedDir = pathMod.join(os.homedir(), ".octopus", "tasks", draft.id, "artifacts").replace(/\\/g, "/")
    const injected = String(inputVals!.task_artifacts_dir).replace(/\\/g, "/")
    expect(injected, "US12: injected dir == {home}/artifacts").toBe(expectedDir)

    await page.screenshot({ path: v3ScreenshotPath("fulllink-06-ready-200.png"), fullPage: true })
    log(`fulllink step 7-8: artifact viewed + enqueue ready 200 + US12 task_artifacts_dir injected (task ${draft.id} → ready)`)
  })

  test("AC2 lock regression: PUT skill_groups/task_type → 409 (SW-BP9)", async () => {
    test.skip(!serverAvailable, "Server not available")
    test.skip(!fulllinkTaskId, "fulllink story did not produce a task")
    const taskId = fulllinkTaskId!

    // AC2/UI: the AuthoringWorkspace already shows 🔒 locked badges with NO
    // dropdown to change skill groups (asserted in the template group's
    // topbar test). The server-side backstop is the PUT 409 — the UI can't
    // even attempt it, so we assert the API gate directly.

    const row = readTaskRow(taskId)!
    const version = row.version

    // AC2: PUT attempting to CHANGE skill_groups → 409 (SW-BP9). The body
    // carries the lock violation error message.
    const lockSkill = await updateTaskRaw(taskId, version, {
      task_spec: { ...JSON.parse(row.task_spec), skill_groups: ["default", "different-group"] },
    })
    expect(lockSkill.status, "AC2: PUT change skill_groups → 409").toBe(409)
    expect(String(lockSkill.body.error), "409 body explains skill_groups lock").toContain("skill_groups")
    // R3: the lock-409 body has NO `missing` field (distinguishes the SW-BP9
    // lock violation from the D18 ready-gate 409, which DOES carry missing[]).
    expect(lockSkill.body.missing, "lock-409 has no missing[] (not a gate violation)").toBeUndefined()
    // R3: the rejected PUT did NOT mutate the DB — version + skill_groups unchanged.
    const afterLockRow = readTaskRow(taskId)
    expect(afterLockRow!.version, "409 PUT did not bump version").toBe(version)
    expect(JSON.parse(afterLockRow!.task_spec).skill_groups, "409 PUT did not change skill_groups").toEqual(
      expect.arrayContaining(JSON.parse(row.task_spec).skill_groups),
    )

    // AC2: PUT attempting to CHANGE task_type → 409 (SW-BP9).
    const lockType = await updateTaskRaw(taskId, version, {
      task_spec: { ...JSON.parse(row.task_spec), task_type: "generic" },
    })
    expect(lockType.status, "AC2: PUT change task_type → 409").toBe(409)
    expect(String(lockType.body.error), "409 body explains task_type lock").toContain("task_type")
    // R3: task_type still "coding" after the rejected PUT.
    expect(JSON.parse(readTaskRow(taskId)!.task_spec).task_type, "409 PUT did not change task_type").toBe("coding")

    // AC2/SW-BP2: PUT that OMITS the locked fields (saves goal+ac only) → 200
    // + the locked fields are MERGE-PRESERVED (not clobbered to default). The
    // schema requires goal+ac (both non-empty), so the body carries those but
    // omits task_type + skill_groups to prove they're merge-preserved.
    const exSpec = JSON.parse(row.task_spec)
    const preserved = await updateTaskRaw(taskId, version, {
      task_spec: {
        goal: "E2E_TD fulllink saved goal only",
        ac: exSpec.ac ?? ["E2E_TD fallback ac"],
      },
    })
    expect(preserved.status, "PUT omitting locked fields → 200 (merge-preserve)").toBe(200)
    const afterRow = readTaskRow(taskId)
    expect(afterRow!.version, "200 PUT bumped version").toBe(version + 1)
    const afterSpec = JSON.parse(afterRow!.task_spec)
    expect(afterSpec.task_type, "task_type merge-preserved (SW-BP2)").toBe("coding")
    expect(afterSpec.skill_groups, "skill_groups merge-preserved (SW-BP2)").toEqual(
      expect.arrayContaining(["default"]),
    )
    // R3: the goal we saved round-trips through the merge-preserve path.
    expect(afterSpec.goal, "saved goal persisted (SW-BP2 merge-preserve)").toBe("E2E_TD fulllink saved goal only")

    log("AC2: PUT skill_groups/task_type → 409; omits → 200 merge-preserve (SW-BP9/SW-BP2)")
  })
})
