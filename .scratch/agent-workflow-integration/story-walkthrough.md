# Story Walk-Through Analysis
## Agent Workflow Integration — Version Management + octopus_agent Node + Delegation Protocol

> Analysis Date: 2026-08-04
> Spec: `.scratch/agent-workflow-integration/spec.md`
> Codebase State: main branch, schema v32, 10 node types, 35+ DB tables

---

## Executive Summary

The spec proposes 3 major subsystems — **version management**, **octopus_agent executor**, and **delegation protocol** — none of which have any existing infrastructure in the codebase. Every story step requires net-new code. However, the spec's design decisions are largely sound: the existing `AgentExecutor` + `AgentNodeRunner` provides a solid foundation to extend, the `sessions` table already has `session_type` for delegate sessions, and the `EngineCallbacks` surface is broad enough to accommodate heartbeat events.

**Critical findings**: 4 break points that would block stories from functioning at all.
**High findings**: 6 break points that would cause incorrect behavior or silent failures.
**Medium findings**: 5 naming/integration gaps.

---

## Codebase State Inventory

### What EXISTS ✅

| Area | Status | Location |
|------|--------|----------|
| Clone CRUD routes | ✅ `/api/clones` (9 endpoints) | `routes/clone/index.ts` |
| Clone lifecycle routes | ✅ `/api/agent/clones/*` | `routes/agent/clone-routes.ts` |
| Clone file operations | ✅ `/api/clones/:name/files/*` | `routes/agent/clone-files.ts` |
| Execution pause/resume | ✅ `POST /:executionId/pause`, `/resume` | `routes/execution.ts` |
| Execution abort | ✅ `POST /executions/:execId/abort` | `routes/workflow-ops` |
| Repair intervene | ✅ `POST /:executionId/repair/intervene` | `routes/repair.ts` |
| `clones` table | ✅ 11 columns (no version tracking) | `db/schema.sql:402` |
| `sessions` table | ✅ Has `session_type` column (default 'main') | `db/schema.sql:368` |
| `node_executions` table | ✅ Full lifecycle tracking | `db/schema.sql:69` |
| Filesystem path utils | ✅ 14 functions, base `~/.octopus/agent/` | `services/agent/paths.ts` |
| Clone resolver | ✅ Filesystem-first resolution | `services/agent/clone-resolver.ts` |
| ExecutionLifecycle | ✅ 1477 lines, full orchestrator | `services/execution/` |
| EngineCallbacks bridge | ✅ 15 callbacks → SSE + DB | `services/execution/` |
| SSE service | ✅ Generic pub/sub, 27+ event types | `services/sse.ts` |
| 10 executor types | ✅ Full coverage | `executor-factory.ts` |
| AgentNodeRunner | ✅ Streaming, retry, idle timeout | `executors/agent-runner.ts` |
| Internal heartbeat | ✅ 30s polling → logLines only (not surfaced) | `executors/agent.ts` |
| AgentEvent type | ✅ 9 event variants | `executors/agent-types.ts` |
| NodeDef.type union | ✅ 10 types | `shared/src/types/workflow.ts` |
| VarPool | ✅ Map + dirty tracking + fork/merge | `shared/src/` |
| Clone UI components | ✅ 12 files (list, detail, create, merge) | `web-app/components/agent/clone/` |
| CloneDetailView | ✅ 3-column: files/content/chat | `web-app/components/agent/clone/` |
| Workflow node components | ✅ 18 files, StatusShell→TypeShell pattern | `web-app/components/workspace/workflow-nodes/` |

### What DOES NOT EXIST ❌

| Area | Spec Requires | Impact |
|------|---------------|--------|
| `agent_versions` table | Version CRUD + history | Blocks Stories 1-4, 11 |
| `clones.current_version_id` column | Version pinning | Blocks Story 1 rollback |
| Version routes (`/api/clones/:name/versions/*`) | 6 API endpoints | Blocks Stories 1-4, 11 |
| Version filesystem paths (`versions/` dir) | Snapshot storage | Blocks Stories 1, 4 |
| Version path utilities | `getVersionDir()`, `getVersionSnapshotPath()` | Blocks version FS ops |
| VersionResolver service | Version resolution at execution time | Blocks Stories 5, 6 |
| `octopus_agent` in NodeDef.type | New node type | Blocks Stories 5-10 |
| `octopus_agent` in NodeSchema (Zod) | YAML validation | Blocks Stories 5-10 |
| `octopus_agent` in ExecutorFactory | Executor dispatch | Blocks Stories 5-10 |
| OctopusAgentExecutor class | Core executor logic | Blocks Stories 5-10 |
| `agent_heartbeat` SSE event type | Heartbeat monitoring | Blocks Story 8 |
| `AgentEvent` heartbeat variant | Heartbeat in streaming | Blocks Story 8 |
| Node-level intervene endpoint | `POST /executions/:id/nodes/:nodeId/intervene` | Blocks Story 9 |
| `HarnessDirective` types | Intervention protocol | Blocks Story 9 |
| Delegate session creation | `session_type='delegate'` | Blocks Story 5 |
| TaskContract / StructuredResult types | Delegation protocol | Blocks Stories 5, 7 |
| Versions Tab UI component | Version management UI | Blocks Stories 1-4 |
| OctopusAgentNode UI component | Workflow editor | Blocks Story 5 |
| L3 validation update for `octopus_agent` | Dynamic sub-workflow | Blocks Story 10 |
| `compareVersions()` utility | Maven-style comparison | Blocks version resolution |

---

## Story 1: 发布分身新版本并回滚

### Step-by-Step Trace

| Step | Type | Action | Infrastructure | Status |
|------|------|--------|----------------|--------|
| 1 | [UI] | Open clone workspace detail → Versions Tab | `CloneDetailView` exists (3-column layout) but has **no Versions Tab**. Tab navigation component needs to be created. | ❌ NEEDS CREATION |
| 2 | [UI] | Click "Publish New Version" → input form | `PublishVersionDialog.tsx` does not exist. No version form components anywhere. | ❌ NEEDS CREATION |
| 3 | [API] | `POST /api/clones/workspace/versions` | No version routes exist. Clone routes at `/api/clones` handle CRUD + sessions only. Entire `AgentVersionService` needs creation. | ❌ NEEDS CREATION |
| 4 | [DB] | `SELECT * FROM agent_versions WHERE ...` | `agent_versions` table does not exist. Schema is at v32, needs migration to v33. | ❌ NEEDS CREATION |
| 5 | [FS] | `~/.octopus/agent/versions/workspace/1.0.0/persona.md` exists | `paths.ts` has 14 utilities but **none for `versions/` directory**. The spec's proposed path `~/.octopus/agent/versions/` is a new top-level directory under the agent root. | ❌ NEEDS CREATION |
| 6 | [UI] | Modify workspace persona.md | Persona editing exists in CloneDetailView's content column. ✅ | ✅ EXISTS |
| 7 | [UI] | Publish version "1.1.0" | Same as step 2-5 — all infrastructure missing. | ❌ BLOCKED |
| 8 | [UI] | Click "1.0.0" → "Rollback" | `VersionList.tsx` does not exist. No rollback action UI. | ❌ NEEDS CREATION |
| 9 | [API] | `POST /api/clones/workspace/versions/1.0.0/rollback` | No rollback endpoint. Requires `AgentVersionService.rollback()` which must: (a) read snapshot from DB, (b) copy files to clones dir, (c) update `clones.current_version_id`. | ❌ NEEDS CREATION |
| 10 | [FS] | `~/.octopus/agent/clones/workspace/persona.md` restored | The clones dir path exists (`getCloneDir('workspace')`), but the rollback copy logic doesn't. Must copy from `versions/workspace/1.0.0/persona.md` → `clones/workspace/persona.md`. | ⚠️ PARTIAL — paths exist, copy logic doesn't |
| 11 | [DB] | `clones.current_version_id` points to v1.0.0 | `clones` table has **no `current_version_id` column**. Requires ALTER TABLE migration. | ❌ NEEDS CREATION |

### Break Points

1. **CRITICAL — No version infrastructure at all**: The entire version subsystem (DB table, FS paths, API routes, service layer) needs to be built from scratch. This is the largest single piece of work.

2. **HIGH — Rollback atomicity (R1 risk)**: Step 9-11 require DB write + FS copy to be atomic. The spec mentions "事务" but SQLite transactions don't cover filesystem operations. A failure between DB update and FS copy leaves inconsistent state. Needs a compensating transaction pattern.

3. **MEDIUM — No `persona.md` snapshot strategy**: The spec's snapshot is `{ persona: string, config: object, skills: string[] }` stored as JSON in DB. But the FS structure shows individual files (`persona.md`, `config.yaml`, `skills/`). The rollback in step 10 must materialize the JSON snapshot back into individual files — this reverse mapping is not specified.

### Recommendations

- Build version infrastructure bottom-up: DB schema → paths.ts additions → AgentVersionService → API routes → UI
- Implement FS+DB dual-write with try/catch + FS cleanup on DB failure (or vice versa)
- Define explicit snapshot ↔ filesystem materialization functions
- Consider storing `config.json` instead of `config.yaml` in the version snapshot (the clones dir uses `config.json` per `clone-resolver.ts`, but the spec says `config.yaml`)

---

## Story 2: 在 workflow 中使用 octopus_agent 节点

### Step-by-Step Trace

| Step | Type | Action | Infrastructure | Status |
|------|------|--------|----------------|--------|
| 1 | [API] | Create workflow YAML with `octopus_agent` node | YAML parsing works. But `octopus_agent` is **not in NodeDef.type union** and **not in NodeSchema Zod enum**. Validation will reject this YAML. | ❌ BLOCKED |
| 2 | [API] | `POST /api/workflows/validate` → valid | **No dedicated workflow validation route exists.** Validation is done inline during execution. The spec assumes a standalone validation endpoint that doesn't exist. | ❌ MISSING ENDPOINT |
| 3 | [API] | `POST /api/executions` → execute | Execution creation exists via `ExecutionLifecycle.create()`. But `ExecutorFactory` has **no `octopus_agent` case** — will throw `"Unknown node type: octopus_agent"`. | ❌ BLOCKED |
| 4 | [SSE] | Subscribe → receive `agent_heartbeat` event | **`agent_heartbeat` is not an SSE event type.** The existing `AgentExecutor` has an internal heartbeat monitor (30s polling, 5min threshold) that writes warnings only to `logLines` — never emitted via `callbacks.onAgentEvent` or SSE. The `AgentEvent` union has 9 variants, none is `heartbeat`. | ❌ BLOCKED |
| 5 | [DB] | `SELECT * FROM sessions WHERE session_type='delegate'` | `sessions` table **has `session_type` column** (default 'main'). But no delegate session creation logic exists. The spec proposes `createDelegateSession(node.agent, resolved.version, executionId)` — this function doesn't exist. | ⚠️ SCHEMA READY, LOGIC MISSING |
| 6 | [SSE] | Receive `node_end` event, status='completed' | `onNodeEnd` callback exists and bridges to SSE. ✅ — works once the executor runs. | ✅ EXISTS |
| 7 | [DB] | `SELECT * FROM execution_nodes WHERE node_id='dev-agent'` | **TABLE NAME MISMATCH**: Spec says `execution_nodes`, actual table is `node_executions`. The table has `node_id`, `status`, `outputs` columns. ✅ — but spec uses wrong name. | ⚠️ NAMING ERROR IN SPEC |

### Break Points

4. **CRITICAL — `octopus_agent` type not registered anywhere**: Must be added in 4 places: (a) `NodeDef.type` union in `shared/src/types/workflow.ts`, (b) `NodeSchema` Zod enum, (c) `ExecutorFactory` switch case, (d) `node-icon-config.ts` for UI.

5. **CRITICAL — No OctopusAgentExecutor**: The core executor class doesn't exist. It needs to extend `AgentExecutor` behavior with: version resolution, TaskContract prompt building, heartbeat setup, structured result parsing, and intervention handling. The spec's pseudocode references `versionResolver`, `createDelegateSession`, `buildTaskPrompt`, `setupHeartbeat`, `parseStructuredResult`, `handleIntervention` — all net-new.

6. **HIGH — `agent_heartbeat` event has no path to SSE**: Even after creating the executor, the heartbeat data needs to flow: `OctopusAgentExecutor` → `AgentEvent { type: 'heartbeat' }` → `EngineCallbacks.onAgentEvent` → `SSEService.emit('agent_heartbeat', ...)`. The existing `AgentExecutor` heartbeat writes to `logLines` only. The bridge from `onAgentEvent` to SSE already exists for other event types, but `heartbeat` is a new variant that the SSE layer doesn't recognize or transform.

7. **MEDIUM — No standalone workflow validation endpoint**: Story step 2 assumes `POST /api/workflows/validate` exists. It doesn't. Validation currently happens inline during execution start. Either create the endpoint or remove this step from the story.

### Recommendations

- Add `octopus_agent` to all 4 registration points in a single commit to avoid partial state
- Consider making `OctopusAgentExecutor` a wrapper around `AgentExecutor` rather than an extension — composition over inheritance matches the codebase pattern (see how `SwarmExecutor` is structured)
- For heartbeat, add a new `AgentEvent` variant `{ type: 'heartbeat'; data: AgentHeartbeat }` and wire it through the existing `onAgentEvent` → SSE bridge
- Fix the spec: change `execution_nodes` → `node_executions` throughout
- Either create a `/api/workflows/validate` endpoint or clarify that validation happens at execution start

---

## Story 3: 长任务监控与干预

### Step-by-Step Trace

| Step | Type | Action | Infrastructure | Status |
|------|------|--------|----------------|--------|
| 1 | [API] | Create workflow with budget.max_duration=120 | Same YAML validation issue as Story 2. `BudgetConfig` type doesn't exist. | ❌ BLOCKED |
| 2 | [API] | Execute workflow | Same as Story 2 step 3 — ExecutorFactory will reject `octopus_agent`. | ❌ BLOCKED |
| 3 | [SSE] | Receive multiple heartbeat events | Same as Story 2 step 4 — no `agent_heartbeat` SSE event. | ❌ BLOCKED |
| 4 | [SSE] | Heartbeat shows confidence=0.4, issues=[...] | The `AgentHeartbeat` interface defines `confidence` and `issues` fields. But **who populates these?** The spec's `HeartbeatHandler.emitHeartbeat()` calls `this.estimateConfidence()` and `this.collectIssues()` — these methods are undefined. How does an LLM agent report confidence? | ❌ MAGIC BRIDGE |
| 5 | [API] | `POST /api/executions/{id}/nodes/dev-agent/intervene` | **ENDPOINT DOES NOT EXIST.** Existing endpoints: (a) `POST /:executionId/pause` — execution-level, (b) `POST /:executionId/repair/intervene` — repair-level with `{ nodeId, message }`. Neither matches the spec's node-level intervention with `HarnessDirective`. | ❌ NEEDS CREATION |
| 6 | [SSE] | Receive `node_end` status='paused' | `onNodeEnd` fires with status from `NodeExecutionResult`. The result type includes `'paused'` as a valid status. ✅ — but depends on the pause mechanism working. | ⚠️ DEPENDS ON STEP 5 |
| 7 | [DB] | Verify execution + node status = 'paused' | `executions` table has `status` column. `node_executions` table has `status` column. Existing `pause()` in `ExecutionLifecycle` sets these. ✅ — but the spec's node-level pause is different from the existing execution-level pause. | ⚠️ SEMANTIC MISMATCH |

### Break Points

8. **CRITICAL — Node-level intervention endpoint doesn't exist**: The spec proposes `POST /api/executions/:id/nodes/:nodeId/intervene` with `{ directive: HarnessDirective }`. The closest existing endpoint is `POST /:executionId/repair/intervene` which takes `{ nodeId, message }` — a fundamentally different interface (free-text message vs structured directive). A new endpoint + service method is needed.

9. **HIGH — Pause semantic mismatch**: The existing `ExecutionLifecycle.pause()` pauses the **entire execution**, not a single node. The spec wants node-level pause ("pause just this octopus_agent node"). The engine's `pauseAtNode()` mechanism (referenced in the spec) needs verification — does it exist? The `AgentExecutor` uses `AbortSignal` for cancellation, not per-node pausing.

10. **HIGH — Confidence and issues are Magic Bridge data**: The `AgentHeartbeat` interface includes `confidence: number` and `issues: string[]`. The spec's `HeartbeatHandler` calls `this.estimateConfidence()` and `this.collectIssues()` — but these are undefined methods. There is no mechanism for an LLM agent to self-report confidence or issues mid-execution. The agent stream emits `tool_result`, `text_delta`, etc. — none carry confidence scores.

### Recommendations

- For node-level intervention, extend the existing repair route pattern: mount a new sub-router under `/:executionId/nodes/:nodeId/` or extend `ExecutionLifecycle` with a `pauseNode(nodeId)` method
- Investigate whether `engine.pauseAtNode()` exists — if not, this is a larger engine change than the spec suggests
- For confidence/issues: either (a) define a heartbeat prompt that asks the agent to self-report in a structured format, or (b) remove these fields from the initial implementation and add them in a follow-up iteration
- Consider mapping `HarnessDirective.pause` to the existing `pause()` mechanism as a first approximation, then refine to node-level in a follow-up

---

## Anti-Pattern Analysis

### 1. Magic Bridge 🌉

**BP-04 (Story 3, Step 4)**: `HeartbeatHandler.estimateConfidence()` and `collectIssues()` are called but never defined. The LLM agent stream (`AgentEvent`) has no confidence or issues data. The spec assumes these values materialize from somewhere, but no bridge exists between the agent's execution state and these heartbeat fields.

**BP-06 (Story 2, Step 4)**: The `agent_heartbeat` SSE event requires bridging from `OctopusAgentExecutor` → `AgentEvent` → `EngineCallbacks.onAgentEvent` → `SSEService.emit`. Each hop needs explicit wiring. The existing `onAgentEvent` → SSE bridge passes events through generically, but the SSE consumer layer (web-app) needs to recognize and render `agent_heartbeat` events — no handler exists.

### 2. Orphan Field 📝

**`StructuredResult.vars_update`**: The spec defines `vars_update?: Record<string, any>` for VarPool updates. But the VarPool's `merge()` and `fork()` semantics are non-trivial (dirty tracking, cross-execution `$ref:` resolution). The spec doesn't define how `vars_update` integrates with the existing VarPool merge pipeline. If the `outputs` mapping in `NodeExecutionResult` already handles variable writes (via `applyOutputsMapping`), then `vars_update` may be redundant or conflict.

**`AgentHeartbeat.confidence`**: Even if populated, no consumer is defined. The spec's `HarnessConfig.auto_abort_on_budget` acts on token/duration budget, not confidence. A low-confidence heartbeat has no automated response.

### 3. Silent Failure 🔇

**Version resolution failure during execution**: If `VersionResolver.resolve()` throws `VersionNotFoundError` (e.g., pinned version was archived), the spec doesn't define what happens. Does the node fail? Does the execution fail? Is there a fallback to latest? The `OctopusAgentExecutor.execute()` pseudocode calls `resolve()` at step 1 with no try/catch.

**FS copy failure during publish**: The publish operation writes to both DB and FS. If the FS copy fails (disk full, permission error), the DB record is already written. The spec mentions "事务" and "失败时回滚" but doesn't specify the compensating action (delete the DB row? mark as failed?).

**FS copy failure during rollback**: Rollback copies snapshot files from `versions/` back to `clones/`. If this fails mid-copy (some files copied, some not), the clone is in a partially-restored state. No cleanup or atomic-replacement strategy is specified.

**Heartbeat timeout with no intervention**: The `HeartbeatHandler.checkStall()` method detects stalls (no events for `heartbeat_timeout` seconds) and emits a "stall warning". But what happens next? The spec's `HarnessConfig.auto_abort_on_budget` covers budget, not stalls. A stalled agent just accumulates warnings.

### 4. Missing Trigger 🔔

**Version publish → runtime update**: When a new version is published and the clone's `current_version_id` is updated, no event fires to notify running executions or active sessions. A long-running execution using `version: "latest"` won't pick up the new version mid-flight.

**Version archive → dependent workflows**: When a version is archived (PATCH status='archived'), workflows that pin that version will fail on next execution. No notification or validation occurs.

**Rollback → cache invalidation**: The clone resolver (`clone-resolver.ts`) is filesystem-first. After rollback restores files, any cached clone info in memory is stale. No cache invalidation trigger exists.

### 5. Unversioned State 📊

**Clone persona/config edits between versions**: The spec says "Agent 的配置可以被任意修改". These modifications happen on the filesystem (`~/.octopus/agent/clones/workspace/persona.md`) but are not tracked anywhere until explicitly published as a version. Edits between v1.0.0 and v1.1.0 have no history.

**Heartbeat data**: Heartbeats are emitted via SSE (ephemeral, ring buffer of 500 events) but not persisted to any DB table. After the SSE buffer rolls over, heartbeat history is lost. No `agent_heartbeats` table exists.

### 6. Unconnected Feedback 📡

**`auto_abort_on_budget` consumer**: The `HarnessConfig.auto_abort_on_budget` flag says "auto-abort when budget exceeded". But the `HeartbeatHandler` only emits heartbeats — it doesn't consume them. No component checks `tokens_used > tokens_budget` and triggers an abort. The flag is defined but no automation acts on it.

**Heartbeat `artifacts` field**: The heartbeat reports `artifacts: string[]` (files produced). But no downstream system tracks or validates these artifacts. The `StructuredResult.artifacts` field in the final result serves a similar purpose — duplication with no clear ownership.

---

## Dynamic Sub-Workflow Compatibility (Story 10)

### Critical Blocker: L3 Type Whitelist

The `dynamic-sub-workflow-validation.ts` file has a hardcoded whitelist:

```typescript
const ALLOWED_TYPES = new Set(["agent"])
```

This is enforced in `validateL3Semantics()` — any node with `type !== "agent"` is rejected with:
> `L3: node "{id}" has disallowed type "{type}" — only "agent" is permitted in dynamic sub-workflow DAGs`

Additionally, the generation prompt sent to the LLM includes the constraint:
> `"ALL nodes must have type: \"agent\""`

To support `octopus_agent` in dynamic sub-workflows, **three changes** are needed:
1. Add `"octopus_agent"` to the `ALLOWED_TYPES` set
2. Update the LLM generation prompt to allow the new type
3. Update L1 validation — currently requires every node to have a `prompt` field, but `octopus_agent` uses `task.brief` instead of `prompt`

The third point is a **structural mismatch**: the L1 validator requires `prompt: string` on every node. An `octopus_agent` node has `task: { brief: string }` instead. The L1 validator would reject it before L3 even runs.

---

## Naming & Reference Errors in Spec

| Spec Reference | Actual Codebase | Severity |
|----------------|-----------------|----------|
| `execution_nodes` table | `node_executions` table | MEDIUM — will cause confusion during implementation |
| `POST /api/executions/:id/nodes/:nodeId/intervene` | No such endpoint; closest is `POST /:executionId/repair/intervene` with different interface | HIGH — spec assumes endpoint exists |
| `POST /api/workflows/validate` | No standalone validation endpoint | MEDIUM — validation is inline at execution start |
| `config.yaml` in version snapshot FS structure | Clone resolver uses `config.json` | LOW — inconsistency in file format |
| `engine.pauseAtNode(nodeId)` | Not verified to exist; `ExecutionLifecycle.pause()` pauses entire execution | HIGH — may require engine-level changes |

---

## Structured Break Points Summary

| # | Severity | Story | Step | Finding | Recommended Fix |
|---|----------|-------|------|---------|-----------------|
| BP-01 | **CRITICAL** | 1 | 3-5 | No version infrastructure (DB table, FS paths, API routes, service) | Build bottom-up: schema migration → paths.ts → AgentVersionService → routes → UI |
| BP-02 | **CRITICAL** | 2 | 1-3 | `octopus_agent` not registered in NodeDef, NodeSchema, or ExecutorFactory | Add to all 4 registration points in single commit |
| BP-03 | **CRITICAL** | 2 | 3 | No OctopusAgentExecutor class | Implement as composition wrapper around AgentExecutor |
| BP-04 | **CRITICAL** | 3 | 5 | Node-level intervene endpoint doesn't exist | Create new endpoint + extend ExecutionLifecycle with `pauseNode()` |
| BP-05 | **HIGH** | 2 | 4 | `agent_heartbeat` has no SSE path — existing heartbeat is internal only | Add `heartbeat` variant to AgentEvent, wire through onAgentEvent → SSE bridge |
| BP-06 | **HIGH** | 3 | 4 | `confidence` and `issues` fields have no data source (Magic Bridge) | Define heartbeat prompt protocol or defer to follow-up iteration |
| BP-07 | **HIGH** | 3 | 5-7 | Pause semantic mismatch — execution-level vs node-level | Verify `pauseAtNode()` exists; if not, use execution-level pause as interim |
| BP-08 | **HIGH** | 1 | 9-11 | Rollback atomicity — DB+FS dual-write with no compensating transaction | Implement try/catch with FS cleanup on DB failure, or vice versa |
| BP-09 | **HIGH** | 10 | — | L3 validation whitelist only allows `"agent"`, L1 requires `prompt` field | Update ALLOWED_TYPES, generation prompt, and L1 prompt requirement |
| BP-10 | **HIGH** | 2 | 5 | Delegate session creation logic doesn't exist (schema ready) | Implement `createDelegateSession()` in session service |
| BP-11 | **MEDIUM** | 2 | 7 | Spec references `execution_nodes` — actual table is `node_executions` | Fix spec text |
| BP-12 | **MEDIUM** | 2 | 2 | No standalone workflow validation endpoint | Create endpoint or remove step from story |
| BP-13 | **MEDIUM** | 1 | 5,10 | Version snapshot ↔ filesystem materialization not specified | Define explicit `snapshotToFiles()` and `filesToSnapshot()` functions |
| BP-14 | **MEDIUM** | 3 | — | Heartbeat data is ephemeral (SSE ring buffer only), not persisted | Consider `agent_heartbeats` table or JSONL logging |
| BP-15 | **MEDIUM** | — | — | `config.yaml` vs `config.json` inconsistency between spec and codebase | Align on `config.json` to match existing clone-resolver.ts |
| BP-16 | **LOW** | 1 | — | Version publish has no event/trigger for dependent systems | Add `onVersionPublished` event for future consumers |
| BP-17 | **LOW** | — | — | `auto_abort_on_budget` flag defined but no automation consumer | Implement budget check in HeartbeatHandler or defer flag to follow-up |
| BP-18 | **LOW** | — | — | `vars_update` in StructuredResult may conflict with existing `outputs` mapping | Clarify precedence or merge into single mechanism |

---

## Implementation Order Recommendation

Based on dependency analysis, the recommended build order is:

### Phase 1: Foundation (unblocks Stories 1-4, 11)
1. DB schema migration (v32 → v33): `agent_versions` table + `clones.current_version_id`
2. Path utilities: `getVersionDir()`, `getVersionSnapshotPath()`, `getVersionsBaseDir()`
3. `AgentVersionService`: publish, list, get, diff, rollback, archive
4. API routes: 6 version endpoints
5. Web-app: Versions Tab + VersionList + PublishVersionDialog + VersionDiff

### Phase 2: Types & Registration (unblocks Stories 5-10)
6. Shared types: `OctopusAgentNodeDef`, `TaskContract`, `StructuredResult`, `AgentHeartbeat`, `HarnessDirective`, `BudgetConfig`
7. Version resolver: `VersionResolver`, `compareVersions()`, `stageRank()`
8. Register `octopus_agent` in NodeDef, NodeSchema, ExecutorFactory, node-icon-config

### Phase 3: Executor (unblocks Stories 5-7)
9. `OctopusAgentExecutor`: version resolution + TaskContract prompt + delegate session + structured result
10. Delegate session creation function
11. Task prompt builder

### Phase 4: Observation & Intervention (unblocks Stories 8-9)
12. `AgentEvent` heartbeat variant + `HeartbeatHandler`
13. SSE `agent_heartbeat` event wiring
14. Node-level intervention endpoint + `HarnessDirective` processing

### Phase 5: Dynamic Compatibility (unblocks Story 10)
15. L3 validation whitelist update
16. L1 validation relaxation for `octopus_agent` (no `prompt` required)
17. Generation prompt update

---

## Conclusion

The spec is **well-structured and thorough** in its design decisions, but assumes infrastructure that doesn't exist yet. Every user story is blocked by at least one CRITICAL gap. The good news is that the existing codebase provides solid extension points:

- `AgentExecutor` + `AgentNodeRunner` can be composed (not extended) for `OctopusAgentExecutor`
- `EngineCallbacks` surface is broad enough for heartbeat events
- `sessions` table already supports `session_type` for delegate sessions
- The execution lifecycle already has pause/resume/abort semantics

The primary risk is **underestimating the implementation scope**: the spec describes ~20 new files across 4 packages, a DB migration, and changes to ~15 existing files. This is a multi-phase effort, and the phased approach above minimizes blocked work at each stage.
