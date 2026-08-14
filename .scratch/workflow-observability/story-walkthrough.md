# Story Walk-Through Analysis: Workflow Execution Observability

> **Analyst**: Story Walk-Through Sub-Agent
> **Spec version**: `.scratch/workflow-observability/spec.md`
> **Date**: 2026-08-12
> **Method**: Protocol at `.claude/skills/matt-verified-requirement/references/story-walkthrough.md`

---

## Executive Summary

Traced all 4 appendix stories step-by-step against the live codebase.
Discovered **19 break points**: **5 CRITICAL**, **7 HIGH**, **5 MEDIUM**, **2 LOW**.

The five most severe issues:

1. **Budget snapshot never written** — No code path extracts `budget` from the parsed workflow YAML and persists it to `executions.budget_snapshot`. The spec assumes this happens at execution start but provides no mechanism.
2. **`execution_metrics` SSE event has no producer** — The spec defines this new event type but no server-side code computes cumulative aggregates or emits it.
3. **Floating panel is deaf to execution metrics** — `useHarnessEvents` hook only listens for `harness_*` SSE events (diagnosis/intervention/delegation/blocked). It has zero awareness of `node_end`, `execution_metrics`, or any token/cost data from the execution itself.
4. **Observability API endpoint doesn't exist** — The spec defines `GET /executions/:eid/observability` but there's no route, no service method, and no aggregation query.
5. **`status_change` is dead code** — The spec references `SSE: status_change(budget_exceeded)` but `status_change` is defined in the shared schema and NEVER emitted by the server. The server uses `execution_status` + `execution_progress` instead. The spec must use the correct event name.

---

## Story 1: Real-time Observation During Execution

### Step-by-Step Trace

```
1. User triggers workflow execution from workspace detail page
  |
  +--[UI] WorkflowDetailPanel renders "Start" button
  |         OK Code exists: workflow-detail-panel.tsx
  |
  +--[API] POST /api/workspaces/:id/executions
  |         body: { workflow_ref, name, input_values }
  |         OK Code exists: routes/execution.ts:70-119
  |
  +--[Data] ExecutionDAO creates row in executions table
  |         Fields: id, workspace_id, workflow_ref, status='pending', ...
  |         ← [BP-A] ORPHAN FIELD: executions.budget_snapshot column
  |           doesn't exist yet (migration needed), AND even after
  |           migration, no code in the POST handler or create()
  |           method reads workflow.budget to populate it.
  |           The spec says "execution starts → budget_snapshot written"
  |           but provides no bridge from parsed YAML to DB write.
  |
2. ExecutionLifecycle.start() reads workflow YAML
  |
  +--[Exec] this.getWorkflow(exec.workflow_ref) → { parsed: WorkflowDef, content: string }
  |         OK Code exists: ExecutionLifecycle.ts:197
  |
  +--[Exec] wf.parsed now has .budget field (after shared schema change)
  |         ← [BP-B] MAGIC BRIDGE: wf.parsed.budget exists in memory
  |           but NO code between line 197 and engine creation (line 277)
  |           extracts it and writes to DB. The spec's data flow diagram
  |           shows "执行开始快照" but the implementation path is missing.
  |           FIX: After line 197, add:
  |             if (wf.parsed.budget) {
  |               dao.updateExecution(id, { budget_snapshot: JSON.stringify(wf.parsed.budget) })
  |             }
  |
3. Engine created and starts executing nodes
  |
  +--[Exec] engineFactory.createEngine(updatedExec, wf.parsed, callbacks, signal)
  |         OK Code exists: ExecutionLifecycle.ts:277
  |         Note: Engine constructor receives workflow (WorkflowDef) which
  |         will include .budget after shared change. Engine doesn't need
  |         a separate budget parameter if server handles snapshot+enforcement.
  |
  +--[Exec] Node 1 (agent) begins execution
  |
  +--[Event] SSE: node_start { executionId, nodeId, nodeType }
  |         OK Code exists: EngineCallbacks.ts:78
  |
  +--[Exec] Node 1 LLM calls, tokens consumed
  |         OK BudgetTracker in swarm, heartbeat in octopus_agent
  |
  +--[Event] SSE: node_end { executionId, nodeId, status, costUsd, turnCount, tokens }
  |         OK Code exists: EngineCallbacks.ts:142-158
  |
  +--[Event] SSE: execution_metrics (cumulative totals)
  |         ← [BP-C] MISSING TRIGGER: This event type does not exist.
  |           No code in EngineCallbacks.ts computes cumulative sums
  |           after node_end. The onNodeEnd callback writes token data
  |           to node_token_usages table (line 96-104) but does NOT
  |           query aggregate totals and emit execution_metrics.
  |           FIX: After the node_end SSE emit (line 158), add:
  |             const metrics = computeExecutionMetrics(id)  // new function
  |             sse.emit(wsId, { event: 'execution_metrics', data: metrics })
  |
  +--[UI] Floating panel summary cards update in real-time
  |         ← [BP-D] UNCONNECTED FEEDBACK: The floating panel's
  |           useHarnessEvents hook (hooks/use-harness-events.ts)
  |           ONLY listens for 4 harness event types:
  |             harness_diagnosis, harness_intervention,
  |             harness_delegation, harness_blocked
  |           It does NOT listen for node_start, node_end, or
  |           execution_metrics. The 4 summary cards (total token,
  |           total turns, budget progress, error count) described in
  |           US-1 have NO data source in the current hook.
  |           FIX: Either extend useHarnessEvents or create a new
  |           useExecutionMetrics hook that subscribes to
  |           execution_metrics SSE events.
  |
4. User clicks "Details" → navigates to observability page
  |
  +--[UI] Floating panel "Details" button
  |         ← [BP-E] MISSING TRIGGER: No "Details" button exists
  |           in the current HarnessFloatingPanel component.
  |           The panel has: collapsed view, expanded view with tabs
  |           (Monitor, Chatbot), but no "details" link/button.
  |           The spec says "点击浮动面板的'详情'" but doesn't
  |           specify WHERE this button goes in the panel layout.
  |           FIX: Add a "观测详情" button in the expanded Monitor tab.
  |
  +--[UI] Navigate to /workspaces/:id/executions/:eid/observability
  |         ← [BP-F] ORPHAN FIELD: This route doesn't exist.
  |           Current routing: app/workspaces/[id]/page.tsx is the
  |           workspace detail page. Execution details are shown in
  |           WorkflowDetailPanel WITHIN the workspace page, not as
  |           a separate route. The spec proposes a new Next.js page
  |           at app/workspace/[id]/executions/[eid]/observability/page.tsx
  |           (note: "workspace" singular vs actual "workspaces" plural).
  |           FIX: Create the page at the correct path with "workspaces" plural.
  |
5. GET /executions/:eid/observability
  |
  +--[API] Observability endpoint returns ObservabilityData
  |         ← [BP-G] MISSING TRIGGER: No such route exists in
  |           executionRoutes. The spec defines the full response
  |           interface but no route handler, no service method,
  |           and no SQL aggregation queries.
  |           FIX: Add route to executionRoutes + new ObservabilityQueryService.
  |
  +--[Data] Aggregation queries across node_token_usages, llm_calls, node_executions
  |         ← [BP-H] SILENT FAILURE: node_token_usages links to
  |           node_execution_id, NOT execution_id. To aggregate by
  |           execution, need JOIN: node_token_usages → node_executions
  |           → executions. The spec's "新增聚合查询" section shows
  |           SUM(node_token_usages.input_tokens) by execution_id but
  |           this column doesn't exist on node_token_usages.
  |           llm_calls DOES have execution_id directly, so token
  |           aggregation should prefer llm_calls over node_token_usages
  |           for the execution-level view.
  |           FIX: Use llm_calls for execution-level aggregation.
  |                  Use node_token_usages joined through node_executions
  |                  as fallback when llm_calls_persist flag is off.
  |
  +--[UI] Charts render (line chart, bar chart, pie chart)
            OK Recharts is available (execution-histogram.tsx uses it).
            Other charts use custom SVG. Both approaches work.
```

### Break Points Summary (Story 1)

| ID | Severity | Type | Description |
|----|----------|------|-------------|
| BP-A | CRITICAL | Orphan Field | `budget_snapshot` column not in schema; no code writes it |
| BP-B | CRITICAL | Magic Bridge | `wf.parsed.budget` read but never persisted |
| BP-C | CRITICAL | Missing Trigger | `execution_metrics` SSE event has no producer |
| BP-D | CRITICAL | Unconnected Feedback | Floating panel hook deaf to execution events |
| BP-E | HIGH | Missing Trigger | No "Details" button in floating panel |
| BP-F | HIGH | Orphan Field | Observability page route doesn't exist; path typo (workspace vs workspaces) |
| BP-G | HIGH | Missing Trigger | Observability API endpoint not implemented |
| BP-H | HIGH | Magic Bridge | Aggregation query assumes execution_id on node_token_usages (wrong table) |

---

## Story 2: Budget Warning + Blocking

### Step-by-Step Trace

```
1. User creates workflow with budget: { max_tokens: 5000 }
  |
  +--[Data] Workflow YAML parsed → WorkflowDef.budget
  |         OK After shared schema change
  |
2. POST /executions → execution created
  |
  +--[Data] budget_snapshot = { "max_tokens": 5000 }
  |         ← [BP-A repeated] Same as Story 1 — no code writes this.
  |
3. Node 1 (agent) executes, consumes 4200 tokens
  |
  +--[Event] SSE: node_end { tokens: { input: 3000, output: 1200 } }
  |         OK Existing code
  |
  +--[Event] SSE: execution_metrics { tokensPercent: 84% }
  |         ← [BP-C repeated] Event doesn't exist.
  |
  +--[Server] Detect token > 5000 * 0.8 → trigger notification
  |         ← [BP-I] MISSING TRIGGER: No code in EngineCallbacks.ts
  |           or anywhere else checks cumulative tokens against
  |           budget_snapshot after node_end. The spec says this
  |           happens "在 node_end 回调中" but the current onNodeEnd
  |           callback (EngineCallbacks.ts:83-159) does:
  |             1. Update node_execution status
  |             2. Insert token usage rows
  |             3. Emit node_end SSE
  |           No budget check. No notification trigger.
  |           FIX: After token usage insertion, add:
  |             const budget = JSON.parse(exec.budget_snapshot ?? '{}')
  |             if (budget.max_tokens) {
  |               const totalTokens = sumTokensForExecution(id)
  |               if (totalTokens > budget.max_tokens * threshold) { ... }
  |             }
  |
  +--[Notify] Hermes sends warning message
  |         ← [BP-J] MAGIC BRIDGE: Spec says "通过 agent notify 模块
  |           发送通知（通知渠道读取 main agent 配置）" but:
  |           - "main agent 配置" is ambiguous. Which agent? The
  |             workspace's main agent session? The system agent config?
  |           - There are THREE separate notification systems in the codebase:
  |             1. Engine notify module (engine/src/notify/) — dispatches
  |                via workflow YAML hooks (providers/channels/templates)
  |                using HermesProvider (shells to `hermes send`)
  |             2. Agent NotificationService (server/services/agent/) —
  |                for octo-agent system; reads config from ConfigManager
  |             3. Scheduler NotificationService (server/services/notification.ts)
  |                — for scheduled execution failures only
  |           - The spec doesn't specify WHICH system to use.
  |           FIX: Use the ENGINE notify module (option 1) since budget
  |           config lives in the workflow YAML alongside providers/channels.
  |           The notification channel is defined in the same YAML file.
  |           If no `providers` configured, log warning and skip.
  |
4. Node 1 completes, cumulative 4800 tokens
  |
5. Node 2 about to start → check cumulative > max_tokens → block
  |
  +--[Exec] Budget check before node 2
  |         ← [BP-K] SILENT FAILURE: The spec says "下一个节点开始前
  |           阻断" but the engine's onBeforeNode callback (engine.ts:863)
  |           is currently used ONLY by the harness system. Adding a
  |           second consumer (budget enforcement) to onBeforeNode
  |           creates ordering questions:
  |           - Does budget check run before or after harness onBeforeNode?
  |           - If harness says "skip" and budget says "block", which wins?
  |           - The onBeforeNode proxy in detector-pipeline.ts (line 395)
  |             wraps the original callback. Budget check would need to
  |             be injected BEFORE the harness wrapping.
  |
  |         ← [BP-T] SILENT FAILURE: onBeforeNode only fires for
  |           TOP-LEVEL nodes in executeSingleNode(). Loop inner nodes
  |           are executed by LoopExecutor.execute() which calls
  |           createExecutor() directly (loop.ts:209), bypassing
  |           onBeforeNode entirely. This means:
  |           - Budget enforcement CANNOT block individual iterations
  |             inside a loop node
  |           - A loop could consume 10× the budget before the NEXT
  |             top-level node's onBeforeNode catches it
  |           FIX: Spec should acknowledge this limitation:
  |           "Budget enforcement operates at top-level node boundaries.
  |           For loop nodes, budget is checked before the loop starts
  |           and after it completes, not per-iteration.
  |           For per-iteration budget control, use the existing
  |           swarm `budget` field or octopus_agent `task.budget`."
  |           FIX: Add budget check as a separate callback
  |           (onBeforeNodeBudget) or as the FIRST check inside
  |           the existing onBeforeNode wrapper, before harness pipeline.
  |
  +--[Event] SSE: status_change { status: "budget_exceeded" }
  |         ← [BP-L] UNVERSIONED STATE: "budget_exceeded" is not in
  |           the engine's execution status vocabulary. Current statuses:
  |           pending, running, completed, failed, paused, cancelled, skipped.
  |           Adding "budget_exceeded" requires:
  |             1. Engine status enum update
  |             2. ExecutionLifecycle.updateStatus() handling
  |             3. Frontend status badge rendering
  |             4. DB status column accepts new value (TEXT, so no migration)
  |           The spec doesn't address any of these.
  |           NOTE: "budget_exceeded" DOES exist at the node level
  |           (StructuredResultStatus in octopus-agent executor) but
  |           has never been promoted to execution-level status.
  |           FIX: Add "budget_exceeded" to status handling in
  |           ExecutionLifecycle, frontend status badges, and ensure
  |           the engine's onComplete callback fires with this status.
  |
  |         ← [BP-S] CRITICAL: The spec says "SSE: status_change"
  |           but `status_change` is DEAD CODE in the shared schema.
  |           The server NEVER emits `status_change` events. Instead:
  |             - ExecutionLifecycle.updateStatus() emits `execution_status`
  |             - Engine onStatusChange emits `execution_progress`
  |           The spec must use `execution_status` as the event name.
  |           FIX: Replace "SSE: status_change(budget_exceeded)" with
  |           "SSE: execution_status { executionId, status: 'budget_exceeded' }"
  |
  +--[UI] Floating panel budget card shows red + "已超限"
            ← [BP-D repeated] Panel can't see execution metrics.
```

### Break Points Summary (Story 2)

| ID | Severity | Type | Description |
|----|----------|------|-------------|
| BP-I | CRITICAL (new) | Missing Trigger | No budget threshold check after node_end |
| BP-J | HIGH | Magic Bridge | Three separate notification systems exist; spec says "main agent 配置" but doesn't specify which |
| BP-K | HIGH | Silent Failure | Budget enforcement in onBeforeNode conflicts with harness ordering |
| BP-L | HIGH | Unversioned State | "budget_exceeded" not in execution status vocabulary (exists only at node level) |
| BP-S | CRITICAL (new) | Unconnected Feedback | Spec references `status_change` SSE event but it's dead code; server uses `execution_status` |
| BP-T | HIGH | Silent Failure | `onBeforeNode` doesn't fire for inner loop nodes; budget can't be checked per-iteration |

---

## Story 3: Historical Analysis After Execution

### Step-by-Step Trace

```
1. User selects a completed execution
  |
  +--[UI] Execution list in workspace detail page
  |         OK Code exists: workflow-detail-panel.tsx
  |
  +--[UI] User clicks execution → detail panel shows
  |         OK WorkflowDetailPanel renders execution detail
  |
2. User navigates to observability page
  |
  +--[UI] "观测详情" button or link
  |         ← [BP-E repeated] No button exists to navigate.
  |
  +--[UI] Observability detail page renders
  |         ← [BP-F repeated] Route doesn't exist.
  |
3. GET /executions/:eid/observability
  |
  +--[API] Returns full ObservabilityData
  |         ← [BP-G repeated] Endpoint doesn't exist.
  |
  +--[Data] Query tokens, byNode, byModel, timeSeries, errors, rounds
  |         |
  |         +-- tokens: SUM from llm_calls WHERE execution_id = :eid
  |         |   OK Feasible — llm_calls has execution_id
  |         |
  |         +-- byNode: JOIN node_executions + llm_calls GROUP BY node_id
  |         |   OK Feasible
  |         |
  |         +-- byModel: GROUP BY model from llm_calls
  |         |   OK Feasible
  |         |
  |         +-- timeSeries: SELECT timestamp, cumulative sums from llm_calls
  |         |   OK Feasible — llm_calls has timestamp column
  |         |
  |         +-- errors: ???
  |         |   ← [BP-M] ORPHAN FIELD: The spec's errors array has:
  |         |     errorType: 'timeout' | 'model_error' | 'script_error' |
  |         |                'approval_rejected' | 'other'
  |         |     But there's no error classification system anywhere.
  |         |     node_executions.error is a free-text string.
  |         |     agent_events has error_code and error_message fields.
  |         |     No mapping from raw error text to the 5 error types.
  |         |     FIX: Define classification function:
  |         |       mapErrorToType(error: string, nodeType: string): ErrorType
  |         |       - 'timeout' if error contains 'timeout' or 'timed out'
  |         |       - 'model_error' if error contains 'model' or 'rate_limit'
  |         |       - 'approval_rejected' if status='rejected'
  |         |       - 'script_error' if nodeType='bash'|'python' + exit_code!=0
  |         |       - 'other' as fallback
  |         |
  |         +-- rounds: totalLlmTurns, totalLoopIterations, totalSwarmRounds
  |         |   ← [BP-N] ORPHAN FIELD: The spec's byNode includes
  |         |     loopIterations, swarmRounds, retryCount per node.
  |         |     Sources:
  |         |     - llmCalls turn count: MAX(turn_index) from llm_calls — OK
  |         |     - retryCount: node_executions.retry_count — OK
  |         |     - loopIterations: NOT STORED anywhere. Loop executor
  |         |       runs sub-nodes but doesn't persist iteration count
  |         |       to a queryable field. The iteration_index column on
  |         |       node_executions tracks which iteration a sub-node
  |         |       belongs to, but the parent loop node doesn't store
  |         |       total iterations.
  |         |     - swarmRounds: NOT STORED. Swarm executor runs rounds
  |         |       but doesn't persist round count.
  |         |     FIX: Either:
  |         |       a) Add loop_iterations and swarm_rounds columns to
  |         |          node_executions, populated in onNodeEnd callback
  |         |       b) Compute from child node_executions:
  |         |          loopIterations = MAX(iteration_index) WHERE parent_node_id = loopNodeId
  |         |          swarmRounds = COUNT(DISTINCT agent_events.turn_index) for swarm node
  |         |       Option (b) avoids schema change but is more complex.
  |
4. All charts render (non-realtime, one-time load)
  |         OK Recharts available, feasible once API exists
  |
5. Error timeline shows entries
  |         Depends on BP-M resolution
  |
6. Round detail expandable table
            Depends on BP-N resolution
```

### Break Points Summary (Story 3)

| ID | Severity | Type | Description |
|----|----------|------|-------------|
| BP-M | HIGH | Orphan Field | Error type classification system doesn't exist |
| BP-N | MEDIUM | Orphan Field | loopIterations and swarmRounds not queryable from DB |

---

## Story 4: CLI Budget Validation

### Step-by-Step Trace

```
1. User writes workflow.yaml with budget: { max_tokens: "abc" }
  |
2. octopus workflow validate workflow.yaml
  |
  +--[CLI] Reads file, calls parseWorkflow(content)
  |         OK Code exists: cli/workflow.ts:168
  |
  +--[Shared] parseWorkflow → WorkflowSchema.safeParse(raw)
  |         OK Code exists: shared/yaml/parser.ts:24
  |         After adding BudgetSchema to WorkflowSchema:
  |         budget.max_tokens: z.number().int().positive().optional()
  |         Zod will reject "abc" (string) where number expected.
  |
  +--[CLI] Catches ValueError, prints error message
  |         OK Code exists: cli/workflow.ts:173-175
  |         parseWorkflow throws ValueError with Zod issue details.
  |         Error message will include path ["budget", "max_tokens"]
  |         and message "Expected number, received string".
  |
  +--[CLI] Exit code != 0
            OK process.exit(1) in catch block.
```

### Break Points Summary (Story 4)

**No break points.** This story is fully feasible with the existing `parseWorkflow` → `WorkflowSchema.safeParse` pipeline. Adding `budget: BudgetSchema` to WorkflowSchema automatically enables CLI validation.

---

## Cross-Story Break Points

| ID | Severity | Type | Description | Stories Affected |
|----|----------|------|-------------|-----------------|
| BP-O | MEDIUM | Magic Bridge | Spec path uses `workspace` (singular) but actual Next.js routing uses `workspaces` (plural): `app/workspaces/[id]/...` | 1, 3 |
| BP-P | MEDIUM | Unversioned State | `max_duration` budget check needs elapsed time calculation. `executions.started_at` exists but spec doesn't reference it for duration tracking. The `execution_metrics` event includes `durationPercent` but doesn't define how start time is determined. | 2 |
| BP-Q | LOW | Orphan Field | `alert_threshold` config location undefined. Spec says "阈值可通过 alert_threshold 配置（默认 0.8）" but doesn't specify WHERE: workflow YAML? harness config? agent config? | 2 |
| BP-R | LOW | Silent Failure | Bash/Python nodes produce no token data. When such nodes complete, `execution_metrics` would show unchanged totals, potentially confusing users. Spec doesn't address this UX gap. | 1, 3 |

---

## Complete Break Point Registry

| ID | Severity | Anti-Pattern | Component | Description | Recommended Fix |
|----|----------|-------------|-----------|-------------|----------------|
| BP-A | **CRITICAL** | Orphan Field | Server DB + Lifecycle | `budget_snapshot` column missing from schema; no code writes it | Add `ensureColumn` in schema.ts migration + write in `ExecutionLifecycle.start()` after `getWorkflow()` |
| BP-B | **CRITICAL** | Magic Bridge | Engine → Server | `wf.parsed.budget` exists in memory but never persisted | Add budget extraction between lines 197-277 of ExecutionLifecycle.start() |
| BP-C | **CRITICAL** | Missing Trigger | Server SSE | `execution_metrics` SSE event has no producer | Add cumulative aggregation + emit after `node_end` in EngineCallbacks.ts |
| BP-D | **CRITICAL** | Unconnected Feedback | Web-app Hook | `useHarnessEvents` only tracks harness events, not execution metrics | Create `useExecutionMetrics` hook subscribing to `execution_metrics` + `node_end` SSE events |
| BP-E | **HIGH** | Missing Trigger | Web-app UI | No "Details" button in floating panel to navigate to observability page | Add "观测详情" button/link in expanded MonitorTab |
| BP-F | **HIGH** | Orphan Field | Web-app Route | Observability page route doesn't exist; spec has path typo | Create `app/workspaces/[id]/executions/[eid]/observability/page.tsx` |
| BP-G | **HIGH** | Missing Trigger | Server API | `GET /executions/:eid/observability` endpoint not implemented | Add route handler + `ObservabilityQueryService` with aggregation queries |
| BP-H | **HIGH** | Magic Bridge | Server DB | Aggregation query assumes `execution_id` on `node_token_usages` (it's on `node_executions` and `llm_calls`) | Use `llm_calls` for primary aggregation; join through `node_executions` for `node_token_usages` |
| BP-I | **CRITICAL** | Missing Trigger | Server Callbacks | No budget threshold check after `node_end` | Add budget check in `onNodeEnd` callback: query cumulative tokens vs `budget_snapshot.max_tokens * threshold` |
| BP-J | **HIGH** | Magic Bridge | Server Notify | Notification channel source ambiguous — "main agent 配置" unclear | Spec should state: read from workflow YAML `providers`/`channels`; fallback to log-only |
| BP-K | **HIGH** | Silent Failure | Engine | Budget enforcement in `onBeforeNode` conflicts with harness callback ordering | Add budget check as first step in existing `onBeforeNode` wrapper, before harness pipeline |
| BP-L | **HIGH** | Unversioned State | Engine + Lifecycle | `budget_exceeded` not in execution status vocabulary (exists only at node level in StructuredResultStatus) | Add to status handling in ExecutionLifecycle + engine `onComplete` + frontend badges |
| BP-M | **HIGH** | Orphan Field | Server API | Error type classification (5 types) doesn't exist anywhere | Define `classifyError(error, nodeType)` function in observability query service |
| BP-N | **MEDIUM** | Orphan Field | Server DB | `loopIterations` and `swarmRounds` not persisted per node | Compute from child `node_executions` (MAX iteration_index) or add columns |
| BP-O | **MEDIUM** | Magic Bridge | Web-app Route | Spec uses `workspace` (singular) vs actual `workspaces` (plural) | Use correct plural form in route path |
| BP-P | **MEDIUM** | Unversioned State | Server | `max_duration` needs elapsed time from `started_at`; spec doesn't reference it | Use `executions.started_at` for duration calculation in metrics aggregation |
| BP-Q | **LOW** | Orphan Field | Config | `alert_threshold` config location undefined | Add to workflow YAML budget schema: `alert_threshold: z.number().min(0).max(1).optional().default(0.8)` |
| BP-R | **LOW** | Silent Failure | UX | Non-LLM nodes (bash/python) produce no token data, confusing metrics display | Add note in UI: "Token metrics reflect LLM-consuming nodes only" |
| BP-S | **CRITICAL** | Unconnected Feedback | SSE | Spec references `status_change` SSE event but it's dead code — server never emits it; uses `execution_status` instead | Replace all `status_change` references with `execution_status` in spec |
| BP-T | **HIGH** | Silent Failure | Engine | `onBeforeNode` doesn't fire for inner loop nodes; budget enforcement can't check per-iteration | Document limitation; recommend per-node budget fields (swarm/octopus_agent) for loop-internal control |

---

## Recommendations for Spec Updates

### Must Fix Before Implementation (CRITICAL + HIGH)

1. **Add "Budget Snapshot Write" to Implementation Decisions**
   - In `ExecutionLifecycle.start()`, after `getWorkflow()`, extract `wf.parsed.budget` and write `budget_snapshot` to DB
   - Add `ensureColumn` migration in `schema.ts` (`budget_snapshot TEXT DEFAULT NULL`)
   - Add corresponding AC: "budget_snapshot written within 100ms of execution start"

2. **Add "Execution Metrics Aggregation" to Implementation Decisions**
   - Define `computeExecutionMetrics(executionId)` function in a new `ObservabilityQueryService`
   - Called from `EngineCallbacks.onNodeEnd` after token usage insertion
   - Primary data source: `llm_calls` table (has `execution_id`)
   - Fallback: `node_token_usages` JOIN `node_executions` (when `llm_calls_persist` flag is off)
   - Throttle SSE emit to max 1 per 500ms (matches R1 risk)

3. **Add "Frontend Data Layer" to Implementation Decisions**
   - Create `useExecutionMetrics(workspaceId, executionId)` hook
   - Subscribes to `execution_metrics` SSE events
   - Returns `{ totalTokens, totalCost, totalTurns, budgetProgress, errorCount }`
   - Floating panel's MonitorTab consumes this hook for 4 summary cards

4. **Clarify Budget Enforcement Mechanism**
   - Budget check runs in `onNodeEnd` (for warning) and `onBeforeNode` (for blocking)
   - `onBeforeNode` budget check is injected BEFORE harness pipeline wrapping
   - `budget_exceeded` added as a valid execution status
   - When budget exceeded: set status, emit `execution_status` SSE (NOT `status_change`), call `onComplete`
   - **Limitation**: `onBeforeNode` only fires for top-level nodes, not loop inner nodes. Budget enforcement operates at top-level node boundaries only. For per-iteration budget control, users should use existing swarm `budget` or octopus_agent `task.budget` fields.

5. **Clarify Notification System**
   - Use the **engine notify module** (engine/src/notify/) for budget warnings
   - Budget warning notifications read from workflow YAML `providers`/`channels` fields
   - This is the same system used by workflow hooks (`on_success`, `on_node_failure`, etc.)
   - If no notification provider configured, log warning to server console and skip
   - Do NOT use Agent NotificationService (that's for the octo-agent chat system)
   - Do NOT use Scheduler NotificationService (that's for scheduled task failures only)

6. **Fix SSE Event Names**
   - Replace ALL references to `status_change` with `execution_status` in the spec
   - `status_change` is defined in the shared Zod schema but is dead code — never emitted by the server
   - The server uses `execution_status` for status transitions and `execution_progress` for progress updates
   - The `execution_metrics` event (new) should follow the same pattern as existing events in EngineCallbacks.ts

6. **Add Error Classification Function**
   - Define `classifyError(error: string, nodeType: string, statusCode?: number): ErrorType`
   - 5 types: timeout, model_error, script_error, approval_rejected, other
   - Keyword-based classification (timeout→'timeout', model→'model_error', etc.)

7. **Fix Route Path**
   - Use `app/workspaces/[id]/executions/[eid]/observability/page.tsx` (plural "workspaces")

### Document for Implementation Phase (MEDIUM + LOW)

8. **loopIterations/swarmRounds computation**: Use child node_executions query approach (avoid schema change)
9. **alert_threshold**: Add to BudgetSchema as optional field with default 0.8
10. **Non-LLM node handling**: UI note that token metrics only reflect LLM-consuming nodes
11. **max_duration tracking**: Use `executions.started_at` for elapsed time calculation

---

## New Key Decisions Needed

| # | Decision | Recommended Conclusion | Reason |
|---|---------|----------------------|--------|
| KD-8 | Budget snapshot write timing | In `ExecutionLifecycle.start()` after `getWorkflow()`, before engine creation | Earliest reliable point; workflow YAML is parsed and available |
| KD-9 | Execution metrics data source | Primary: `llm_calls` table; Fallback: `node_token_usages` JOIN `node_executions` | `llm_calls` has `execution_id` directly; `node_token_usages` doesn't |
| KD-10 | Frontend hook architecture | New `useExecutionMetrics` hook (separate from `useHarnessEvents`) | Separation of concerns; harness events ≠ execution metrics |
| KD-11 | Budget check injection point | `onBeforeNode` (blocking) + `onNodeEnd` (warning), before harness wrapping | Budget is a hard constraint; must check before harness interventions |
| KD-12 | Notification channel source | Workflow YAML `providers`/`channels`; fallback to skip | Self-contained; no cross-system dependency on agent config |
| KD-13 | Error classification | Keyword-based `classifyError()` function in query service | Simple, extensible, no schema change needed |
| KD-14 | Loop/swarm round counting | Compute from child `node_executions.iteration_index` | Avoids schema change; data already available |
| KD-15 | SSE event naming | Use `execution_status` (not `status_change`) for status transitions | `status_change` is dead code in shared schema; server uses `execution_status` |
| KD-16 | Budget enforcement scope | Top-level node boundaries only; per-iteration uses existing node-level budget fields | `onBeforeNode` doesn't fire for loop inner nodes; architectural limitation |
| KD-17 | Notification system selection | Engine notify module (workflow YAML providers/channels) | Self-contained; same system as workflow hooks; no cross-system dependency |

---

## Anti-Pattern Audit

| Anti-Pattern | Instances Found | Severity |
|-------------|----------------|----------|
| **Magic Bridge** | 4 (BP-B, BP-H, BP-J, BP-O) | CRITICAL–HIGH |
| **Orphan Field** | 4 (BP-A, BP-F, BP-M, BP-N) | CRITICAL–MEDIUM |
| **Silent Failure** | 4 (BP-K, BP-T, BP-N-engine, BP-R) | HIGH–LOW |
| **Missing Trigger** | 4 (BP-C, BP-E, BP-G, BP-I) | CRITICAL–HIGH |
| **Unversioned State** | 3 (BP-L, BP-P, BP-Q) | HIGH–LOW |
| **Unconnected Feedback** | 3 (BP-D, BP-S, BP-J) | CRITICAL–HIGH |

The dominant patterns are **Missing Trigger** and **Unconnected Feedback** — behaviors described in the spec (budget check, metrics emission, navigation, API query, status change) either have no event that initiates them, or reference events/channels that don't match what the server actually produces.

---

## Story 4 (CLI Validation): Clean Pass

Story 4 has **zero break points**. The existing `parseWorkflow` → `WorkflowSchema.safeParse` → `ValueError` pipeline automatically handles budget validation once `BudgetSchema` is added to `WorkflowSchema`. No additional code changes needed in CLI or shared packages beyond the schema addition.
