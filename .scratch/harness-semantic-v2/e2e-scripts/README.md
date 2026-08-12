# Harness Semantic V2 — E2E Integration Tests

This directory contains end-to-end test scripts for verifying the Harness Semantic V2 feature (Ticket 08).

## Test Coverage

| AC | Test | Description | Workflow |
|----|------|-------------|----------|
| AC1 | Process Conflict | Node blocked + harness_status = "blocked" | test-process-conflict |
| AC2 | Stupid Retry | Harness Agent intervenes + harness_status = "intervened" | test-stupid-retry |
| AC3 | Timeout Cascade | Harness Agent intervenes (not advisory) | test-timeout-cascade |
| AC4 | Agent Tool Interceptor | Block + guide + resume → completed | test-agent-tool-interceptor |
| AC5 | Execution List API | Returns harnessStatus field | Any execution |
| AC6 | Agent Events Decision | Contains decision field | Intervened executions |
| AC7 | Session Context | Maintains context across interventions | Intervened executions |

## Prerequisites

- Server running: `pnpm dev`
- Test workspace `test-harness` exists
- Test workflows available in workspace

## Running Tests

### Option 1: Shell Script (curl-based)

```bash
cd .scratch/harness-semantic-v2/e2e-scripts
chmod +x run-e2e-tests.sh
./run-e2e-tests.sh

# Custom server URL
SERVER_URL=http://localhost:3001 ./run-e2e-tests.sh

# Custom workspace ID
WORKSPACE_ID=<uuid> ./run-e2e-tests.sh

# Verbose output
VERBOSE=1 ./run-e2e-tests.sh
```

**Exit codes:**
- `0` = all tests passed
- `1` = one or more tests failed
- `2` = server not reachable (tests skipped)

### Option 2: Vitest (Node.js-based)

```bash
# From project root
RUN_E2E_HARNESS=1 pnpm vitest run packages/server/src/__tests__/harness-e2e-semantic-v2.test.ts

# Custom server URL
RUN_E2E_HARNESS=1 SERVER_URL=http://localhost:3001 pnpm vitest run packages/server/src/__tests__/harness-e2e-semantic-v2.test.ts
```

**Note:** Without `RUN_E2E_HARNESS=1`, tests are skipped gracefully.

## Test Workflows

### test-process-conflict.yaml

Tests detection and blocking of dangerous bash commands (e.g., `kill $HOST_PID`).

**Expected behavior:**
1. Node `bash-kill-host` attempts to kill host process
2. Harness detects dangerous pattern → blocks node
3. Execution harness_status = "blocked"
4. Log shows: 🛡️❌ Harness 阻断: process_conflict

### test-stupid-retry.yaml

Tests intelligent retry when a node fails with the same error repeatedly.

**Expected behavior:**
1. Node `bash-fail` fails 3 times with same error
2. Harness Agent analyzes root cause
3. Decision: fix_and_retry or guide_and_retry
4. Execution harness_status = "intervened"
5. Log shows: 🛡️🔧 or 🛡️💬

### test-timeout-cascade.yaml

Tests handling of consecutive node timeouts.

**Expected behavior:**
1. Nodes `timeout-1`, `timeout-2`, `timeout-3` all timeout
2. Harness Agent intervenes (not advisory)
3. Decision: guide_and_retry with optimization hints
4. Execution harness_status = "intervened"
5. Log shows: 🛡️💬 Harness 指导重试: timeout_cascade

### test-agent-tool-interceptor.yaml

Tests agent node tool interception for dangerous bash commands.

**Expected behavior:**
1. Agent node `run-e2e-tests` attempts `pnpm dev`
2. Tool interceptor detects host port conflict
3. Blocks tool call, pauses agent session
4. Harness Agent guides: "use pnpm dev --isolated"
5. Agent resumes with safer command
6. Execution harness_status = "intervened"

## API Endpoints Tested

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/workspaces/:id/executions` | Create execution |
| POST | `/api/workspaces/:id/executions/:execId/start` | Start execution |
| GET | `/api/workspaces/:id/executions/:execId` | Get execution detail |
| GET | `/api/workspaces/:id/executions` | List executions |
| GET | `/api/workspaces/:id/executions/:execId/agent-events` | Get agent events |

## Harness Status Values

### Execution-level (`executions.harness_status`)

- `NULL` — No harness intervention
- `intervened` — Harness intervened but execution completed
- `blocked` — At least one node was blocked
- `delegated` — Agent takeover occurred

### Node-level (`node_executions.harness_status`)

- `NULL` — No harness intervention
- `harness_modified` — Node was modified by harness (fix_and_retry, guide_and_retry)
- `harness_executed` — Node was executed by Harness Agent (agent_takeover)
- `harness_blocked` — Node was blocked by harness (block_node)

## Decision Types

| Decision | Description | Log Icon |
|----------|-------------|----------|
| `fix_and_retry` | Modify variables/config, retry | 🛡️🔧 |
| `guide_and_retry` | Inject guidance, retry | 🛡️💬 |
| `reconfigure_and_retry` | Switch model/config, retry | 🛡️🔄 |
| `agent_takeover` | Agent completes node work | 🤖✅ |
| `block_node` | Block node execution | 🛡️❌ |

## Troubleshooting

### Server not reachable
- Start server: `pnpm dev`
- Check port: default 3001
- Verify health: `curl http://localhost:3001/api/health`

### Test workspace not found
- Create workspace via UI or API
- Workspace ID: `e6d714bf-ed74-4041-ad56-2ccc82acd16b`

### Test workflows missing
- Copy from `.scratch/harness-semantic-v2/e2e-scripts/workflows/`
- Or from `packages/engine/src/__tests__/fixtures/`
- Place in workspace's `workflows/` directory

### Tests timeout
- Increase `MAX_POLL_SECONDS` in shell script
- Increase `MAX_POLL_MS` in Vitest config
- Check server logs for execution errors

## Cleanup

Tests attempt to clean up execution data after each test. If cleanup fails:

```bash
# Manual cleanup via API
curl -X DELETE http://localhost:3001/api/workspaces/<ws-id>/executions/<exec-id>
```

Or delete from database:

```bash
sqlite3 ~/.octopus/db/octopus.db
DELETE FROM executions WHERE workflow_ref LIKE 'test-%';
DELETE FROM node_executions WHERE execution_id IN (SELECT id FROM executions WHERE workflow_ref LIKE 'test-%');
DELETE FROM agent_events WHERE execution_id IN (SELECT id FROM executions WHERE workflow_ref LIKE 'test-%');
```

## Notes

- Tests are designed to be idempotent — can be run multiple times
- Each test creates a new execution and cleans up after itself
- Tests AC5-AC7 depend on data from AC1-AC4 — run in order
- Shell script uses `jq` for JSON parsing — install if missing: `apt-get install jq` or `brew install jq`
