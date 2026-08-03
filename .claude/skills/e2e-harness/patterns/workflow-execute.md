# Pattern: Workflow Execute

## When to Use

When an E2E test needs to create a workflow definition in a workspace, trigger an execution, and poll until it reaches a terminal state. Covers the full lifecycle: define → create → start → poll → assert.

## Modules to Import

```js
import { createWorkspace, cleanupWorkspace } from "../lib/workspace.mjs"
import { createWorkflow, createExecution, startExecution, pollExecution } from "../lib/execution.mjs"
import { createResults, record, exitWithResults } from "../lib/reporter.mjs"
```

## API Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/workspaces/:id/workflows` | Upload workflow YAML |
| POST | `/api/workspaces/:id/executions` | Create execution record |
| POST | `/api/workspaces/:id/executions/:eid/start` | Start execution |
| GET | `/api/workspaces/:id/executions/:eid` | Poll execution status |

## Selectors (data-testid)

| Element | Selector | Notes |
|---------|----------|-------|
| Execution list | `[data-testid="execution-list"]` | Workspace detail page |
| Execution status badge | `[data-testid="execution-status"]` | Shows current status |

## Example Code

```js
const results = createResults()
let ws = null

try {
  // 1. Create a sandbox workspace
  ws = await createWorkspace("wf-exec-demo")
  record(results, "workspace-created", !!ws.id)

  // 2. Upload a minimal workflow YAML
  const yaml = `
name: e2e-hello
nodes:
  - id: greet
    type: bash
    command: echo "hello from E2E"
`.trim()

  await createWorkflow(ws.id, "e2e-hello.yaml", yaml)
  record(results, "workflow-created", true, "e2e-hello.yaml")

  // 3. Create an execution record
  const exec = await createExecution(ws.id, "e2e-hello.yaml")
  record(results, "execution-created", !!exec.id, `status=${exec.status}`)

  // 4. Start the execution
  const started = await startExecution(ws.id, exec.id)
  record(results, "execution-started", started)

  // 5. Poll until terminal state (max 30s)
  const final = await pollExecution(ws.id, exec.id, 30_000, 2_000)
  const passed = final.status === "completed"
  record(results, "execution-completed", passed, `status=${final.status}`)

} catch (err) {
  record(results, "unexpected-error", false, err.message)
} finally {
  if (ws) await cleanupWorkspace(ws.id)
  exitWithResults(results, { title: "Workflow Execute E2E" })
}
```

## Pitfalls & Workarounds

- **Two-step execution**: Creating an execution (`POST .../executions`) only registers it — you must separately call `/start`. Forgetting the start call is the #1 cause of "stuck in created" timeouts.
- **Polling timeout vs failure**: `pollExecution` returns `{ status: "timeout" }` instead of throwing when the max wait is exceeded. Always check `final.status === "completed"` rather than assuming an exception.
- **YAML validation**: The server validates YAML on upload. Invalid YAML throws from `createWorkflow` — wrap it in try/catch if testing error paths.
- **Terminal statuses**: The set is `completed`, `failed`, `error`, `cancelled`. A `failed` execution is still "terminal" — your assertion should check specifically for `completed`.
- **Transient poll errors**: Network blips during polling are silently retried. Only the final timeout matters.

## When NOT to Use

- When testing workflow YAML validation errors — use `createWorkflow` alone and assert the thrown error.
- When testing the execution UI in the browser — combine with `launchBrowser` + `navigateTo` from `browser.mjs` (see `dialog-interact.md` for browser patterns).
- When you need real-time streaming output — the harness only supports polling, not SSE/WebSocket streaming.
