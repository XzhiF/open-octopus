# Ticket 6: Workflow Ops API — External Workflow Control Endpoints

## Summary
Create a new `workflow-ops` route that exposes workflow execution query and control endpoints. These are designed for external consumers (chatbot skill, CLI tools) to inspect and manage running workflows.

## Scope

### 6.1 Route File (`packages/server/src/routes/workflow-ops.ts`)

```typescript
import { Hono } from "hono"

const workflowOps = new Hono()

// GET /executions — List executions (?status=running filter)
workflowOps.get("/executions", async (c) => {
  const workspaceId = c.req.param("id")
  const status = c.req.query("status")
  // Delegate to ExecutionDAO.listByWorkspace(workspaceId, { status })
  // Return Execution[]
})

// GET /executions/:execId/status — Execution status overview
workflowOps.get("/executions/:execId/status", async (c) => {
  const { execId } = c.req.param()
  // Get execution + node executions
  // Return { status, progress, currentNode, nodeCount, ... }
})

// POST /executions/:execId/abort — Abort execution
workflowOps.post("/executions/:execId/abort", async (c) => {
  const { execId } = c.req.param()
  // Call ExecutionLifecycle.abort(execId)
  // Return { ok: true }
})

// GET /executions/:execId/nodes/:nodeId/events — Node events
workflowOps.get("/executions/:execId/nodes/:nodeId/events", async (c) => {
  const { execId, nodeId } = c.req.param()
  // Query agent_events for the node_execution_id
  // Return AgentEvent[]
})
```

### 6.2 Route Registration

```typescript
// In chain-routes.ts or workspace.ts
import workflowOps from "./workflow-ops"
app.route("/api/workspaces/:id/workflows", workflowOps)
```

### 6.3 Service Resolution

Reuse existing `ExecutionDAO`, `ExecutionLifecycle`, and agent event queries. No new services needed.

## Files to Create
- `packages/server/src/routes/workflow-ops.ts`

## Files to Modify
- `packages/server/src/routes/chain-routes.ts` (or equivalent) — register route

## Verification
- [ ] `pnpm build` passes
- [ ] GET /executions returns execution list
- [ ] POST /abort terminates a running execution
