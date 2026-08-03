# Octopus E2E Standards — Project Adaptation of R1-R8

> Base methodology: `matt-e2e-test-methodology/SKILL.md` (R1-R8).
> This file adapts R3 and R5 to Octopus's 4-layer architecture.
> Loaded automatically by `matt-e2e-tester` Step 2.6.

## System Architecture (Data Flow)

Octopus has no Cache layer. Data flows through 4 layers:

```
Trigger (user action / API call)
  → API Response (Hono REST, HTTP JSON)
    → DB Persistence (SQLite: node_executions, agent_events, node_token_usage, ...)
      → SSE Event Stream (real-time push to browser)
        → UI Rendering (React components, flow viewer, execution detail)
```

## R3 Adaptation: Cross-Validation Layers

### Layer Definitions

| Layer | Component | How to Verify | Harness Module |
|-------|-----------|---------------|----------------|
| **API** | Hono REST responses | `fetchJSON()` — check status + business fields | `api.mjs` |
| **DB** | SQLite tables | `querySQL()` — check row existence + field values | `db.mjs` |
| **SSE** | Server-Sent Events | EventSource capture — check event types + payloads | (inline `EventSource`) |
| **UI** | React rendered page | Playwright — screenshot + `data-testid` assertions + console check | `browser.mjs` |

### Minimum Verification Layers by Feature Type

| Feature Type | Required Layers | Recommended Layers |
|-------------|-----------------|-------------------|
| Workflow Execution | API + DB | API + DB + SSE |
| UI Rendering / Display | API + UI | API + DB + UI |
| Real-time Push (SSE) | API + SSE | API + DB + SSE |
| CRUD Operations | API + DB | API + DB |
| Pure API Logic | API + DB | API + DB |

**Rule: Verifying ONLY the API layer does NOT pass R3.**

### DB Layer Verification Checklist

After executing a workflow, query these tables:

```sql
-- 1. Every node has an execution record with correct status
SELECT node_id, status, duration, started_at, completed_at
FROM node_executions
WHERE execution_id = '{execId}'
ORDER BY started_at;
-- Expected: N rows (N = number of nodes in workflow)

-- 2. Agent/bash nodes have event records (non-empty)
SELECT node_execution_id, event_type, content_length
FROM agent_events
WHERE node_execution_id LIKE '{execId}-%'
ORDER BY event_order;
-- Expected: rows for each agent/bash node

-- 3. Agent nodes have token usage records
SELECT node_execution_id, model, input_tokens, output_tokens, cost_usd
FROM node_token_usage
WHERE node_execution_id LIKE '{execId}-%';
-- Expected: rows for each agent node that called an LLM
```

#### Scoped ID Patterns

Some node types create child records with scoped IDs:

| Parent Type | Child ID Pattern | Example |
|-------------|-----------------|---------|
| `sub_workflow` | `{parentId}:{childId}` | `run-child:analyze` |
| `loop` | `{parentId}:{childId}` | `my-loop:inner-agent` |

When verifying these, query with `LIKE '{execId}-{parentId}:%'` to find child records.

### UI Layer Verification Checklist

```js
// 1. Navigate to target page
await page.goto(`${webUrl}/workspaces/${wsId}?tab=detail&execId=${execId}`)

// 2. Wait for core component to load
await page.waitForSelector('[data-testid="flow-viewer"]', { timeout: 10000 })

// 3. Capture console for JS errors
const console = captureConsole(page)

// 4. Take screenshot as evidence
await takeScreenshot(page, 'execution-detail', screenshotDir)

// 5. Assert key elements exist
const nodes = await page.$$('[data-testid="flow-node"]')
assert(nodes.length > 0, 'Flow should have rendered nodes')

// 6. Check no JS errors
assert(console.errors.length === 0, `JS errors: ${console.errors.join(', ')}`)
```

### SSE Layer Verification (if applicable)

```js
// Connect SSE before triggering action
const events = []
const wsId = `${org}:${workspacePath}`
const es = new EventSource(`${apiUrl}/api/sse/${encodeURIComponent(wsId)}`)
es.onmessage = (e) => {
  const data = JSON.parse(e.data)
  events.push(data)
}

// Trigger action
await startExecution(wsId, execId)
await pollExecution(wsId, execId)

// Wait for SSE buffer
await new Promise(r => setTimeout(r, 2000))
es.close()

// Assert event sequence
assert(events.some(e => e.event === 'node_start'), 'Should have node_start events')
assert(events.some(e => e.event === 'node_end'), 'Should have node_end events')
```

## R5 Adaptation: Side Effects Verification

After an execution operation, verify these DB changes:

| Operation | Required DB Side Effects |
|-----------|------------------------|
| Execute workflow | `node_executions` has N rows (N = node count in YAML) |
| Execute agent node | `agent_events` has events + `node_token_usage` has row |
| Execute bash node | `agent_events` has `bash_log` events |
| Execute python node | `agent_events` has `python_log` events |
| Execute sub_workflow | Child node scoped IDs exist in `node_executions` |
| Execute loop node | Each iteration's inner nodes exist in `node_executions` |
| Execute swarm node | `agent_events` has swarm events (dispatch/consensus/etc.) |
| Execute condition node | `node_executions` status reflects branch taken |
| Execute approval node | `node_executions` status = `pending_approval` until approved |

**Rule: Checking only the API response `status` field does NOT pass R5.**

## Cross-Validation Evidence Table

Every AC in the E2E report must include this table:

| AC | API Evidence | DB Evidence | SSE Evidence | UI Evidence | Layers Verified |
|----|-------------|-------------|-------------|-------------|----------------|
| AC-1 | HTTP 200, status=completed | node_executions: 3 rows, all completed | — (not applicable) | screenshot: flow shows 3 nodes | API+DB+UI (3) |
| AC-2 | HTTP 200, var_pool.greeting=hello | var_pool: greeting=hello | — | — | API+DB (2) |

### Evidence Table Rules

1. **"—"** means the layer is not applicable or intentionally skipped — **must state reason**
2. **Execution ACs**: API + DB is minimum. Without DB evidence → mark as **SKIP**
3. **UI rendering ACs**: Browser layer is required. Without UI evidence → mark as **SKIP**
4. **API-only evidence**: Downgrade to **PARTIAL**, does not count as PASS
5. **Layers Verified** column: list which layers were checked and the count
