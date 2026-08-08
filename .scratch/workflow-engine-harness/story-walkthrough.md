# Story Walk-Through: WorkflowEngine Harness — Agentic 监督层

> Spec: `.scratch/workflow-engine-harness/spec.md`
> Date: 2026-08-05
> Analyst: Codebase Research Agent

---

## Executive Summary

The spec proposes a 3-layer supervision harness for the WorkflowEngine with 8 user stories. This walkthrough traced each story through the full stack (UI → API → Service → Engine → DB → SSE → UI) and identified **5 CRITICAL**, **8 HIGH**, **10 MEDIUM**, and **2 LOW** break points. The most severe issues cluster around:

1. **Engine callback gaps** — the spec proposes 3 new callbacks (`onBeforeRetry`, `onFailureDecision`, `onBeforeNode`) but doesn't detail how they integrate into the engine's tight retry loop
2. **Missing data path for `harnessHint`** — no mechanism to inject hints into bash/python scripts between retries
3. **Token billing factual error** — `node_token_usages` table has no `source` column, contrary to the spec's claim
4. **API contract mismatch** — existing `harness-intervene` only supports `abort`/`pause`, not `inject`

---

## Story 1: 傻重试自动纠正 (Stupid Retry Auto-Correction)

### Full Trace

```
[UI]     User clicks "Run" on harness_test_retry workflow
         → POST /api/workspaces/:id/executions { workflow_ref: "harness_test_retry.yaml" }
         → ExecutionService.create() → INSERT executions (status: "pending")
         → ExecutionLifecycle.start() → new WorkflowEngine(callbacks) → engine.run()

[Engine] executeNodesSequential → executeSingleNodeWithRetry(bash-build)
         → attempt 1: BashExecutor.execute() → spawn("bash", ["-c", "npm run build"])
         → exit 1, "Cannot find module 'xyz'"
         → result.status = "failed"
         → callbacks.onNodeEnd("bash-build", "failed", ...)
         → failureClassifier.classify(result) → errorCategory
         → policy.retry_on includes errorCategory? → yes
         → attempt < max_attempts? → yes
         → callbacks.onNodeRetry("bash-build", 1, maxAttempts, delayMs)  ← EXISTING callback
         → sleepWithAbort(delayMs)

         → attempt 2: BashExecutor.execute() → same script → same failure
         → callbacks.onNodeEnd("bash-build", "failed", ...)
         → failureClassifier.classify(result) → same errorCategory
```

**⚠️ BREAK POINT 1 — Where does the Harness intercept?**

The spec says `onBeforeRetry` fires here, but this callback **does not exist** in the current `EngineCallbacks` interface (packages/engine/src/engine.ts:51-67). The existing `onNodeRetry` fires at line 923 AFTER the retry decision is made and BEFORE the delay sleep. The spec's `onBeforeRetry` needs to:

1. Be inserted into the retry loop between `failureClassifier.classify()` and `sleepWithAbort()`
2. Return a `Promise<{ action: "retry" | "skip" | "abort" | "override", harnessHint?: string }>`
3. Be awaited (making the retry loop async-aware at that point — it already is, so this is feasible)

**Integration point in engine.ts (line ~918-924):**
```
// CURRENT CODE:
this.callbacks?.onNodeRetry?.(node.id, attempt, policy.max_attempts, delayMs)
await this.sleepWithAbort(delayMs, effectiveSignal)

// REQUIRED CHANGE:
const harnessDecision = await this.callbacks?.onBeforeRetry?.(node.id, attempt, lastResult)
if (harnessDecision?.action === "skip") return { ...lastResult, status: "skipped" }
if (harnessDecision?.action === "abort") { signal?.abort(); throw new Error("Harness abort") }
if (harnessDecision?.action === "override") return harnessDecision.overrideResult!
// For "retry", inject harnessHint somehow...
this.callbacks?.onNodeRetry?.(node.id, attempt, policy.max_attempts, delayMs)
await this.sleepWithAbort(delayMs, effectiveSignal)
```

**⚠️ BREAK POINT 2 — How does `harnessHint` reach the bash script? [CRITICAL]**

The spec's Story 1 appendix says:
> 第 3 次执行: → 收到 harnessHint → 脚本先跑 npm install → npm run build → 成功

But `BashExecutor.execute()` (packages/engine/src/executors/bash.ts:69-129) substitutes the script from `node.bash` using VarPool. There is **no mechanism** to inject an external hint string into the script between retry attempts. The bash script is a static YAML field.

Possible solutions the spec should address:
- **Option A**: Inject `harnessHint` into VarPool as `$vars.harness_hint`, require workflow YAML to reference it
- **Option B**: Prepend hint as a comment/env var to the script before execution
- **Option C**: For agent nodes only — inject hint into the agent's prompt via PromptInjector

Without this, the "inject corrective instruction" story is a **Magic Bridge**.

```
[Harness] StupidRetryDetector:
  → Compare errorHash(attempt 1) == errorHash(attempt 2)
```

**⚠️ BREAK POINT 3 — `errorHash` is undefined [HIGH]**

`DiagnosisReport.evidence` includes `errorHash`, but `NodeExecutionResult` (packages/engine/src/executors/types.ts:25-54) doesn't contain any hash. The `FailureClassifier` returns a category string (e.g., "command_error", "timeout"), not a hash. The spec doesn't define how to compute `errorHash` from `NodeExecutionResult`.

```
[DB]     INSERT harness_events (type: "diagnosis")
[SSE]    emit harness_diagnosis
```

**⚠️ BREAK POINT 4 — `harness_events` table doesn't exist yet [MEDIUM]**

The table DDL is in the spec but there's no migration path. The existing migration system uses `ensureColumn()` in `packages/server/src/db/schema.ts:161-170` for ALTER TABLE and `schema.sql` for CREATE TABLE. The spec needs to:
1. Add `harness_events` and `harness_config` tables to `schema.sql`
2. Add ALTER TABLE for `node_executions` columns (`harness_status`, `harness_interventions`) via `ensureColumn()`

```
[UI]     DAG 节点显示 ✅ + 🛡️ 标记
```

**⚠️ BREAK POINT 5 — No SSE subscription for harness events in web-app [MEDIUM]**

The web-app's `use-execution-events.ts` hook uses polling (`fetchAgentEvents` every 2s), not SSE/EventSource. The spec defines 4 new SSE events (`harness_diagnosis`, `harness_intervention`, `harness_delegation`, `harness_blocked`) but doesn't describe how the web-app receives them. The existing SSE flow goes: `SSEService.emit()` → `events.ts` route → `EventSource` client. But the web-app hooks don't use EventSource — they poll REST endpoints.

---

## Story 2: 进程冲突阻断 (Process Conflict Blocking)

### Full Trace

```
[Engine] executeSingleNode(bash-test) → about to execute script containing "kill $OCTOPUS_HOST_PID"
```

**⚠️ BREAK POINT 6 — `onBeforeNode` doesn't exist [CRITICAL]**

The spec's Story 2 appendix says:
> ProcessConflictDetector (onBeforeNode): → 扫描脚本 → 发现 kill 引用 OCTOPUS_HOST_PID

But `onBeforeNode` is a **proposed** callback, not an existing one. The current `executeSingleNode()` method (engine.ts:807-856) goes:
```
executor = createExecutor(node, pool, signal)
callbacks.onNodeStart(nodeId, nodeType)
result = await executor.execute()
callbacks.onNodeEnd(nodeId, status, ...)
```

There is no interception point between `onNodeStart` and `executor.execute()`. Adding `onBeforeNode` requires inserting it into this flow, which adds ~10 lines to `executeSingleNode()`.

**⚠️ BREAK POINT 7 — Static script scanning is unreliable [HIGH]**

The ProcessConflictDetector proposes to "scan script" for `kill $OCTOPUS_HOST_PID`. But:
- Variable substitution (`$OCTOPUS_HOST_PID`) happens at bash runtime, not scan time
- The script is already substituted by `substituteVarsFull()` before execution — so the detector would see the literal PID value, not the variable reference
- Indirect kills (`eval "kill $$"`, `$(kill ...)`, heredocs) would bypass static scanning
- The Wrapper approach (aliasing `kill`) is more robust but only works on bash, not Python

The spec should clarify: is the detector static (scan before execution) or runtime (Wrapper interception)? Both have different trade-offs.

**⚠️ BREAK POINT 8 — `OCTOPUS_HOST_PID` is not injected [MEDIUM]**

The Wrapper script references `$OCTOPUS_HOST_PID`, but `BashExecutor.runScript()` (line 165-169) only cleans `OCTOPUS_DB_PATH` from env vars. There's no injection of `OCTOPUS_HOST_PID`. The engine would need to add:
```typescript
env.OCTOPUS_HOST_PID = String(process.pid)
```

```
[Harness] StrategyEngine:
  → match: "process_conflict"
  → onBeforeNode returns { action: "skip", overrideResult: { status: "failed", error: "blocked" } }

[Engine] Node skipped, onNodeEnd("bash-test", "failed", ...)
```

**Feasibility**: If `onBeforeNode` is added, this flow is technically feasible. The engine would need to check the return value and skip `executor.execute()` if `action === "skip"`.

---

## Story 3: 模型不匹配自动切换 (Model Mismatch Auto-Switch)

### Full Trace

```
[Engine] executeSingleNode(agent-read) → AgentExecutor.execute()
         → Claude API call with image → 400 "model does not support vision"
         → result.status = "failed", error contains "vision"

[Harness] ModelMismatchDetector:
  → error message contains "vision" → DiagnosisReport

[Harness] StrategyEngine:
  → match: "model_mismatch" → action: switch_model, prefer: vision_capable
```

**⚠️ BREAK POINT 9 — No mechanism to switch models mid-execution [CRITICAL]**

The spec says `switch_model` action changes the model for the agent node. But:
1. `AgentExecutor` resolves the model from `node.model` or `workflowDefaultModel` in its constructor
2. The model is not mutable between retry attempts — `executeSingleNodeWithRetry` calls `executeSingleNode` which creates a new executor each time, but uses the same `node` definition
3. The `onBeforeRetry` callback's return type doesn't include a `switch_model` action — only `"retry" | "skip" | "abort" | "override"`

To implement this, the spec needs to either:
- Add a `modelOverride?: string` field to the `onBeforeRetry` return type
- Use the `override` action to provide a complete `NodeExecutionResult` with a different model
- Modify `node.model` in-place (mutation, but feasible)

**⚠️ BREAK POINT 10 — `switch_model` is not in the 4 intervention modes [HIGH]**

The spec lists 4 intervention modes: `inject_message`, `agent_takeover`, `modify_varpool`, `modify_definition`. But `switch_model` doesn't match any of these. It's closest to `modify_definition` (changing the node's model field), but the spec doesn't make this connection explicit. The strategy action types in `harness-defaults.yaml` (`inject_message`, `retry_with_hint`, `switch_model`, `abort`, `pause`, `pause_and_notify`) don't match the 4 named intervention modes.

---

## Story 4: 超时级联暂停 (Timeout Cascade Pause)

### Full Trace

```
[Engine] node-A timeout → onNodeEnd("node-A", "failed")
[Engine] node-B timeout → onNodeEnd("node-B", "failed")
[Engine] node-C timeout → onNodeEnd("node-C", "failed")

[Harness] TimeoutCascadeDetector:
  → 3 consecutive timeouts → DiagnosisReport { severity: "critical" }

[Harness] StrategyEngine:
  → match: "timeout_cascade" → action: pause, notify: true
```

**⚠️ BREAK POINT 11 — Cross-node state tracking is undefined [HIGH]**

The TimeoutCascadeDetector needs to track consecutive timeouts across multiple nodes. But:
- Detectors are described as "可插拔的检测器，观察引擎事件" — they observe individual events
- The detector needs state: a counter of consecutive timeouts, reset on non-timeout completion
- Where does this state live? In the detector instance? In the HarnessController? In the DB?
- The spec doesn't define the detector lifecycle (singleton per execution? per engine?)

**⚠️ BREAK POINT 12 — Pause mechanism dependency injection [MEDIUM]**

The harness needs to call `ExecutionLifecycle.pause()` to pause the workflow. But the harness controller lives in `packages/server/src/services/harness/`, and `ExecutionLifecycle` is in `packages/server/src/services/execution/ExecutionLifecycle.ts`. The spec doesn't describe how the harness controller gets a reference to the lifecycle service.

The existing `harnessIntervene()` method in `ExecutionService` (line 161-185) already has this integration, suggesting the harness controller should delegate to `ExecutionService` for pause/cancel operations. But the spec doesn't make this explicit.

---

## Story 5: UI 配置编辑 (Config Editing via Admin UI)

### Full Trace

```
[UI]     Admin navigates to System Settings → Harness Config
         → GET /api/workspaces/:id/harness/config
         → Response: { config: string (YAML), version: number }
         → Render YAML in editor

[UI]     Admin edits YAML → clicks Save
         → PUT /api/workspaces/:id/harness/config { config: "..." }
         → Server validates YAML → saves to harness_config table
         → Response: { success: true, version: 2 }
```

**⚠️ BREAK POINT 13 — Config scope mismatch [MEDIUM]**

The spec says "全局 harness.yaml" but the `harness_config` table is scoped by `workspace_id`. This creates ambiguity:
- Is config global (one per Octopus instance) or per-workspace?
- The config loader must implement: global defaults (from `harness-defaults.yaml`) + workspace overrides (from `harness_config` table)
- The merge logic isn't detailed in the spec

**⚠️ BREAK POINT 14 — No YAML validation schema [LOW]**

The `PUT /harness/config` endpoint accepts raw YAML. The spec doesn't define a Zod schema for validating the harness config structure. Invalid configs could crash the harness at runtime.

---

## Story 6: Chatbot 主动干预 (Chatbot Active Intervention)

### Full Trace

```
[UI]     User types in chatbot: "告诉 agent-write 节点分两步写"
         → POST /api/workspaces/:id/executions/:execId/harness-intervene
           { nodeId: "agent-write", directive: { type: "inject", message: "..." } }
```

**⚠️ BREAK POINT 15 — Existing `harness-intervene` API only supports abort/pause [CRITICAL]**

The current implementation (`packages/server/src/services/execution.ts:161-185`):
```typescript
async harnessIntervene(
  executionId: string,
  input: { nodeId: string; directive: { type: "abort" | "pause"; reason: string; issued_by: string } },
)
```

Only handles `type: "abort"` and `type: "pause"`. The chatbot needs `type: "inject"` to inject a message into a running agent session. This requires:
1. Extending the directive type union: `"abort" | "pause" | "inject"`
2. Implementing message injection — which requires access to the agent's session
3. The existing `RepairService.intervene()` (from `repair.ts`) does exactly this for agent sessions, using `InterveneRequestSchema { nodeId, message }`

**⚠️ BREAK POINT 16 — Two separate intervene APIs conflated [HIGH]**

The codebase has TWO intervene mechanisms:
1. `POST /executions/:id/harness-intervene` — execution-level abort/pause (in `routes/execution.ts:400`)
2. `POST /executions/:id/repair/intervene` — node-level message injection (in `routes/repair.ts`)

The spec's Story 3 appendix says "[API] 调用 repair/intervene → 注入消息到 agent session", which is the repair service. But the API contract table lists the harness-intervene endpoint. These are **different endpoints with different schemas**.

The spec should clarify: does the chatbot call `harness-intervene` (which needs extending) or `repair/intervene` (which already exists)?

---

## Story 7: 干预历史审计 (Intervention History Audit)

### Full Trace

```
[DB]     harness_events table stores: diagnosis, intervention, delegation, blocked events
[API]    GET /api/workspaces/:id/harness/events/:execId → returns HarnessEvent[]
[UI]     悬浮面板 → 明细 Tab → renders event timeline
```

**⚠️ BREAK POINT 17 — `harness_events` table not in schema.sql [MEDIUM]**

The table DDL is in the spec but needs to be added to `packages/server/src/db/schema.sql`. The existing schema has 28+ tables and follows a specific pattern (idempotent `CREATE TABLE IF NOT EXISTS`). New tables need to be added there.

Additionally, the `node_executions` table needs two new columns:
- `harness_status TEXT` (nullable)
- `harness_interventions TEXT` (JSON, nullable)

These need `ensureColumn()` calls in `schema.ts`.

**⚠️ BREAK POINT 18 — `harness_status` values don't match `NodeExecutionResult.status` [MEDIUM]**

The spec defines 3 new node statuses: `harness_intervening`, `harness_modified`, `harness_executed`. These are added to the `NodeStatus` type union. But `NodeExecutionResult.status` (packages/engine/src/executors/types.ts:29) has its own status union that doesn't include these. The harness statuses are stored in a separate `harness_status` column, not in the main `status` column — but the spec doesn't explain how the UI combines these two sources.

---

## Story 8: Token 计费 (Token Billing)

### Full Trace

```
[Harness] Agent Delegation (Layer 3) → creates agent session → agent runs
          → agent returns result with token usage

[DB]      INSERT node_token_usages (source: "harness", ...)
          → SUM all token_usages for execution → total includes harness cost
```

**⚠️ BREAK POINT 19 — `node_token_usages` has NO `source` column [CRITICAL]**

The spec says:
> `token_usages` | 无变更 | 已有 `source` 字段，新增 `"harness"` 枚举值即可

But the actual `node_token_usages` table (schema.sql:147-158):
```sql
CREATE TABLE IF NOT EXISTS node_token_usages (
  id TEXT PRIMARY KEY,
  node_execution_id TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  FOREIGN KEY (node_execution_id) REFERENCES node_executions(id)
);
```

**There is no `source` column.** This is a factual error in the spec. To implement Story 8, the spec needs to:
1. Add `source TEXT DEFAULT 'node'` column via `ensureColumn()`
2. Define how harness agent token usage creates a separate `node_execution_id` or uses a virtual one

**⚠️ BREAK POINT 20 — Harness agent token tracking path is undefined [HIGH]**

When Layer 3 delegates to an Agent, the agent's token usage needs to be tracked. But:
- Token usage is tracked per `node_execution_id` (see `EngineCallbacks.ts:92-99`)
- The harness agent doesn't have a `node_execution_id` in the original execution
- The spec doesn't explain how to create a virtual node execution for the harness agent, or how to link its tokens back

---

## Break Point Summary

| # | Severity | Story | Issue | Recommended Fix |
|---|----------|-------|-------|-----------------|
| 1 | CRITICAL | 1 | `onBeforeRetry` callback doesn't exist in engine | Detail exact insertion point in engine.ts retry loop; add ~15 lines |
| 2 | CRITICAL | 1 | No mechanism to inject `harnessHint` into bash/python scripts | Define hint delivery mechanism: VarPool injection, env var, or prompt injection for agent nodes |
| 6 | CRITICAL | 2 | `onBeforeNode` callback doesn't exist in engine | Detail insertion point in `executeSingleNode()` between `onNodeStart` and `executor.execute()` |
| 9 | CRITICAL | 3 | No mechanism to switch models mid-execution | Add `modelOverride` to `onBeforeRetry` return type, or use `modify_definition` action |
| 15 | CRITICAL | 6 | `harness-intervene` API only supports abort/pause | Extend directive type union to include `"inject"` and delegate to `RepairService` for message injection |
| 19 | CRITICAL (factual error) | 8 | `node_token_usages` has no `source` column | Add `source` column via migration; update spec to reflect actual schema |
| 3 | HIGH | 1 | `errorHash` source undefined | Define hash computation from `NodeExecutionResult` (e.g., hash of `error` + `lastOutput`) |
| 7 | HIGH | 2 | Static script scanning unreliable | Clarify static vs runtime detection; recommend Wrapper-first approach with static as secondary |
| 10 | HIGH | 3 | `switch_model` not in the 4 intervention modes | Map `switch_model` to `modify_definition` or add as 5th mode |
| 11 | HIGH | 4 | Cross-node state tracking undefined for detectors | Define detector lifecycle: stateful singleton per execution, with `reset()` on success |
| 16 | HIGH | 6 | Two intervene APIs conflated | Clarify: chatbot uses extended `harness-intervene` or existing `repair/intervene` |
| 20 | HIGH | 8 | Harness agent token tracking path undefined | Define virtual `node_execution_id` for harness agent, or add `source` column to decouple |
| 4 | MEDIUM | 1 | `harness_events` table needs migration | Add to schema.sql + ensureColumn calls in schema.ts |
| 5 | MEDIUM | 1 | No SSE subscription for harness events in web-app | Define `use-harness-events.ts` hook; decide SSE vs polling |
| 8 | MEDIUM | 2 | `OCTOPUS_HOST_PID` not injected | Add env var injection in BashExecutor |
| 12 | MEDIUM | 4 | Pause mechanism dependency injection | Define HarnessController constructor deps including ExecutionService reference |
| 13 | MEDIUM | 5 | Config scope: global vs per-workspace | Clarify merge strategy: global defaults + workspace overrides |
| 17 | MEDIUM | 7 | Table creation not automated | Add to schema.sql, add ensureColumn for node_executions columns |
| 18 | MEDIUM | 7 | `harness_status` vs `NodeExecutionResult.status` | Document dual-column approach; UI reads both |
| 14 | LOW | 5 | No YAML validation schema | Add Zod schema for harness config |

---

## Recommendations

### R1: Add Engine Callback Integration Detail
The spec should include a concrete patch for `engine.ts` showing exactly where the 3 new callbacks are inserted:
- `onBeforeNode`: in `executeSingleNode()`, between `onNodeStart` and `executor.execute()` (line ~817)
- `onBeforeRetry`: in `executeSingleNodeWithRetry()`, between `failureClassifier.classify()` and `sleepWithAbort()` (line ~923)
- `onFailureDecision`: in the failure handling path after retry exhaustion (line ~932)

### R2: Define Hint Delivery Mechanism
For `harnessHint` to reach bash/python nodes:
- **Recommended**: Inject `$harness_hint` into VarPool before retry. Workflow YAML can reference it.
- **Alternative**: For agent nodes only, inject via `PromptInjector.addTargetedHint(nodeId, hint)`.

### R3: Fix Token Billing Schema
- Add `source TEXT DEFAULT 'node'` to `node_token_usages` via `ensureColumn()`
- Add `harness_execution_id TEXT` nullable column to link harness agent tokens
- Update spec to match actual schema

### R4: Unify Intervene APIs
- Extend `harness-intervene` to support `type: "inject"` by delegating to `RepairService.intervene()` internally
- Document the delegation chain clearly

### R5: Define Detector State Management
- Detectors should be instantiated per-execution (not global singletons)
- Stateful detectors (TimeoutCascade) should store state in-memory on the HarnessController
- Add `detector.reset()` call on execution completion

### R6: Add Concrete Migration Code
The spec should include the exact `ensureColumn()` calls and `schema.sql` additions needed, following the existing pattern in `schema.ts`.
