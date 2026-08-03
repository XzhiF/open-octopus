# E2E Harness — Module Index

| Module | Status | Last Verified | Description |
|--------|--------|---------------|-------------|
| `api.mjs` | STABLE | 2026-08-03 | Unified HTTP client + port resolution |
| `workspace.mjs` | STABLE | 2026-08-03 | Workspace lifecycle CRUD |
| `execution.mjs` | STABLE | 2026-08-03 | Workflow execution + polling |
| `browser.mjs` | STABLE | 2026-08-03 | Playwright browser management |
| `reporter.mjs` | STABLE | 2026-08-03 | Test result recording + reporting |
| `db.mjs` | STABLE | 2026-08-03 | SQLite CLI execution |

## Module Details

### api.mjs

- **Path**: `lib/api.mjs`
- **Self-test**: `lib/api.self-test.mjs`
- **Exports**:
  - `fetchJSON(urlOrPath, options?)` — JSON HTTP request to Octopus API
  - `healthCheck(apiUrl?)` — Check server health endpoint
  - `resolveApiUrl()` — Get API base URL string
  - `resolveWebUrl()` — Get web app base URL string
  - `resolvePorts()` — Get `{server, web}` port numbers
- **Dependencies**: `node:crypto`, `node:child_process`, `node:fs`, `node:path`, `node:os`
- **Port resolution priority**: env vars → port file → main repo defaults → hash fallback

### workspace.mjs

- **Path**: `lib/workspace.mjs`
- **Self-test**: `lib/workspace.self-test.mjs`
- **Exports**:
  - `createWorkspace(name, org?, repos?)` — Create workspace with auto-prefix
  - `cleanupWorkspace(id)` — Delete workspace (idempotent)
  - `listWorkspaces()` — List all workspaces
  - `getWorkspace(id)` — Get workspace by ID
  - `cleanupAllTestWorkspaces()` — Delete all `E2E_HARNESS_TEST_` workspaces
- **Dependencies**: `api.mjs`

### execution.mjs

- **Path**: `lib/execution.mjs`
- **Self-test**: `lib/execution.self-test.mjs`
- **Exports**:
  - `createExecution(workspaceId, workflowRef, name?)` — Create execution
  - `startExecution(workspaceId, executionId)` — Start execution
  - `pollExecution(workspaceId, executionId, maxWaitMs?, intervalMs?)` — Poll to terminal status
  - `getExecution(workspaceId, executionId)` — Get execution details
  - `createWorkflow(workspaceId, ref, content)` — Create workflow via API
  - `pauseExecution(workspaceId, executionId)` — Pause running execution
  - `resumeExecution(workspaceId, executionId)` — Resume paused execution
  - `getExecutionTree(workspaceId)` — List all executions for workspace
- **Dependencies**: `api.mjs`
- **Terminal statuses**: `completed`, `failed`, `error`, `cancelled`

### browser.mjs

- **Path**: `lib/browser.mjs`
- **Self-test**: `lib/browser.self-test.mjs`
- **Exports**:
  - `launchBrowser(options?)` — Launch Playwright chromium, returns `{browser, context, page}`
  - `takeScreenshot(page, name, dir?, options?)` — Screenshot to PNG file
  - `captureConsole(page)` — Capture console errors/warnings/all
  - `navigateTo(page, url, options?)` — Navigate and wait for page ready
  - `wait(ms)` — Delay helper
  - `closeBrowser(browser)` — Close browser safely
  - `clickByTestId(page, testId, options?)` — Click by `data-testid`
  - `fillByTestId(page, testId, value, options?)` — Fill input by `data-testid`
  - `getTextByTestId(page, testId, options?)` — Get text by `data-testid`
- **Dependencies**: `playwright`, `node:fs`, `node:path`
- **Default viewport**: 1440 x 900
- **Default locale**: `zh-CN`

### reporter.mjs

- **Path**: `lib/reporter.mjs`
- **Self-test**: `lib/reporter.self-test.mjs`
- **Exports**:
  - `createResults()` — Create empty results array
  - `record(results, step, pass, detail?)` — Record step result (logs immediately)
  - `printReport(results, options?)` — Print formatted table report
  - `saveResults(results, filePath)` — Save results as JSON
  - `assertAllPass(results, message?)` — Throw if any step failed
  - `exitWithResults(results, options?)` — Print report and `process.exit()`
- **Dependencies**: `node:fs`, `node:path`
- **No external dependencies**

### db.mjs

- **Path**: `lib/db.mjs`
- **Self-test**: `lib/db.self-test.mjs`
- **Exports**:
  - `resolveDbPath(dbPath?, mode?)` — Resolve DB file path
  - `executeSQL(sql, dbPath?, options?)` — Execute SQL, return raw rows string
  - `querySQL(sql, dbPath?, options?)` — Execute SQL, parse to JSON objects
  - `listTables(dbPath?)` — List all table names
- **Dependencies**: `node:child_process`, `node:fs`, `node:path`, `node:os`
- **Uses**: `sqlite3` CLI (must be on `$PATH`)
- **DB path priority**: explicit arg → `OCTOPUS_DB_PATH` env → mode-based → default

## How to Read This Index

- **STABLE**: Verified via self-test. Import directly in production tests.
- **DRAFT**: Under development. Has `_draft` suffix in filename. Do NOT import in production tests. Has a self-test that may not pass yet.
- **DEPRECATED**: Scheduled for removal. Migrate to the suggested replacement.

When adding a new module:
1. Create `lib/{name}_draft.mjs` with JSDoc and `@status DRAFT`
2. Create `lib/{name}.self-test.mjs`
3. Add a DRAFT row to the table above
4. Promote to STABLE after self-test passes 3 consecutive runs
