/**
 * Self-test for workspace.mjs
 * Run: node lib/workspace.self-test.mjs
 * Requires: dev server running
 */

import { createResults, record, exitWithResults } from "./reporter.mjs"
import { healthCheck } from "./api.mjs"
import { createWorkspace, getWorkspace, listWorkspaces, cleanupWorkspace } from "./workspace.mjs"

const results = createResults()

async function main() {
  // Pre-check: server must be running
  const healthy = await healthCheck()
  if (!healthy) {
    record(results, "Server health check", false, "Server not reachable — start with `pnpm dev`")
    exitWithResults(results, { title: "workspace.mjs self-test" })
  }

  let workspaceId = ""

  try {
    // Test 1: Create workspace
    const ws = await createWorkspace("selftest_ws", "xzf")
    workspaceId = ws.id
    record(
      results,
      "createWorkspace",
      !!ws.id && ws.name.startsWith("E2E_HARNESS_TEST_"),
      `id=${ws.id}, name=${ws.name}`,
    )

    // Test 2: Get workspace
    const detail = await getWorkspace(ws.id)
    record(
      results,
      "getWorkspace",
      detail.id === ws.id,
      `name=${detail.name}`,
    )

    // Test 3: List workspaces (should include our test workspace)
    const all = await listWorkspaces()
    const found = all.some((w) => w.id === ws.id)
    record(
      results,
      "listWorkspaces includes created",
      found,
      `total=${all.length}`,
    )

    // Test 4: Cleanup workspace
    const deleted = await cleanupWorkspace(ws.id)
    record(results, "cleanupWorkspace", deleted, `deleted=${deleted}`)

    // Verify deletion
    const afterAll = await listWorkspaces()
    const gone = !afterAll.some((w) => w.id === ws.id)
    record(results, "workspace removed after cleanup", gone, "")

  } catch (err) {
    record(results, "Unexpected error", false, err instanceof Error ? err.message : String(err))
  } finally {
    // Cleanup on failure
    if (workspaceId) {
      try { await cleanupWorkspace(workspaceId) } catch { /* ignore */ }
    }
    exitWithResults(results, { title: "workspace.mjs self-test" })
  }
}

main()
