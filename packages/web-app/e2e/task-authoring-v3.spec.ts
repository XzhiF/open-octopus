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
  isServerAvailable,
  listTasks,
  deleteTask,
  updateSpecField,
  readyTaskRaw,
  listSkillGroupsViaApi,
  readTaskRow,
  readSessionScopeId,
  readTaskHomeDir,
  assertTaskMatchesDb,
  waitFor,
  startSseSubscriber,
  type SseSubscriber,
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
  ensureScreenshotDir()
  try {
    sseSub = await startSseSubscriber()
  } catch (err: unknown) {
    logError(`SSE subscriber failed to start: ${err instanceof Error ? err.message : String(err)}`)
  }
})

test.afterAll(async () => {
  sseSub?.stop()
  for (const taskId of createdTaskIds) {
    try {
      await deleteTask(taskId)
    } catch (err: unknown) {
      logError(`cleanup deleteTask ${taskId}: ${err instanceof Error ? err.message : String(err)}`)
    }
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

    await page.screenshot({ path: screenshotPath("template-01-picker.png"), fullPage: true })
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
    await page.screenshot({ path: screenshotPath("template-02-workspace.png"), fullPage: true })
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
    await expect(page.getByRole("heading", { name: /编写语境/ })).toBeVisible({ timeout: 10_000 })
    // The preset dialog body shows the org context (US14: org + projects only).
    await expect(page.getByText(/组织|项目/).last()).toBeVisible({ timeout: 10_000 })
    // US14: no "技能" label anywhere in the preset popup (skills belong to
    // workflow.requires, NOT the preset). Scope to the last dialog (the preset
    // popup renders in a portal above the TaskModal).
    const lastDialog = page.locator('[role="dialog"]').last()
    const skillsLabel = await lastDialog.locator("text=/^技能$/").count()
    expect(skillsLabel, "preset dialog has NO skills section (US14)").toBe(0)

    await page.screenshot({ path: screenshotPath("template-03-topbar.png"), fullPage: true })
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

    // AC4: ghost placeholder before the agent binds (task created with empty goal).
    await expect(card.getByText(/goal — 待 agent 绑定后浮现/)).toBeVisible({ timeout: 10_000 })

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

    // AC4: the goal emerges in the UI (SSE applied live).
    await expect(card.getByText(goalText), "goal emerges after SSE").toBeVisible({ timeout: 10_000 })

    // AC4: direct edit → spec-field source=user → DB version+1 + ✏️ edited mark.
    const beforeRow = readTaskRow(taskId)
    const beforeVersion = beforeRow!.version

    await card.getByRole("button", { name: /直接编辑.*goal|编辑 goal/i }).click()
    const textarea = card.getByRole("textbox")
    await textarea.fill("E2E_TD user override goal")
    await card.getByRole("button", { name: /^保存$/ }).click()

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

    await page.screenshot({ path: screenshotPath("goalac-01-edit.png"), fullPage: true })
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

    await page.screenshot({ path: screenshotPath("goalac-02-confirm-persist.png"), fullPage: true })
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

    await page.screenshot({ path: screenshotPath("goalac-03-gate-disabled.png"), fullPage: true })
    log(`Enqueue gate: UI disabled + server 409 missing=[${gate.body.missing!.join(",")}]`)
  })
})
