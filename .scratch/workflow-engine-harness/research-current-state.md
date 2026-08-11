# Research: Workflow Engine Harness - Current State

> Generated: 2026-08-06
> Purpose: Comprehensive audit of the existing harness system design and implementation

---

## 1. Existing Spec / Design Docs

### 1.1 Spec (spec.md)
- **File**: `.scratch/workflow-engine-harness/spec.md` (865 lines)
- **Problem**: Three fatal problems: agent stupid retry, process conflict killing host, model capability mismatch
- **Solution**: Three-layer delegation architecture: Detectors -> Strategies -> Agent Delegation
- **Scope**: 4 detectors, 4+1 intervention modes, global harness.yaml, progressive process isolation, floating panel UI, 3 new node statuses, token billing
- **Key decisions**: 8 decisions recorded (see Section 1.3 below)
- **User stories**: 8 stories covering auto-correction, model switching, process blocking, timeout cascade pause, UI config editing, chatbot intervention, audit history, token billing

### 1.2 Brief (brief.md)
- **File**: `.scratch/workflow-engine-harness/brief.md` (21 lines)
- Concise summary pointing to spec.md for details
- Lists 3 risks: engine callback invasiveness (R1), agent clone reliability (R2), Windows sandbox limitations (R4)

### 1.3 Decision Map (map.md)
- **File**: `.scratch/workflow-engine-harness/map.md` (67 lines)
- 8 decisions documented in `decisions/` directory:
  - `01-grilling-harness-brain.md` - three-layer delegation architecture
  - `02-research-engine-hooks.md` - callback decoration + 3 new optional callbacks
  - `03-grilling-strategy-config.md` - global harness.yaml + admin UI
  - `04-grilling-intervention-actions.md` - 4 intervention modes + new node statuses
  - `05-prototype-plugin-protocol.md` - deferred to implementation
  - `06-grilling-process-isolation.md` - progressive security model
  - `07-grilling-ui-enhancement.md` - floating panel + chatbot
  - `08-grilling-verification-strategy.md` - four-layer verification
### 1.4 Issues (10 tickets)
- **Directory**: `.scratch/workflow-engine-harness/issues/`
- All 10 tickets with status:

| # | Ticket | Status | Notes |
|---|--------|--------|-------|
| 01 | Shared types + config defaults | **done** | types.ts, config-schema.ts, harness-defaults.yaml, index.ts |
| 02 | Engine callbacks (3 new) | **done** | onBeforeNode, onBeforeRetry, onFailureDecision |
| 03 | Harness Controller + Detector Pipeline | **done** | 4 detectors + Proxy wrapper |
| 04 | Strategy Engine + 5 actions | **done** | ActionRegistry + 5 action handlers |
| 05 | Process isolation (Wrapper + env) | **done** | ACs not all checked (checkboxes unchecked in issue) |
| 06 | DB migration + API routes | **done** | 2 new tables, 3 new columns, REST API |
| 07 | Config loader + admin UI | **done** | ACs not all checked (checkboxes unchecked in issue) |
| 08 | UI floating panel + DAG markers | **ready-for-agent** | Not started, all ACs unchecked |
| 09 | Agent Delegation (Layer 3) | **implemented** | LLM-powered deep analysis |
| 10 | ExecutionLifecycle integration + E2E | **done** | 3 test workflows, full stack integration |

### 1.5 Loop / Pipeline Status
- **File**: `.scratch/workflow-engine-harness/loop-summary.md`
- 2 iterations completed; final score ~90/100 -> **GO**
- PR: https://github.com/XzhiF/open-octopus/pull/45
- 8 commits, 102+ files changed, ~16,000 lines added, ~240+ tests
- **Remaining gap**: Ticket 08 (UI floating panel) is `ready-for-agent` - not yet implemented
---

## 2. Architecture Docs

### 2.1 CONTEXT-MAP.md (root)
- **File**: `CONTEXT-MAP.md` (133 lines)
- Harness-related glossary terms:
  - **Intervention** (L24): "inject additional guidance to a running node" - engine, server
  - **False Completion** (L26): "agent returns completed but work unfinished" - server
  - **Diagnose Report** (L27): "structured analysis of execution state" - server
  - **Validation Harness** (L70): "three-layer validation + auto-correction loop" - engine
  - **Dynamic Sub-Workflow** (L69): mentions "three-layer Validation Harness" - engine, shared
  - **E2E Harness** (L73): "reusable lib/ modules + patterns/ guides" - skills (different concept)

### 2.2 Server CONTEXT.md
- **File**: `packages/server/CONTEXT.md` - **does not exist**
- No standalone server-level CONTEXT file was found. The server package is documented only through the root CONTEXT-MAP.md.

### 2.3 Package Relationships (from CONTEXT-MAP.md L118-128)
```
shared <- (no deps, all packages depend on it)
providers <- shared
cli <- shared + engine + core-pack
engine <- shared + providers
server <- shared + engine + core-pack + providers
web-app <- shared
core-pack <- (pure data resources)
```
The harness module spans: `shared` (types), `engine` (callbacks), `server` (controller/detectors/strategies), `web-app` (UI panel).

---

## 3. Harness Agent Design

### 3.1 Agent Delegation Service (Layer 3)
- **File**: `packages/server/src/services/harness/agent-delegation.ts` (503 lines)
- **Class**: `AgentDelegationService` - stateless service
- **Trigger**: When StrategyEngine cannot handle a report (no strategy match) or matched strategy has `delegate_to_agent: true`
- **Flow**:
  1. Emit SSE `harness_delegation` start event
  2. Build delegation prompt from DiagnosisReport + DelegationContext
  3. Call LLM (with 5-minute timeout protection)
  4. Parse JSON response into `DelegationResult`
  5. Record token usage with `source="harness"`
  6. Persist delegation event to `harness_events`
  7. Emit SSE complete/fail event
  8. Return result

- **DelegationContext** (L22-31): carries `recentEvents` (last 20), `varpoolSnapshot`, `nodeConfig`, `workflowContent`
- **DelegationResult** (L36-47): `success`, `interventionType` (inject|varpool|definition|takeover), `interventionData`, `tokenUsage`, `reasoning`
- **Prompt** (`buildDelegationPrompt`, L73-136): Chinese-language system prompt asking agent to analyze root cause and choose from 4 intervention types, outputting JSON
- **Response parsing** (`parseDelegationResponse`, L145-207): handles JSON in markdown code blocks or raw text; validates `interventionType` against whitelist
- **LLM call**: Dynamic import of `@octopus/providers`, uses `claude` provider with `sonnet` model (L371-398)
- **Token tracking**: Records to `node_token_usages` with `source='harness'` via `HarnessDAO.insertHarnessTokenUsage()` (L413-438)

### 3.2 Agent Takeover Action
- **File**: `packages/server/src/services/harness/actions/agent-takeover.ts` (27 lines)
- The `agent_takeover` action handler is a **signal** - it returns `{ success: true, delegate: true }` to indicate Layer 3 should follow
- Actual takeover execution happens in `StrategyEngine.handleReport()` which checks `delegate_to_agent` and calls `AgentDelegationService.delegate()`

### 3.3 Harness Agent in Core-Pack
- **Directory**: `packages/core-pack/agents/` - contains 11 agent definitions
- **No harness-specific agent definition** exists in `core-pack/agents/`
- The delegation service uses an **inline LLM call** (not a registered Octopus agent/clone) - it dynamically imports the claude provider and sends a one-shot prompt

### 3.4 How Layer 3 Integrates
In `strategy-engine.ts` L140-173 (`handleReport()`):
1. Try `matchStrategy(report)` - if no match -> call `tryDelegate(report)` -> return `{ delegate: true }`
2. If match found -> `executeActions()` -> then check `strategy.delegate_to_agent === true` -> if so, also call `tryDelegate(report)`
3. Delegation result is appended to `actionResults` array

---

## 4. Strategy Configurations

### 4.1 Harness Defaults YAML
- **File**: `packages/shared/src/harness/harness-defaults.yaml` (52 lines)

#### Detectors (4):
| Detector | Enabled | Threshold | Description |
|----------|---------|-----------|-------------|
| `stupid_retry` | true | 2 | Trigger after N retries with same error |
| `model_mismatch` | true | - | Detect 400 errors for vision/tool mismatch |
| `process_conflict` | true | - | Detect kill/host-port patterns in scripts |
| `timeout_cascade` | true | 3 | Trigger after N consecutive node timeouts |

#### Strategies (5):
| Match | Severity | Actions | Delegate? |
|-------|----------|---------|-----------|
| `stupid_retry` | - | `inject_message` + `retry_with_hint` | No |
| `model_mismatch` | - | `switch_model` (prefer: `vision_capable`) | No |
| `process_conflict` | **critical** | `abort` (process conflict blocked) | No |
| `timeout_cascade` | - | `pause` (notify: true) | No |
| `*` (wildcard) | - | `pause_and_notify` | **Yes** (`delegate_to_agent: true`) |

#### Isolation Config:
```yaml
isolation:
  process_group: true
  port_protection: true
  pid_protection: true
  sandbox: auto        # auto | seatbelt | bubblewrap | wrapper | disabled
  fs_whitelist: [".", "/tmp"]
```

### 4.2 Config Service (MINIMAL_DEFAULTS_YAML)
- **File**: `packages/server/src/services/harness/config-service.ts` (192 lines)
- **Class**: `HarnessConfigService`
- **MINIMAL_DEFAULTS_YAML** (L53-94): Complete fallback copy of harness-defaults.yaml, used when the YAML file cannot be resolved from `@octopus/shared`
- **Resolution strategies** (L19-47): 3 strategies to find the YAML - require.resolve package.json, main entry path, monorepo-relative paths
- **Merge logic** (`loadMergedConfig()`, L151-173): DB overrides take precedence; defaults fill gaps. Detector entries merged with spread; strategies array replaced entirely if user has any; isolation merged with spread.
- **Save logic** (`saveConfig()`, L129-144): Parse YAML -> Zod validate -> normalize with js-yaml dump -> persist with version bump
- **Zod schema** (`config-schema.ts`): `HarnessSystemConfigSchema` validates detectors (record), strategies (array), isolation (optional object)

### 4.3 Action Registry - 9 Registered Handlers
- **File**: `packages/server/src/services/harness/action-registry.ts` (131 lines)

| Action Type | Handler File | Description |
|-------------|-------------|-------------|
| `inject_message` | `actions/inject-message.ts` | Calls `RepairService.intervene()` to inject message into agent session |
| `agent_takeover` | `actions/agent-takeover.ts` | Returns `delegate: true` signal for Layer 3 |
| `modify_varpool` | `actions/modify-varpool.ts` | Calls `RepairService.patchVarPool()` to modify variables |
| `modify_definition` | `actions/modify-definition.ts` | Calls `RepairService.reloadWorkflow()` to hot-reload YAML |
| `switch_model` | `actions/switch-model.ts` | Returns `modelOverride` for onBeforeRetry callback |
| `retry_with_hint` | (inline in registry) | Returns `harnessHint` for VarPool injection |
| `abort` | (inline in registry) | Returns success with abort reason |
| `pause` | (inline in registry) | Returns pause result with optional notify flag |
| `pause_and_notify` | (inline in registry) | Returns pause+notify result |

### 4.4 Preference-to-Model Mapping
- **Files**: `detector-pipeline.ts` L57-61 and `actions/switch-model.ts` L12-16
- Both define identical maps:
  - `vision_capable` -> `"claude-sonnet-4-20250514"`
  - `tool_capable` -> `"claude-sonnet-4-20250514"`
  - `default` -> `"claude-sonnet-4-20250514"`

---

## 5. Current Execution Flow After Blocking

### 5.1 Three Harness Callbacks in Engine
- **File**: `packages/engine/src/engine.ts`
- All three are **optional** on `EngineCallbacks` (L70-97)

#### 5.1.1 `onBeforeNode` (L71-78, engine.ts L852-869)
- **When**: Before `executor.execute()` in `executeSingleNode()`
- **Input**: `(nodeId, nodeType, nodeConfig: NodeDef)`
- **Return options**:
  - `"proceed"` -> continue normal execution
  - `"skip"` -> return `{ outputs: {}, status: "skipped", durationMs: 0, logLines: ["Skipped by harness"] }`; calls `onNodeEnd("skipped", ...)`
  - `"override"` -> return the provided `overrideResult` directly; calls `onNodeEnd(overrideResult.status, ...)`

**After skip/override**: The result is returned to the caller (`executeSingleNodeWithRetry`), which treats it as a normal node result. If `status === "skipped"`, the engine sequential executor continues to the next node (skipped is not a failure).

#### 5.1.2 `onBeforeRetry` (L80-89, engine.ts L971-993)
- **When**: In `executeSingleNodeWithRetry()`, after failure classification but before the retry delay sleep
- **Input**: `(nodeId, attempt, lastResult)`
- **Return options**:
  - `"retry"` -> proceed with normal retry (optionally with `harnessHint` and `modelOverride`)
  - `"skip"` -> return `{ ...result, status: "skipped" }` immediately
  - `"abort"` -> return `{ ...result, status: "failed" }` immediately
  - `"override"` -> return the provided `overrideResult`
- **Side effects**:
  - `harnessHint` -> `pool.set("harness_hint", hint)` - writes to VarPool (L987)
  - `modelOverride` -> shallow-copies node with new model: `effectiveNode = { ...effectiveNode, model: ... }` (L991)

**After abort**: Returns `status: "failed"` to the sequential executor, which then applies the workflow `failure_strategy` (fail_fast/continue/skip). If fail_fast, the **entire execution stops** with `status: "failed"`.

**After skip**: Returns `status: "skipped"`, which the sequential executor treats as non-failure -> continues to next node.

#### 5.1.3 `onFailureDecision` (L91-97, engine.ts L1219-1234)
- **When**: In `executeNodesSequential()`, after a node fails and the failure_strategy is about to be applied
- **Input**: `(nodeId, error, currentStrategy)`
- **Return options**:
  - `"continue"` -> set `hasPartialFailure = true`, call `onError`, `continue` to next node (L1224-1227)
  - `"abort"` -> (not implemented in engine; falls through to normal fail_fast logic)
  - `"delegate"` -> set `pausedAt = node.id`, return `{ status: "paused", pauseReason: "harness_delegate" }` (L1229-1233)

**After delegate**: The **entire execution pauses** with `status: "paused"`. The engine sets `pausedAt` to the failing node ID. The execution can later be resumed via `retryFrom()`.
### 5.2 Complete Blocking Flow (ProcessConflict - critical severity)

The end-to-end flow for a process_conflict block:

1. **Engine calls `onBeforeNode(nodeId, "bash", nodeConfig)`** (engine.ts L853)
2. **DetectorPipeline proxy intercepts** (detector-pipeline.ts L396-421):
   - Routes `beforeNode` event to all detectors
   - `ProcessConflictDetector.observe()` scans script -> returns `DiagnosisReport` with `severity: "critical"`
   - `synchronouslyStorePendingAction(report)` is called:
     - Matches strategy -> `process_conflict` has `severity: critical` + `abort` action
     - Stores `PendingBlockAction { action: "skip", overrideResult: { status: "failed", error: "Blocked by harness: process conflict" } }` in `pendingBlockActions` map
     - Calls `updateNodeHarnessStatus(nodeId, "harness_blocked", report)` -> updates DB + inserts agent_event
   - Checks `pendingBlockActions.get(nodeId)` -> found -> deletes and returns the block action
3. **Engine receives `{ action: "skip" }`** (engine.ts L855)
   - The engine checks `decision.action === "skip"` first (L855), so it returns `status: "skipped"` with `logLines: ["Skipped by harness"]`
   - The `overrideResult` in the PendingBlockAction has `status: "failed"` - this is NOT used because the engine skip branch (L855-862) creates its own result, ignoring the overrideResult.
   - **Result**: The node gets `status: "skipped"` (not "failed"), and the engine continues to the next node.
4. **After the node returns "skipped"**: In `executeNodesSequential()`, "skipped" is neither a failure nor success requiring special handling, so the engine **continues** to the next node without triggering failure_strategy.

**Key insight**: When harness blocks a node via `onBeforeNode`, the node status becomes `"skipped"` (not "failed"), and **the execution continues** past the blocked node. The blocked node does NOT stop the whole workflow.

### 5.3 Timeout Cascade Flow

1. `TimeoutCascadeDetector` produces a `critical` DiagnosisReport after N consecutive timeouts
2. `handleDiagnosis()` persists report + emits SSE + routes to StrategyEngine
3. StrategyEngine matches `timeout_cascade` strategy -> executes `pause` action with `notify: true`
4. The `pauseHandler` returns `{ success: true, action: "pause" }` - but this is **informational only**
5. **No pending action is stored** for timeout_cascade (it is not a retry/varpool/abort scenario)
6. The engine normal failure handling proceeds: the timed-out node has `status: "failed"`, which triggers `onFailureDecision`
7. If no pending failure action exists, the engine applies `failure_strategy` (default: `fail_fast`) -> **execution stops** with `status: "failed"`

**Key insight**: The timeout_cascade strategy `pause` action is currently **advisory** - it does not actually pause the engine. The engine's own failure_strategy determines what happens. To actually pause, the `onFailureDecision` would need to return `{ action: "delegate" }` or the strategy would need to produce a pending failure action.

### 5.4 Stupid Retry Flow

1. `StupidRetryDetector` triggers on `nodeRetry` event when `retryCount >= threshold` and `errorHash` matches
2. `synchronouslyStorePendingAction()` extracts `retry_with_hint` -> stores `PendingRetryAction { action: "retry", harnessHint: "..." }`
3. Engine calls `onBeforeRetry` -> Proxy finds pending action -> returns `{ action: "retry", harnessHint: "..." }`
4. Engine writes `pool.set("harness_hint", hint)` -> next retry attempt can read `$vars.harness_hint`
5. **Execution continues** with the retry, now with the harness hint in VarPool

### 5.5 Model Mismatch Flow

1. `ModelMismatchDetector` triggers on `agentEvent` with `type: "error"`, `code: "400"`, matching vision/tool patterns
2. `synchronouslyStorePendingAction()` extracts `switch_model` -> resolves preference -> stores `PendingRetryAction { action: "retry", modelOverride: "claude-sonnet-4-20250514" }`
3. Engine calls `onBeforeRetry` -> returns `{ action: "retry", modelOverride: "..." }`
4. Engine creates shallow copy: `effectiveNode = { ...effectiveNode, model: "claude-sonnet-4-20250514" }`
5. Next retry uses the new model
6. **Execution continues** with the model-switched retry

---

## 6. Harness Node Statuses

### 6.1 Defined in Shared Types
- **File**: `packages/shared/src/harness/types.ts` (L52-57)

```typescript
export type HarnessNodeStatus =
  | "harness_intervening"  // harness is analyzing and executing intervention
  | "harness_modified"     // harness modified script/vars/definition, will retry
  | "harness_executed"     // harness agent takeover completed
  | "harness_blocked"      // harness blocked this node (process conflict)
```

### 6.2 Status Semantics

| Status | When Set | Set By | Meaning |
|--------|----------|--------|---------|
| `harness_intervening` | DiagnosisReport produced | `DetectorPipeline.updateNodeHarnessStatus()` (L224) | Harness detected an anomaly and is analyzing/acting on it |
| `harness_modified` | After harness modifies something | Spec design (not seen in current code paths explicitly) | Harness changed script/vars/definition, node will retry with modifications |
| `harness_executed` | After agent takeover completes | Spec design (not seen in current code paths explicitly) | Layer 3 agent delegation completed the node work |
| `harness_blocked` | Critical process_conflict detected | `DetectorPipeline.synchronouslyStorePendingAction()` (L295) | Node was prevented from executing due to process conflict |

### 6.3 How Status is Persisted
- **DB column**: `node_executions.harness_status` (TEXT, nullable) - `schema.sql` L87
- **Update mechanism**: `DetectorPipeline.updateNodeHarnessStatus()` (L507-553)
  - Direct SQL: `UPDATE node_executions SET harness_status = ? WHERE id = ?`
  - Also inserts/updates an `agent_events` row with `event_type = "harness_{detector}"` for log viewer visibility
  - Escalation handling: if a harness event already exists for the node, updates content in-place (L532-541)

### 6.4 Related Status: HarnessDirective (inject)
- Defined in `types/octopus-agent.ts` (not in harness/types.ts), extended with `"inject"` type
- Used by the harness-intervene API to support chatbot-initiated interventions

---

## 7. Data Model Summary

### 7.1 New Tables
| Table | Purpose | Key Columns |
|-------|---------|-------------|
| `harness_events` | Audit trail of all harness activity | id, execution_id, node_id, event_type (diagnosis/intervention/delegation/blocked), report_json, action_json, result_json, token_usage_json |
| `harness_config` | Per-workspace harness.yaml overrides | id=default, config_yaml, version (auto-increment) |

### 7.2 Altered Tables
| Table | New Column | Type | Purpose |
|-------|-----------|------|---------|
| `node_executions` | `harness_status` | TEXT | Current harness state for the node |
| `node_executions` | `harness_interventions` | TEXT (JSON) | Intervention history JSON |
| `node_token_usages` | `source` | TEXT DEFAULT node | Distinguishes node vs harness token usage |

### 7.3 DAO
- **File**: `packages/server/src/db/dao/harness-dao.ts` (155 lines)
- `insertEvent()`, `findEvents()` (with type/severity filters), `countEvents()`
- `getConfig()`, `saveConfig()` (upsert with version bump)
- `insertHarnessTokenUsage()` (upsert with accumulation on conflict)

---

## 8. SSE Events

### 8.1 Defined Event Types
- **File**: `packages/shared/src/harness/types.ts` (L61-93)

| Event | Data Shape | Emitted By |
|-------|-----------|------------|
| `harness_diagnosis` | `{ executionId, report: DiagnosisReport }` | DetectorPipeline.handleDiagnosis() |
| `harness_intervention` | `{ executionId, nodeId, action, result, success, modelOverride, harnessHint }` | StrategyEngine.emitInterventionSSE() |
| `harness_delegation` | `{ executionId, nodeId, agentSessionId, status }` | AgentDelegationService.emitDelegationSSE() |
| `harness_blocked` | `{ executionId, nodeId, reason, pattern }` | StrategyEngine.emitBlockedIfNeeded() |

### 8.2 Emission Infrastructure
- Uses existing `SSEService.emit(workspaceId, event)` - workspace-scoped
- All emissions wrapped in try/catch - failures are non-fatal (logged to console.error)

---

## 9. Detector Details

### 9.1 Base Detector
- **File**: `packages/server/src/services/harness/base-detector.ts` (102 lines)
- Abstract class with `observe(event) -> DiagnosisReport | null`
- Lifecycle: `reset()` at execution start, `destroy()` at execution end
- Events: discriminated union of 6 types - `nodeStart`, `nodeEnd`, `nodeRetry`, `agentEvent`, `beforeNode`, `error`

### 9.2 StupidRetryDetector
- **File**: `detectors/stupid-retry.ts` (121 lines)
- **Triggers on**: `nodeRetry` events
- **Logic**: Per-node state tracking (Map of nodeId to NodeRetryState). Compares `computeErrorHash()` across retries. Fires when `retryCount >= threshold` AND errorHash matches.
- **Resets**: After firing (deletes node state) or when error hash changes
- **Severity**: `warning`

### 9.3 ModelMismatchDetector
- **File**: `detectors/model-mismatch.ts` (64 lines)
- **Triggers on**: `agentEvent` with `type: "error"` and `code: "400"`
- **Patterns**: `/vision/i`, `/tool not supported/i`, `/model does not support/i`, `/not support.*capability/i`, `/capability.*not.*support/i`
- **Severity**: `warning`
- **Stateless**: No per-node tracking needed

### 9.4 ProcessConflictDetector
- **File**: `detectors/process-conflict.ts` (211 lines)
- **Triggers on**: `beforeNode` events for `bash` and `python` node types
- **Two detection layers**:
  1. **PID patterns**: Direct `kill/pkill/taskkill` referencing host PID or `$OCTOPUS_HOST_PID`; indirect variable tainting (VAR=$OCTOPUS_HOST_PID then kill $VAR); Python `os.kill` with host PID
  2. **Port patterns**: `listen/serve/--port` binding to host ports; `nc/socat` on host ports
- **Severity**: `critical`
- **Config**: Takes `hostPid` and `hostPorts[]` at construction

### 9.5 TimeoutCascadeDetector
- **File**: `detectors/timeout-cascade.ts` (104 lines)
- **Triggers on**: `nodeEnd` events
- **Stateful**: Tracks `consecutiveTimeouts` counter and `recentTimeoutNodes[]`
- **Timeout detection**: Error message contains "timeout" / "timed out" (regex), or checks logLines
- **Resets on**: Successful node completion OR non-timeout failure OR after firing
- **Severity**: `critical`

---

## 10. HarnessController - Orchestrator

- **File**: `packages/server/src/services/harness/harness-controller.ts` (159 lines)
- **One instance per server**, manages per-execution pipelines via `Map<executionId, DetectorPipeline>`
- **`onExecutionStart(executionId, workspaceId, originalCallbacks, opts?)`**:
  1. Cleans up any existing pipeline for this execution (defensive)
  2. Loads merged config via `HarnessConfigService.loadMergedConfig()`
  3. Creates `AgentDelegationService` (Layer 3)
  4. Creates `StrategyEngine` (Layer 2) with strategies from config
  5. Creates `DetectorPipeline` (Layer 1) with config + strategy engine
  6. Wraps `originalCallbacks` via `pipeline.wrapCallbacks()` -> returns wrapped callbacks
- **`onExecutionEnd(executionId)`**: Destroys pipeline and detectors
- **Circular dependency**: `setRepairService()` breaks the ExecutionService -> ExecutionLifecycle -> HarnessController -> RepairService -> ExecutionService cycle

---

## 11. DetectorPipeline - Proxy-Based Callback Wrapping

- **File**: `packages/server/src/services/harness/detector-pipeline.ts` (571 lines)
- **Core mechanism**: `wrapCallbacks(callbacks)` returns a `Proxy<EngineCallbacks>` that intercepts:
  - **Decision callbacks** (always intercepted, even if target lacks them):
    - `onBeforeRetry` -> consumes `pendingActions` map
    - `onFailureDecision` -> consumes `pendingFailureActions` map
    - `onBeforeNode` -> routes `beforeNode` events to detectors, checks `pendingBlockActions`
  - **Observation callbacks** (only when target provides them):
    - `onNodeStart` -> routes `nodeStart` event
    - `onNodeEnd` -> routes `nodeEnd` event + **cleans up ALL pending decisions** (BP-10 memory leak prevention)
    - `onNodeRetry` -> routes `nodeRetry` event + synchronously stores pending actions (BP-2)
    - `onAgentEvent` -> routes `agentEvent` event
    - `onError` -> routes `error` event

### 11.1 Synchronous Action Extraction (BP-2)
- **Method**: `synchronouslyStorePendingAction(report)` (L273-335)
- Called from `onNodeRetry` proxy after `routeEvent()` produces reports
- Matches strategy synchronously, extracts `harnessHint`/`modelOverride` from action definitions
- Also stores block actions for CRITICAL + abort strategies (BP-5)
- Stores delegate decisions when `delegate_to_agent: true`

### 11.2 Pending Decision Maps (3 maps)
| Map | Key | Populated By | Consumed By |
|-----|-----|-------------|-------------|
| `pendingActions` | nodeId | `synchronouslyStorePendingAction()` on nodeRetry | `onBeforeRetry` proxy |
| `pendingFailureActions` | nodeId | `synchronouslyStorePendingAction()` or `handleDiagnosis()` async | `onFailureDecision` proxy |
| `pendingBlockActions` | nodeId | `synchronouslyStorePendingAction()` on beforeNode (critical+abort) | `onBeforeNode` proxy |

---

## 12. Error Hash Computation

- **File**: `packages/shared/src/harness/utils.ts` (38 lines)
- `computeErrorHash(result)`: Extracts error lines (filtering for "error"/"Error"), concatenates with `result.error` and `exitCode`, takes first 500 chars, applies `simpleHash()`
- `simpleHash(str)`: djb2-style non-cryptographic hash, returns base-36 absolute value
- Used by `StupidRetryDetector` to compare whether two failures are the same

---

## 13. Test Fixtures

Three test workflow YAML files exist in `packages/engine/src/__tests__/fixtures/`:
- `harness-test-stupid-retry.yaml`
- `harness-test-model-mismatch.yaml`
- `harness-test-process-conflict.yaml`

---

## 14. Summary of Gaps and Observations

1. **Ticket 08 (UI Floating Panel) is NOT implemented** - status is `ready-for-agent` with all ACs unchecked
2. **Ticket 05 (Process Isolation)** - issue has unchecked ACs though status is "done"
3. **Ticket 07 (Config Loader UI)** - issue has unchecked ACs though status is "done"
4. **No server CONTEXT.md** exists
5. **No harness-specific agent definition** in `core-pack/agents/` - Layer 3 uses inline LLM calls
6. **Timeout cascade `pause` action is advisory** - does not actually pause the engine; relies on engine failure_strategy
7. **Process conflict blocking results in `status: "skipped"`** (not "failed") because `onBeforeNode` returns `{ action: "skip" }`, and the engine skip branch creates its own result ignoring the overrideResult
8. **Model mapping is hardcoded** to `claude-sonnet-4-20250514` for all preferences - should be configurable
9. **`harness_modified` and `harness_executed` statuses** are defined in types but not explicitly set in the current code paths (only `harness_intervening` and `harness_blocked` are set by `updateNodeHarnessStatus()`)
