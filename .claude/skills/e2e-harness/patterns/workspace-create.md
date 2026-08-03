# Pattern: Workspace Create

## When to Use

When an E2E test needs a fresh workspace as a sandbox for workflow execution, file operations, or UI verification. Most E2E journeys begin by creating a workspace.

## Modules to Import

```js
import { createWorkspace, cleanupWorkspace, cleanupAllTestWorkspaces } from "../lib/workspace.mjs"
import { resolveApiUrl, healthCheck } from "../lib/api.mjs"
import { createResults, record, exitWithResults } from "../lib/reporter.mjs"
```

## API Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/workspaces` | Create workspace (used by `createWorkspace`) |
| DELETE | `/api/workspaces/:id` | Delete workspace (used by `cleanupWorkspace`) |
| GET | `/api/workspaces` | List all workspaces |
| GET | `/api/workspaces/:id` | Get workspace details |

## Example Code

```js
const results = createResults()

// 0. Pre-flight: ensure server is running
const healthy = await healthCheck()
record(results, "server-health", healthy, healthy ? "ok" : "unreachable")
if (!healthy) {
  exitWithResults(results, { title: "Workspace Create E2E" })
}

// 1. Create workspace (name auto-prefixed with E2E_HARNESS_TEST_)
const ws = await createWorkspace("ws-create-demo", "xzf")
record(results, "workspace-created", !!ws.id, `id=${ws.id}`)

// 2. Verify workspace exists via API
const { fetchJSON } = await import("../lib/api.mjs")
const getResp = await fetchJSON(`/api/workspaces/${ws.id}`)
record(results, "workspace-exists", getResp.ok, `name=${getResp.data?.name}`)

// 3. Verify name prefix applied correctly
const hasPrefix = ws.name.startsWith("E2E_HARNESS_TEST_")
record(results, "name-prefix", hasPrefix, `name=${ws.name}`)

// 4. Cleanup
const deleted = await cleanupWorkspace(ws.id)
record(results, "workspace-deleted", deleted)

exitWithResults(results, { title: "Workspace Create E2E" })
```

## Pitfalls & Workarounds

- **Stale test data**: Always call `cleanupWorkspace(ws.id)` in a `finally` block. For belt-and-suspenders cleanup, run `cleanupAllTestWorkspaces()` in a global teardown hook.
- **Org path resolution**: `createWorkspace` does a best-effort lookup of the org's filesystem path via `/api/orgs`. If the org doesn't exist, the `path` field will be empty — this is non-fatal but means no filesystem backing.
- **Duplicate names**: The API allows duplicate workspace names. Use unique names per test (e.g., append `Date.now()`) to avoid confusion in list assertions.
- **Server not running**: Always `healthCheck()` first — `createWorkspace` throws on connection refused with a cryptic fetch error.

## When NOT to Use

- When the test only reads existing workspace data — use `getWorkspace(id)` or `listWorkspaces()` directly.
- When testing workspace listing UI — create fixtures in `beforeAll` rather than inline.
