# Verified Spec — E2E Harness System

## Overview

A reusable E2E testing skill at `.claude/skills/e2e-harness/` that provides 6 stable library modules, self-tests, pattern guides, recipe templates, and a STABLE/DRAFT evolution protocol. Eliminates repeated E2E script boilerplate across `.scratch/` features.

## Architecture

```
.claude/skills/e2e-harness/
├── SKILL.md                    # Skill definition + module API reference
├── index.md                    # Module registry (STABLE/DRAFT status)
├── lib/
│   ├── workspace.mjs           # STABLE — workspace lifecycle
│   ├── workspace.self-test.mjs
│   ├── execution.mjs           # STABLE — workflow execution + polling
│   ├── execution.self-test.mjs
│   ├── browser.mjs             # STABLE — Playwright browser management
│   ├── browser.self-test.mjs
│   ├── reporter.mjs            # STABLE — test result recording + reporting
│   ├── reporter.self-test.mjs
│   ├── api.mjs                 # STABLE — unified HTTP + port resolution
│   ├── api.self-test.mjs
│   ├── db.mjs                  # STABLE — SQLite CLI execution
│   └── db.self-test.mjs
├── patterns/
│   ├── workspace-create.md
│   ├── workflow-execute.md
│   ├── dialog-interact.md
│   ├── tab-switch.md
│   └── file-tree-ops.md
├── recipes/
│   └── full-lifecycle.mjs
├── baselines/                  # (reserved for future feature baselines)
└── tests/
    └── integration-test.mjs    # Full lifecycle integration test
```

## Module API Signatures

### 1. workspace.mjs

```js
import { createWorkspace, cleanupWorkspace, listWorkspaces, getWorkspace } from './lib/workspace.mjs'

createWorkspace(name, org, repos?) → Promise<{ id, name, org }>
cleanupWorkspace(id) → Promise<boolean>
listWorkspaces() → Promise<Workspace[]>
getWorkspace(id) → Promise<Workspace>
```

- Uses `api.mjs` for `fetchJSON` and base URL resolution
- `name` is prefixed with `E2E_HARNESS_TEST_` if not already
- `cleanupWorkspace` is idempotent — returns false if workspace doesn't exist

### 2. execution.mjs

```js
import { createExecution, startExecution, pollExecution, getExecution } from './lib/execution.mjs'

createExecution(workspaceId, workflowRef, name?) → Promise<{ id, status }>
startExecution(workspaceId, executionId) → Promise<boolean>
pollExecution(workspaceId, executionId, maxWaitMs?) → Promise<ExecutionDetail>
getExecution(workspaceId, executionId) → Promise<ExecutionDetail>
```

- `pollExecution` defaults to 60s timeout, 2s interval
- Terminal statuses: `completed`, `failed`, `error`, `cancelled`
- Returns `{ status: "timeout" }` on timeout

### 3. browser.mjs

```js
import { launchBrowser, takeScreenshot, captureConsole, closeBrowser } from './lib/browser.mjs'

launchBrowser(options?) → Promise<{ browser, context, page }>
takeScreenshot(page, name, dir?) → Promise<string>
captureConsole(page) → { errors: string[], all: string[] }
closeBrowser(browser) → Promise<void>
```

- Default: `{ headless: true, viewport: { width: 1440, height: 900 } }`
- `takeScreenshot` creates dir if missing, returns path
- `captureConsole` returns mutable arrays that populate as events fire

### 4. reporter.mjs

```js
import { record, printReport, saveResults } from './lib/reporter.mjs'

record(results, step, pass, detail) → void
printReport(results) → void
saveResults(results, path) → void
```

- `results` is a mutable array passed by reference
- `printReport` prints formatted table + overall pass/fail
- `saveResults` writes JSON to file

### 5. api.mjs

```js
import { fetchJSON, healthCheck, resolveApiUrl, resolveWebUrl } from './lib/api.mjs'

fetchJSON(path, options?) → Promise<Response>
healthCheck(apiUrl?) → Promise<boolean>
resolveApiUrl() → string
resolveWebUrl() → string
```

- Port resolution: reads `~/.octopus/ports/{branch}.json` → fallback to hash-based port
- Hash port: `3100 + (sha1(branch) % 250) * 2` for server, `+1` for web
- Main repo defaults: server=3001, web=3000

### 6. db.mjs

```js
import { executeSQL, resolveDbPath } from './lib/db.mjs'

executeSQL(sql, dbPath?) → Promise<string>
resolveDbPath(mode?) → string
```

- Uses `node:child_process.execSync` to call `sqlite3` CLI
- `resolveDbPath` checks: explicit arg → `OCTOPUS_DB_PATH` env → `~/.octopus/db/octopus.db`
- Returns stdout as string

## Self-Test Requirements

Each `.self-test.mjs`:
1. Imports from the corresponding module
2. Runs 2-4 test cases against a live dev server
3. Uses `E2E_HARNESS_TEST_` prefix for all test data
4. Cleans up after itself
5. Prints `PASS`/`FAIL` per test + overall result
6. Exits with code 0 on all pass, 1 on any fail
7. Can be run standalone: `node lib/{module}.self-test.mjs`

## Pattern Guides

Each pattern guide contains:
1. Which lib/ modules to import
2. Common pitfalls and workarounds
3. data-testid selectors to use
4. Copy-paste code snippet
5. When to use / when not to use

## Recipe Template

`recipes/full-lifecycle.mjs` — complete runnable script:
1. Assert server healthy
2. Create workspace
3. Write workflow YAML
4. Create + start execution
5. Poll until completion
6. Verify result
7. Browser screenshot
8. Cleanup
9. Print report

## data-testid Additions

Target: add ≥20 new `data-testid` attributes to web-app components:
- `create-workspace-dialog`: submit button, cancel button, name input, org select
- `workspace-card`: card container, status badge, action menu, delete action
- `workspace-list`: list container, create button
- `workspaces/page`: page header, retry button
- `workspace detail page`: tab navigation, file tree
- `workflow-flow-panel`: additional node-level testids
- Generic dialog buttons: confirm/cancel patterns

## STABLE/DRAFT Evolution Protocol

1. All modules ship as STABLE
2. When a STABLE module needs modification → create `{module}_draft.mjs` copy
3. Debug the draft → run self-test against draft
4. On self-test pass → delivery report includes "replace STABLE with DRAFT" recommendation
5. User has final say on replacement
6. Documented in SKILL.md under "Evolution Protocol" section

## matt-e2e-tester.md Modifications

Add before Step 3 (Execute Tests):
```
### Step 2.5: Load E2E Harness

Check if `.claude/skills/e2e-harness/` exists. If yes:
1. Read `index.md` to discover available STABLE modules
2. Import relevant modules in test scripts instead of writing helpers from scratch
3. Follow pattern guides for common scenarios
4. Use `data-testid` selectors documented in patterns
```

## Non-Goals

- No TypeScript compilation (pure .mjs)
- No Playwright test runner (standalone scripts)
- No modification of existing `packages/web-app/e2e/` tests
- No new top-level directories
