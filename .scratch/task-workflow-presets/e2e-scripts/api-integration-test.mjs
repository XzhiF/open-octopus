#!/usr/bin/env node
/**
 * E2E API Integration Test — task-workflow-presets
 *
 * Tests AC:
 *  1. GET /api/workflow-presets returns catalog with general fallback
 *  2. GET /api/workflow-presets?skills_group=... filters correctly
 *  3. PUT /api/tasks/:id persists input_values atomically with workflow_ref
 *  4. POST /api/tasks/:id/ready - missing required input → 409 + input:<name>
 *  5. POST /api/tasks/:id/ready - resolved ${goal} → passes gate
 *  6. POST /api/tasks/:id/ready - unknown placeholder → 409 (not 500)
 *  7. Composite task (subunits >= 2) skips task-level input validation
 */

import { resolveApiUrl, fetchJSON } from "../../../.claude/skills/e2e-harness/lib/api.mjs"
import { querySQL, resolveDbPath } from "../../../.claude/skills/e2e-harness/lib/db.mjs"
import fs from "node:fs"
import path from "node:path"

const API = resolveApiUrl()
const ORG = "E2E_TD_org"
const DB_PATH = resolveDbPath()  // main dev DB
const E2E_DATA = "/Users/xzf/Projects/ai/XzhiF/open-octopus/.scratch/task-workflow-presets/e2e-data"
const PREFIX = "E2E_TEST_WP_"
const createdTaskIds = []

function sqlQuery(sql) {
  const result = querySQL(sql, DB_PATH)
  if (!result.ok) {
    console.error(`[SQL ERROR] ${result.error}: ${sql}`)
    return []
  }
  return result.data || []
}

function record(step, pass, detail = "") {
  const status = pass ? "PASS" : "FAIL"
  console.log(`[${status}] ${step}${detail ? ": " + detail : ""}`)
  return pass
}

async function cleanup() {
  for (const id of createdTaskIds) {
    try {
      // Try to abort first (in case scheduler picked it up)
      await fetchJSON(`${API}/api/tasks/${id}/abort`, { method: "POST" })
    } catch {}
    try {
      await fetchJSON(`${API}/api/tasks/${id}`, { method: "DELETE" })
    } catch {}
  }
  console.log(`\n[cleanup] Deleted ${createdTaskIds.length} test tasks`)
}

async function main() {
  const results = []

  console.log("=== E2E API Integration Test: task-workflow-presets ===\n")

  // ─── AC1: GET /api/workflow-presets returns catalog ───────────────────
  {
    const r = await fetchJSON(`${API}/api/workflow-presets`)
    const pass = r.ok && r.data?.presets && Array.isArray(r.data.presets) && r.data.presets.length > 0
    results.push(record("AC1a: GET /api/workflow-presets returns presets array", pass,
      `status=${r.status}, count=${r.data?.presets?.length || 0}`))
    fs.writeFileSync(path.join(E2E_DATA, "ac1-presets-response.json"), JSON.stringify(r.data, null, 2))

    // Check general-dev preset exists (general fallback)
    const hasGeneral = r.data.presets.some(p => p.name === "general-dev" && Array.isArray(p.skills_group) && p.skills_group.length === 0)
    results.push(record("AC1b: general-dev preset (fallback) exists", pass && hasGeneral,
      `found=${hasGeneral}`))

    // Check preset shape
    const p = r.data.presets[0]
    const shapeOk = p.name && p.workflow && typeof p.inputs === "object"
    results.push(record("AC1c: preset shape (name, workflow, inputs)", shapeOk,
      `sample=${JSON.stringify(p)}`))
  }

  // ─── AC2: Filtering by skills_group ─────────────────────────────────
  {
    const r = await fetchJSON(`${API}/api/workflow-presets?skills_group=octo-xzf-implementer`)
    const pass = r.ok && r.data?.presets
    const hasXzf = r.data.presets.some(p => p.name === "xzf-dev")
    const hasGeneral = r.data.presets.some(p => p.name === "general-dev")
    results.push(record("AC2a: skills_group filter includes matching preset", pass && hasXzf,
      `xzf-dev found=${hasXzf}`))
    results.push(record("AC2b: skills_group filter includes general fallback", pass && hasGeneral,
      `general-dev found=${hasGeneral}`))

    // Non-existent skills_group should return ONLY general fallback
    const r2 = await fetchJSON(`${API}/api/workflow-presets?skills_group=nonexistent-group`)
    const onlyGeneral = r2.data?.presets?.length === 1 && r2.data.presets[0].name === "general-dev"
    results.push(record("AC2c: non-matching group returns only general fallback", onlyGeneral,
      `count=${r2.data?.presets?.length}, names=${r2.data?.presets?.map(p=>p.name).join(",")}`))
  }

  // ─── Create a v3 task for further tests ─────────────────────────────
  console.log("\n--- Creating test v3 task ---")
  const createResp = await fetchJSON(`${API}/api/tasks`, {
    method: "POST",
    body: JSON.stringify({
      org: ORG,
      name: `${PREFIX}preset-bind-test`,
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
  const taskVersion = createResp.data.version
  createdTaskIds.push(taskId)
  console.log(`[info] Created task ${taskId} (v${taskVersion})`)

  // ─── AC3: PUT /api/tasks/:id persists input_values atomically ────────
  {
    // First fill in goal + ac + confirmations so we can test the gate
    const specPut = await fetchJSON(`${API}/api/tasks/${taskId}`, {
      method: "PUT",
      headers: { "If-Match": String(taskVersion) },
      body: JSON.stringify({
        task_spec: {
          goal: "E2E_TEST: implement workflow presets binding",
          ac: ["preset catalog API works", "binding dialog saves input_values", "ready-gate checks required inputs"],
          task_type: "coding",
          skill_groups: ["octo-xzf-implementer"],
          goal_confirmed: true,
          ac_confirmed: [
            "preset catalog API works",
            "binding dialog saves input_values",
            "ready-gate checks required inputs"
          ],
          input_values: {
            idea: "${goal}",
          },
        },
        workflow_ref: "built-in/matt-dev-pipeline",
      }),
    })
    results.push(record("AC3a: PUT task with workflow_ref + input_values succeeds", specPut.ok,
      `status=${specPut.status}`))

    // Verify DB has input_values
    const dbRows = sqlQuery(`SELECT task_spec, workflow_ref FROM tasks WHERE id = '${taskId}'`)
    if (dbRows.length === 0) {
      results.push(record("AC3b: DB has input_values persisted", false, "no DB rows found"))
      results.push(record("AC3c: DB has workflow_ref persisted", false, "no DB rows found"))
      results.push(record("AC3d: API response has input_values", false, "no DB rows found"))
    } else {
      const dbSpec = JSON.parse(dbRows[0].task_spec)
      const hasInputValues = dbSpec.input_values && dbSpec.input_values.idea === "${goal}"
      results.push(record("AC3b: DB has input_values persisted", hasInputValues,
        `input_values=${JSON.stringify(dbSpec.input_values)}`))

      const hasWorkflowRef = dbRows[0].workflow_ref === "built-in/matt-dev-pipeline"
      results.push(record("AC3c: DB has workflow_ref persisted", hasWorkflowRef,
        `workflow_ref=${dbRows[0].workflow_ref}`))

      // API response should also have them
      const apiSpec = specPut.data.task_spec || specPut.data
      const apiHasIV = apiSpec.input_values && apiSpec.input_values.idea === "${goal}"
      results.push(record("AC3d: API response has input_values", apiHasIV,
        `api.input_values=${JSON.stringify(apiSpec.input_values)}`))
    }

    fs.writeFileSync(path.join(E2E_DATA, "ac3-put-response.json"), JSON.stringify(specPut.data, null, 2))
    fs.writeFileSync(path.join(E2E_DATA, "ac3-db-rows.json"), JSON.stringify(dbRows, null, 2))
  }

  // ─── AC4: Ready-gate missing required input → 409 ───────────────────
  {
    // Create a task WITHOUT input_values but with workflow_ref bound
    const createResp2 = await fetchJSON(`${API}/api/tasks`, {
      method: "POST",
      body: JSON.stringify({
        org: ORG,
        name: `${PREFIX}gate-missing-input`,
        task_type: "coding",
        skill_groups: [],
        preset: { org: ORG, projects: [] },
      }),
    })
    const task2 = createResp2.data
    createdTaskIds.push(task2.id)

    // Fill goal+ac+confirm but NO input_values + bind to a workflow with required inputs
    const spec2Put = await fetchJSON(`${API}/api/tasks/${task2.id}`, {
      method: "PUT",
      headers: { "If-Match": String(task2.version) },
      body: JSON.stringify({
        task_spec: {
          goal: "E2E_TEST: gate missing input",
          ac: ["test gate rejects when required input missing"],
          task_type: "coding",
          skill_groups: [],
          goal_confirmed: true,
          ac_confirmed: ["test gate rejects when required input missing"],
          // No input_values!
        },
        workflow_ref: "built-in/matt-dev-pipeline",  // has required input: idea
      }),
    })

    // Now try to ready it
    const readyResp = await fetchJSON(`${API}/api/tasks/${task2.id}/ready`, { method: "POST" })
    const is409 = readyResp.status === 409
    const hasInputMissing = readyResp.data?.missing?.includes("input:idea")
    results.push(record("AC4a: Ready-gate returns 409 for missing required input", is409,
      `status=${readyResp.status}`))
    results.push(record("AC4b: 409 missing contains input:idea", hasInputMissing,
      `missing=${JSON.stringify(readyResp.data?.missing)}`))
    fs.writeFileSync(path.join(E2E_DATA, "ac4-ready-409.json"), JSON.stringify(readyResp.data, null, 2))
  }

  // ─── AC5: Ready-gate passes when ${goal} resolves ───────────────────
  {
    // Use the first task which has input_values.idea = "${goal}" and goal is set
    const readyResp = await fetchJSON(`${API}/api/tasks/${taskId}/ready`, { method: "POST" })
    // The task has goal set + input_values.idea = "${goal}" → should resolve + pass
    // BUT matt-dev-pipeline also has 'feature' and 'max_iterations' as optional inputs
    // and 'idea' as required — should pass since "${goal}" resolves to the goal string
    results.push(record("AC5: Ready-gate passes when ${goal} resolves for required input",
      readyResp.ok,
      `status=${readyResp.status}${readyResp.data?.missing ? " missing=" + JSON.stringify(readyResp.data.missing) : ""}`))

    if (readyResp.ok) {
      // Verify schedule was created with resolved input_values
      const schedRows = sqlQuery(`SELECT config FROM schedules WHERE origin_id = '${taskId}'`)
      if (schedRows.length > 0) {
        const config = JSON.parse(schedRows[0].config)
        const chain = config.workflow_chain || []
        const firstChainInput = chain[0]?.input_values || {}
        const ideaResolved = firstChainInput.idea === "E2E_TEST: implement workflow presets binding"
        results.push(record("AC5b: Schedule config has resolved idea = goal text", ideaResolved,
          `idea=${firstChainInput.idea}`))
        fs.writeFileSync(path.join(E2E_DATA, "ac5-schedule-config.json"), JSON.stringify(config, null, 2))
      } else {
        results.push(record("AC5b: Schedule config exists", false, "no schedule rows found"))
      }
    }
    fs.writeFileSync(path.join(E2E_DATA, "ac5-ready-response.json"), JSON.stringify(readyResp.data, null, 2))
  }

  // ─── AC6: Unknown placeholder → 409 (not 500) ──────────────────────
  {
    const createResp3 = await fetchJSON(`${API}/api/tasks`, {
      method: "POST",
      body: JSON.stringify({
        org: ORG,
        name: `${PREFIX}unknown-placeholder`,
        task_type: "coding",
        skill_groups: [],
        preset: { org: ORG, projects: [] },
      }),
    })
    const task3 = createResp3.data
    createdTaskIds.push(task3.id)

    // Set input_values with unknown placeholder ${foo}
    const spec3Put = await fetchJSON(`${API}/api/tasks/${task3.id}`, {
      method: "PUT",
      headers: { "If-Match": String(task3.version) },
      body: JSON.stringify({
        task_spec: {
          goal: "E2E_TEST: unknown placeholder",
          ac: ["test unknown placeholder → 409"],
          task_type: "coding",
          skill_groups: [],
          goal_confirmed: true,
          ac_confirmed: ["test unknown placeholder → 409"],
          input_values: {
            idea: "${unknown_placeholder}",
          },
        },
        workflow_ref: "built-in/matt-dev-pipeline",
      }),
    })

    const readyResp3 = await fetchJSON(`${API}/api/tasks/${task3.id}/ready`, { method: "POST" })
    const is409 = readyResp3.status === 409
    const not500 = readyResp3.status !== 500
    const hasInputMissing = readyResp3.data?.missing?.some(m => m.startsWith("input:"))
    results.push(record("AC6a: Unknown placeholder → 409 (not 500)", is409 && not500,
      `status=${readyResp3.status}`))
    results.push(record("AC6b: 409 missing contains input:* item", hasInputMissing,
      `missing=${JSON.stringify(readyResp3.data?.missing)}`))
    fs.writeFileSync(path.join(E2E_DATA, "ac6-unknown-placeholder.json"), JSON.stringify(readyResp3.data, null, 2))
  }

  // ─── AC7: Composite task skips task-level input validation ─────────
  {
    const createResp4 = await fetchJSON(`${API}/api/tasks`, {
      method: "POST",
      body: JSON.stringify({
        org: ORG,
        name: `${PREFIX}composite-no-inputs`,
        task_type: "coding",
        skill_groups: [],
        preset: { org: ORG, projects: [] },
      }),
    })
    const task4 = createResp4.data
    createdTaskIds.push(task4.id)

    // Set task_spec with subunits (composite) and no input_values
    const spec4Put = await fetchJSON(`${API}/api/tasks/${task4.id}`, {
      method: "PUT",
      headers: { "If-Match": String(task4.version) },
      body: JSON.stringify({
        task_spec: {
          goal: "E2E_TEST: composite task",
          ac: ["composite skips input validation"],
          task_type: "coding",
          skill_groups: [],
          goal_confirmed: true,
          ac_confirmed: ["composite skips input validation"],
          subunits: [
            {
              name: "sub1",
              workspace_spec: { org: ORG, branch_prefix: "test", projects: [{ name: "p1", source_path: "/tmp" }] },
              workflow_ref: "built-in/basic-dev-flow",
            },
            {
              name: "sub2",
              workspace_spec: { org: ORG, branch_prefix: "test", projects: [{ name: "p2", source_path: "/tmp" }] },
              workflow_ref: "built-in/basic-dev-flow",
            },
          ],
          // No input_values, no workflow_ref — composite should NOT need them
        },
      }),
    })

    if (!spec4Put.ok) {
      results.push(record("AC7: PUT composite task_spec", false,
        `PUT failed: ${spec4Put.status} ${spec4Put.text}`))
    } else {
      // Ready should NOT fail due to missing input validation
      // It may succeed or fail for other reasons, but should NOT have input:* in missing
      const readyResp4 = await fetchJSON(`${API}/api/tasks/${task4.id}/ready`, { method: "POST" })
      const hasInputMissing = readyResp4.data?.missing?.some(m => m.startsWith("input:"))
      // For composite: input:* should NOT appear in missing
      results.push(record("AC7: Composite task has no input:* in missing", !hasInputMissing,
        `status=${readyResp4.status}, missing=${JSON.stringify(readyResp4.data?.missing || [])}`))
      fs.writeFileSync(path.join(E2E_DATA, "ac7-composite-ready.json"), JSON.stringify(readyResp4.data, null, 2))
    }
  }

  // ─── AC8: Seed catalog — general fallback visible ──────────────────
  {
    // Already tested in AC1b — general-dev preset exists with empty skills_group
    // Also test: when no skills_group param, ALL presets returned (including general)
    const r = await fetchJSON(`${API}/api/workflow-presets`)
    const totalPresets = r.data?.presets?.length || 0
    results.push(record("AC8: Seed catalog has >= 2 presets (general-dev + xzf-dev)", totalPresets >= 2,
      `count=${totalPresets}`))
  }

  // ─── Summary ────────────────────────────────────────────────────────
  const passed = results.filter(Boolean).length
  const failed = results.filter(r => !r).length
  console.log(`\n=== Summary: ${passed} PASS, ${failed} FAIL out of ${results.length} tests ===`)

  await cleanup()

  if (failed > 0) {
    process.exit(1)
  }
}

main().catch(err => {
  console.error("Test crashed:", err)
  cleanup().finally(() => process.exit(1))
})
