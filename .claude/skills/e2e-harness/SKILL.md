---
name: e2e-harness
description: Reusable E2E testing library + pattern guides for Octopus web-app testing. Provides 6 STABLE lib modules, self-tests, patterns, and recipes.
tools: ["Read", "Write", "Edit", "Bash", "Grep", "Glob"]
---

# E2E Harness

Reusable E2E testing skill for Octopus. Replaces per-feature script duplication with composable STABLE modules.

## Quick Start

Import modules directly from the lib directory:

```js
import { fetchJSON, healthCheck, resolveApiUrl } from "./lib/api.mjs"
import { createWorkspace, cleanupWorkspace } from "./lib/workspace.mjs"
import { createExecution, pollExecution } from "./lib/execution.mjs"
import { launchBrowser, takeScreenshot, closeBrowser } from "./lib/browser.mjs"
import { createResults, record, printReport } from "./lib/reporter.mjs"
import { resolveDbPath, querySQL } from "./lib/db.mjs"
```

All modules are ESM (`.mjs`). No build step required. Run with `node --experimental-vm-modules` or any modern Node 20+ runtime.

## Module Reference

| Module | Status | Purpose |
|--------|--------|---------|
| `api.mjs` | STABLE | Unified HTTP client + port resolution |
| `workspace.mjs` | STABLE | Workspace lifecycle CRUD |
| `execution.mjs` | STABLE | Workflow execution + polling |
| `browser.mjs` | STABLE | Playwright browser management |
| `reporter.mjs` | STABLE | Test result recording + reporting |
| `db.mjs` | STABLE | SQLite CLI execution |

See `index.md` for the full module registry with exports and self-test paths.

## API Reference

### api.mjs

| Function | Signature | Description |
|----------|-----------|-------------|
| `fetchJSON` | `(urlOrPath, options?) => Promise<{ok, status, data, text}>` | JSON HTTP request to Octopus API |
| `healthCheck` | `(apiUrl?) => Promise<boolean>` | Check if the server is healthy |
| `resolveApiUrl` | `() => string` | Get API base URL (e.g. `http://localhost:3001`) |
| `resolveWebUrl` | `() => string` | Get web app base URL (e.g. `http://localhost:3000`) |
| `resolvePorts` | `() => {server: number, web: number}` | Resolve server and web ports |

### workspace.mjs

| Function | Signature | Description |
|----------|-----------|-------------|
| `createWorkspace` | `(name, org?, repos?) => Promise<{id, name, org, path}>` | Create a test workspace |
| `cleanupWorkspace` | `(id) => Promise<boolean>` | Delete a workspace (idempotent) |
| `listWorkspaces` | `() => Promise<Array>` | List all workspaces |
| `getWorkspace` | `(id) => Promise<object>` | Get workspace details |
| `cleanupAllTestWorkspaces` | `() => Promise<number>` | Delete all `E2E_HARNESS_TEST_` workspaces |

### execution.mjs

| Function | Signature | Description |
|----------|-----------|-------------|
| `createExecution` | `(workspaceId, workflowRef, name?) => Promise<{id, status}>` | Create an execution |
| `startExecution` | `(workspaceId, executionId) => Promise<boolean>` | Start an execution |
| `pollExecution` | `(workspaceId, executionId, maxWaitMs?, intervalMs?) => Promise<object>` | Poll until terminal status or timeout |
| `getExecution` | `(workspaceId, executionId) => Promise<object>` | Get execution details |
| `createWorkflow` | `(workspaceId, ref, content) => Promise<object>` | Create a workflow via API |
| `pauseExecution` | `(workspaceId, executionId) => Promise<boolean>` | Pause a running execution |
| `resumeExecution` | `(workspaceId, executionId) => Promise<boolean>` | Resume a paused execution |
| `getExecutionTree` | `(workspaceId) => Promise<Array>` | Get all executions for a workspace |

### browser.mjs

| Function | Signature | Description |
|----------|-----------|-------------|
| `launchBrowser` | `(options?) => Promise<{browser, context, page}>` | Launch Playwright chromium |
| `takeScreenshot` | `(page, name, dir?, options?) => Promise<string>` | Screenshot current page |
| `captureConsole` | `(page) => {errors, warnings, all}` | Capture browser console output |
| `navigateTo` | `(page, url, options?) => Promise<void>` | Navigate and wait for ready |
| `wait` | `(ms) => Promise<void>` | Wait for a duration |
| `closeBrowser` | `(browser) => Promise<void>` | Close browser instance |
| `clickByTestId` | `(page, testId, options?) => Promise<boolean>` | Click element by `data-testid` |
| `fillByTestId` | `(page, testId, value, options?) => Promise<boolean>` | Fill input by `data-testid` |
| `getTextByTestId` | `(page, testId, options?) => Promise<string\|null>` | Get text by `data-testid` |

### reporter.mjs

| Function | Signature | Description |
|----------|-----------|-------------|
| `createResults` | `() => Array` | Create empty results array |
| `record` | `(results, step, pass, detail?) => void` | Record a step result |
| `printReport` | `(results, options?) => {total, passed, failed, allPass}` | Print formatted report |
| `saveResults` | `(results, filePath) => string` | Save results to JSON file |
| `assertAllPass` | `(results, message?) => void` | Throw if any step failed |
| `exitWithResults` | `(results, options?) => void` | Print report and exit with code |

### db.mjs

| Function | Signature | Description |
|----------|-----------|-------------|
| `resolveDbPath` | `(dbPath?, mode?) => string` | Resolve SQLite DB path |
| `executeSQL` | `(sql, dbPath?, options?) => {rows, ok, error}` | Execute SQL statement |
| `querySQL` | `(sql, dbPath?, options?) => {data, ok, error}` | Execute query, parse to objects |
| `listTables` | `(dbPath?) => string[]` | List database tables |

## Data Conventions

- **Test prefix**: `E2E_HARNESS_TEST_` — auto-applied to workspace names by `workspace.mjs`
- **Port resolution**: reads `~/.octopus/ports/{branch-safe}.json` (written by `dev.mjs`), falls back to hash-based offset from 3100
- **Screenshots**: saved to `$E2E_ARTIFACTS_DIR/e2e-screenshots/` when env var is set, otherwise `./e2e-screenshots/` (configurable per call via `dir` param)
- **DB path**: `~/.octopus/db/octopus.db` (dev), `octopus-{branch}.db` (worktree), `octopus-prod.db` (prod)
- **Execution names**: `E2E_HARNESS_TEST_exec_{timestamp}` when no name is provided

## Evolution Protocol (STABLE / DRAFT)

Modules follow a two-state lifecycle:

1. **DRAFT** — under development, filename has `_draft` suffix (e.g. `auth_draft.mjs`). Has a self-test but it may fail. Do NOT import in production tests.
2. **STABLE** — self-test passes, listed in `index.md`, safe to import. Promoted from DRAFT after self-test passes 3 consecutive runs.

Rules:
- New modules start as DRAFT
- To modify a STABLE module, create a `{name}_draft.mjs` copy first — never edit STABLE directly
- STABLE modules must not have breaking API changes without a migration path
- Deprecation: mark as `DEPRECATED` in `index.md` for one cycle, then remove

## Running Self-Tests

Each module has a co-located self-test file:

```bash
# Run individual self-tests
node .claude/skills/e2e-harness/lib/api.self-test.mjs
node .claude/skills/e2e-harness/lib/workspace.self-test.mjs
node .claude/skills/e2e-harness/lib/execution.self-test.mjs
node .claude/skills/e2e-harness/lib/browser.self-test.mjs
node .claude/skills/e2e-harness/lib/reporter.self-test.mjs
node .claude/skills/e2e-harness/lib/db.self-test.mjs
```

Self-tests require a running Octopus server. Start one first:

```bash
pnpm dev        # main repo: server on 3001, web on 3000
# or
pnpm dev --isolated   # worktree: auto-assigned ports
```

Self-tests are non-destructive: they create resources with the `E2E_HARNESS_TEST_` prefix and clean up after themselves.

## Pattern Guides

Reusable test patterns in `patterns/`:

| Pattern | Description |
|---------|-------------|
| `workspace-create` | Create workspace, verify structure, cleanup |
| `workflow-execute` | Create workflow, execute, poll to completion |
| `dialog-interact` | Open dialog, fill fields, submit, verify |
| `tab-switch` | Navigate tabs, verify content per tab |
| `file-tree-ops` | Interact with file tree: expand, select, verify |

## Directory Structure

```
e2e-harness/
├── SKILL.md          ← this file
├── index.md          ← module registry
├── lib/              ← STABLE modules + self-tests
│   ├── api.mjs
│   ├── api.self-test.mjs
│   ├── workspace.mjs
│   ├── workspace.self-test.mjs
│   ├── execution.mjs
│   ├── execution.self-test.mjs
│   ├── browser.mjs
│   ├── browser.self-test.mjs
│   ├── reporter.mjs
│   ├── reporter.self-test.mjs
│   ├── db.mjs
│   └── db.self-test.mjs
├── patterns/         ← reusable test patterns
├── recipes/          ← end-to-end test recipes
├── tests/            ← integration test scripts
└── baselines/        ← screenshot baselines
```
