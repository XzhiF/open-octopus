# Story Walk-Through Report: octopus-agent-ui-wiring

> **Analyst**: Story Walk-Through sub-agent
> **Spec analyzed**: `.scratch/octopus-agent-ui-wiring/spec.md`
> **Codebase state**: 2026-08-04, branch `main`

---

## Executive Summary

The spec describes 4 core stories to wire up the `octopus_agent` node UI. Walk-through analysis reveals **15 break points** across 4 stories:

| Severity | Count | Summary |
|----------|-------|---------|
| CRITICAL | 5 | Data never reaches UI; component doesn't exist; routes already mounted (spec premise wrong) |
| HIGH | 6 | Type gaps, missing event production, data flow mismatches |
| MEDIUM | 3 | UX degradation, info tab data unavailability |
| LOW | 1 | Path documentation mismatch |

**Most significant finding**: Story 4 (version routes) is already fully implemented — the spec's premise that routes return 404 is incorrect. Stories 1 and 3 share a root cause: the `ObservabilityService` explicitly filters heartbeat/harness events from persistence, blocking the entire data pipeline.

---

## Story 1: Heartbeat Real-Time Display

### Step-by-Step Trace

```
User opens workflow with octopus_agent node
  │
  ├─[UI] OctopusAgentNode renders (StatusShell + TypeShell)
  │       Status: ✅ Component exists (octopus-agent-node.tsx, 124 lines)
  │       Registered in nodeTypes map (workflow-flow-viewer-with-status.tsx:63)
  │
  ├─[UI] User executes workflow → node enters "running"
  │       Status: ✅ StatusShell provides marching-ants border animation
  │              TypeShell shows live elapsed timer via useLiveTimer hook
  │
  ├─[API] GET /agent-events polls every 2s via useExecutionEvents
  │       Status: ✅ Endpoint exists (execution.ts:437)
  │               ✅ Hook polls at 2s interval (use-execution-events.ts)
  │       ← [断点A] Response NEVER contains heartbeat data
  │          Root cause: ObservabilityService.filterEvent() returns null
  │          for heartbeat/harness_directive/heartbeat_stall (observability.ts:250)
  │       ← [断点B] AgentEventsResponse type has no `heartbeat` field (types.ts:750)
  │       ← [断点C] heartbeats.jsonl is written by EngineCallbacks but never
  │          read by the agent-events API route
  │
  ├─[UI] statusOverlay passed to OctopusAgentNode
  │       ← [断点D] statusOverlay construction (lines 259-276) never sets
  │          a `heartbeat` property — only stepStatus/duration/tokenUsage
  │       ← [断点E] StatusOverlay interface (types.ts:96-103) has no
  │          `heartbeat` field at all
  │
  ├─[UI] OctopusAgentNode reads data.statusOverlay?.heartbeat
  │       Status: ✅ Component code correctly reads and renders heartbeat
  │       ← But heartbeat is ALWAYS undefined → renders nothing
  │
  └─[Data] heartbeat persisted to agent_events table
          Status: ❌ FALSE — explicitly filtered OUT
          heartbeats go to heartbeats.jsonl (EngineCallbacks.ts:246-261)
          but this file is orphaned (no reader)
```

### Break Points

| ID | Severity | Description | Fix |
|----|----------|-------------|-----|
| BP-1A | CRITICAL | `ObservabilityService.filterEvent()` returns `null` for heartbeat events — they are never written to SQLite | Either remove the filter to persist heartbeat events to `agent_events`, OR add a separate read path for `heartbeats.jsonl` in the agent-events API route |
| BP-1B | HIGH | `AgentEventsResponse` interface has no `heartbeat` field | Add `heartbeat?: AgentHeartbeat` to the response type |
| BP-1C | HIGH | `heartbeats.jsonl` is written but never read by any endpoint | Add a reader in the agent-events route, or create a dedicated `GET /:execId/heartbeats` endpoint |
| BP-1D | CRITICAL | `statusOverlay` construction never sets `heartbeat` | In `workflow-flow-viewer-with-status.tsx`, extract heartbeat from polled data and inject into statusOverlay |
| BP-1E | HIGH | `StatusOverlay` type has no `heartbeat` field | Add `heartbeat?: AgentHeartbeat` to the `StatusOverlay` interface |

### Spec Assumption Errors

The spec says (line 81-86):
> "useExecutionEvents (2s poll) → GET /agent-events → 解析 heartbeat 事件 → 注入 statusOverlay.heartbeat"

This data path does NOT exist today. The spec correctly identifies the gap but understates the work — it's not just "connecting wires", it requires changes across 3 layers (persistence, API response, UI injection).

The spec says (Key Decision D4):
> "HTTP 轮询...复用现有 useExecutionEvents 机制"

This is viable but the spec doesn't address the fundamental blocker: `ObservabilityService` filtering. The decision should acknowledge this prerequisite change.

### SSE Alternative

The server emits `agent_heartbeat` SSE events (EngineCallbacks.ts:236), but no frontend code subscribes. The spec explicitly says "不改变 SSE 架构（不添加新的 SSE listener）" — so HTTP polling with REST changes is the chosen path. This is architecturally consistent but requires more server-side work than the spec implies.

---

## Story 2: Detail Panel

### Step-by-Step Trace

```
User right-clicks octopus_agent node → "查看信息"
  │
  ├─[UI] Right-click context menu fires handleNodeContextMenu
  │       Status: ✅ Works for all node types including octopus_agent
  │       DropdownMenu renders "查看信息" item correctly
  │
  ├─[UI] handleNodeContextMenu calls getExecutorType(step, nodeType)
  │       ← [断点F] getExecutorType (workflow-detail-panel.tsx:286-299)
  │          has NO case for nodeType === "octopus_agent"
  │          Since octopus_agent steps have step.model set,
  │          the function returns "agent" (line 291: if (step.model) return "agent")
  │          Result: octopus_agent node is MISCLASSIFIED as generic "agent"
  │
  ├─[UI] NodeInfoDialog opens with executorType="agent" (wrong!)
  │       Status: Dialog renders AgentDetailTabs (not OctopusAgentDetailTabs)
  │       ← [断点G] No executorType === "octopus_agent" branch in NodeInfoDialog
  │          (node-info-dialog.tsx:103-159, 9 executor cases, no octopus_agent)
  │
  ├─[UI] OctopusAgentDetailTabs renders 3 tabs
  │       ← [断点H] Component DOES NOT EXIST
  │          No file: octopus-agent-detail-tabs.tsx
  │
  ├─[UI] 追踪 tab → AgentTimeline (per-turn thinking/tool/text)
  │       Status: ✅ AgentTimeline exists (agent-timeline.tsx, 190 lines)
  │       Reusable: YES — executor-agnostic, takes TurnGroup[] data
  │       Hook: useAgentTraces(executionId, nodeId) — works for any node
  │
  ├─[UI] 成本 tab → CostLine + per-model breakdown
  │       Status: ✅ CostLine exists (cost-line.tsx, 57 lines)
  │       Reusable: YES — takes costUsd, turns, tools, durationMs
  │       Hook: useLLMCalls(executionId, nodeId) — works for any node
  │
  └─[UI] 信息 tab → agent name, version, task brief
          ← [断点I] This data lives on OctopusAgentNodeData (ReactFlow node data)
             but NodeInfoDialog only receives StepExecution
             StepExecution does NOT carry agent/version/task_brief fields
```

### Break Points

| ID | Severity | Description | Fix |
|----|----------|-------------|-----|
| BP-2F | CRITICAL | `getExecutorType()` misclassifies octopus_agent as "agent" due to `step.model` check | Add `if (nodeType === "octopus_agent") return "octopus_agent"` BEFORE the `step.model` check |
| BP-2G | CRITICAL | `NodeInfoDialog` has no `executorType === "octopus_agent"` branch | Add a new conditional branch rendering `<OctopusAgentDetailTabs>` |
| BP-2H | CRITICAL | `OctopusAgentDetailTabs` component does not exist | Create `node-detail/octopus-agent-detail-tabs.tsx` with 3 tabs |
| BP-2I | MEDIUM | "信息" tab data (agent name, version, task brief) not available via `StepExecution` | Either: (a) extend `NodeInfoDialogProps` to pass node-level data, (b) fetch from a separate API, or (c) drop the "信息" tab and fold into existing tabs |

### Spec Assumption Errors

The spec correctly identifies that `OctopusAgentDetailTabs` needs to be created. However, it understates the "信息" tab challenge — the spec's `OctopusAgentDetailTabsProps` interface includes `agentName` and `version`, but doesn't explain how these values reach the component from `NodeInfoDialog`.

The `getExecutorType()` misclassification is not mentioned in the spec at all. Without fixing this, the dialog would open `AgentDetailTabs` (2 tabs: 追踪/成本) instead of `OctopusAgentDetailTabs` (3 tabs: 追踪/成本/信息). The user would see a functional but wrong panel.

### Positive Findings

- AgentTimeline is fully reusable (no executor-type coupling)
- CostLine is fully reusable
- Right-click context menu works for all node types
- `useAgentTraces` and `useLLMCalls` hooks are executor-agnostic

---

## Story 3: Log Event Rendering

### Step-by-Step Trace

```
octopus_agent execution produces events
  │
  ├─[Exec] HeartbeatHandler emits heartbeat events
  │       Status: ✅ emitHeartbeat() fires every N tool_result steps
  │              ✅ SSE agent_event + agent_heartbeat emitted by EngineCallbacks
  │
  ├─[Exec] HeartbeatHandler emits harness_directive events
  │       Status: ✅ emitBudgetExceededDirective() fires when budget exceeded
  │              ✅ SSE agent_event + harness_directive emitted
  │
  ├─[Exec] heartbeat_stall event emission
  │       ← [断点J] checkStall() exists but NO CALLER invokes it
  │          heartbeat_stall is a DEAD TYPE — defined but never emitted
  │
  ├─[Data] Events persisted to agent_events table
  │       ← [断点K] ObservabilityService.filterEvent() (line 250)
  │          explicitly returns null for all 3 types
  │          heartbeat → heartbeats.jsonl only (orphaned file)
  │          harness_directive → not persisted anywhere
  │          heartbeat_stall → not persisted anywhere
  │
  ├─[API] GET /agent-events returns event list
  │       ← Events not in SQLite → not in API response
  │       ← [断点L] Even if persisted, UI AgentEvent type (lib/types.ts:715)
  │          has no typed fields for heartbeat/directive data payloads
  │
  ├─[UI] EventIcon switch — heartbeat case
  │       ← [断点M] No case → falls to default Clock icon
  │       ← Activity icon not imported from lucide-react
  │
  ├─[UI] EventLabel switch — heartbeat case
  │       ← [断点M] No case → falls to default raw event name
  │
  ├─[UI] EventIcon/EventLabel — harness_directive cases
  │       ← [断点M] Same — no cases, no AlertTriangle import
  │
  └─[UI] EventIcon/EventLabel — heartbeat_stall case
          ← [断点M] Same — plus event is never produced anyway
```

### Break Points

| ID | Severity | Description | Fix |
|----|----------|-------------|-----|
| BP-3J | HIGH | `heartbeat_stall` type is defined but `checkStall()` has no caller — event is never emitted | Implement a periodic stall checker (timer-based or hook into the execution loop) that calls `checkStall()` and emits the event |
| BP-3K | CRITICAL | All 3 event types filtered from SQLite by `ObservabilityService` | Same root cause as BP-1A — fix the filter or add JSONL persistence path |
| BP-3L | HIGH | UI `AgentEvent` type has no typed fields for heartbeat/directive payloads | Extend the `AgentEvent` interface or create a discriminated union with typed payloads |
| BP-3M | HIGH | `EventIcon` and `EventLabel` have no cases for the 3 event types | Add switch cases per spec design (Activity/AlertTriangle icons, Chinese labels) |
| BP-3N | LOW | `Activity` and `AlertTriangle` icons not imported from lucide-react | Add imports — trivial |

### SSE vs REST Naming Inconsistency

| Event | SSE event name | Proposed REST event name |
|-------|---------------|------------------------|
| heartbeat | `agent_heartbeat` | `heartbeat` |
| harness_directive | `harness_directive` | `harness_directive` |
| heartbeat_stall | `heartbeat_stall` | `heartbeat_stall` |

The `agent_` prefix on `agent_heartbeat` is inconsistent. When implementing the REST response, the event type should be normalized to `heartbeat` (without prefix) to match the engine's `AgentEvent` union type.

### Shared Root Cause with Story 1

BP-3K and BP-1A are the **same break point** — `ObservabilityService.filterEvent()` line 250. Fixing this single filter unlocks both stories. This should be the highest-priority implementation task.

---

## Story 4: Version Management API Fix

### Step-by-Step Trace

```
Server starts up
  │
  ├─[Exec] version-routes mounted
  │       Status: ✅ ALREADY WIRED (server/index.ts:420-421)
  │       app.route("/api/clones", createVersionRoutes())
  │       app.route("/api/agents/main", createMainAgentVersionRoutes())
  │
  ├─[API] GET /api/clones/:name/versions → 200
  │       Status: ✅ Implemented (version-routes.ts:26)
  │
  ├─[API] POST /api/clones/:name/versions → 201
  │       Status: ✅ Implemented (version-routes.ts:82)
  │
  ├─[UI] CloneVersionsTab calls API
  │       Status: ✅ Correctly dispatches to clone or main-agent path
  │              ✅ API client URLs match server routes exactly
  │
  └─[UI] PublishVersionDialog calls publish API
          Status: ✅ Form component + parent handles API call correctly
```

### Break Points

| ID | Severity | Description | Fix |
|----|----------|-------------|-----|
| BP-4O | MEDIUM | Spec says routes are unmounted (404) — this is INCORRECT | Remove Story 4 from the spec entirely. The routes are fully wired. The spec's problem statement, API contracts table, and verification ACs for this story are unnecessary. |

### Spec Premise Error

The spec states (Problem Statement, line 4):
> "版本管理 API 路由文件已写好但未在 index.ts 中注册，导致所有 API 返回 404"

**This is factually wrong.** The routes ARE registered in `server/index.ts` at lines 420-421. They mount directly on the main Hono app, bypassing the agent router. The `version-routes.ts` file is imported and its factory functions are called.

The API paths differ from what the spec documents:

| Spec says | Actual path |
|-----------|-------------|
| `/api/agents/:name/versions` | `/api/clones/:name/versions` |
| `/api/agents/main/versions` | `/api/agents/main/versions` (correct) |

This is not a bug — it's a spec documentation error. The UI and server agree on the actual paths.

### Recommendation

**Remove Story 4 entirely from the spec.** This includes:
- User Story #4
- Implementation Decision for `routes/agent/index.ts`
- AC-9, AC-10 (version API verification)
- API Contracts table entries for version routes
- Appendix "Story 4: 版本管理 API 修复"

---

## Cross-Story Analysis

### Shared Root Cause Map

```
ObservabilityService.filterEvent() returns null for heartbeat events
  │
  ├──→ BP-1A: Heartbeat never in API response (Story 1)
  ├──→ BP-1C: heartbeats.jsonl orphaned (Story 1)
  ├──→ BP-3K: Events never in API response (Story 3)
  └──→ BP-3M: UI cases would have nothing to render (Story 3)

getExecutorType() missing octopus_agent case
  │
  └──→ BP-2F: Wrong detail panel opens (Story 2)
       └──→ BP-2G: NodeInfoDialog has no octopus_agent branch (Story 2)
```

### Implementation Priority Order

Based on dependency analysis:

1. **Fix `ObservabilityService` filter** — unlocks Stories 1 AND 3
2. **Add `heartbeat` to `StatusOverlay` type** — prerequisite for Story 1 UI
3. **Wire heartbeat into `statusOverlay` construction** — closes Story 1
4. **Fix `getExecutorType()`** — one-line fix, prerequisite for Story 2
5. **Add `octopus_agent` branch to `NodeInfoDialog`** — prerequisite for Story 2
6. **Create `OctopusAgentDetailTabs`** — Story 2 main deliverable
7. **Add `EventIcon`/`EventLabel` cases** — Story 3 UI layer
8. **Implement `heartbeat_stall` producer** — Story 3 completeness
9. **Remove Story 4 from spec** — spec cleanup

### Data Flow Integrity Check

| Data Element | Writer | Reader | Connected? |
|-------------|--------|--------|-----------|
| AgentHeartbeat (engine) | HeartbeatHandler.emitHeartbeat() | ??? | ❌ SSE only, no REST path |
| heartbeats.jsonl | EngineCallbacks.onAgentEvent() | (nobody) | ❌ Orphaned |
| statusOverlay.heartbeat | (nobody) | OctopusAgentNode | ❌ Never populated |
| AgentEvent.heartbeat payload | (engine produces) | EventIcon/EventLabel | ❌ Filtered + no UI case |
| executorType="octopus_agent" | getExecutorType() | NodeInfoDialog | ❌ Never returned |
| OctopusAgentDetailTabs | (doesn't exist) | NodeInfoDialog | ❌ No component |
| agent name/version/task_brief | OctopusAgentNodeData (ReactFlow) | "信息" tab | ❌ No data path |

---

## Recommendations for Spec Updates

### Key Decisions to Add

| # | Decision | Conclusion | Reason |
|---|---------|-----------|--------|
| D10 | ObservabilityService filter change | Remove heartbeat/harness filter OR add JSONL reader | Root blocker for Stories 1 & 3 |
| D11 | getExecutorType fix | Add `octopus_agent` case before `step.model` check | Prevents misclassification as generic agent |
| D12 | "信息" tab data source | Extend NodeInfoDialogProps to pass node-level data | StepExecution lacks agent/version/task_brief |
| D13 | heartbeat_stall producer | Implement timer-based stall checker | Type exists but no emitter |
| D14 | SSE naming normalization | Use `heartbeat` (not `agent_heartbeat`) in REST responses | Consistency with engine AgentEvent union |

### ACs to Add

| AC | Description | Verification |
|----|-------------|-------------|
| AC-15 | ObservabilityService no longer filters heartbeat/harness events from agent_events | Unit test: persist heartbeat event, query agent_events, assert present |
| AC-16 | getExecutorType returns "octopus_agent" for octopus_agent nodes | Unit test: pass nodeType="octopus_agent", assert return value |
| AC-17 | StatusOverlay type includes optional heartbeat field | TypeScript compilation check |

### ACs to Remove

| AC | Reason |
|----|--------|
| AC-9 | Story 4 is already implemented — no work needed |
| AC-10 | Story 4 is already implemented — no work needed |

### Risk Additions

| Risk | Description |
|------|-------------|
| R3 | "信息" tab requires extending the data flow from ReactFlow node data through to NodeInfoDialog — this is the most architecturally uncertain part of Story 2 |
| R4 | Removing the ObservabilityService filter may increase agent_events table size for long-running octopus_agent executions. Consider a retention/cleanup policy. |
| R5 | heartbeat_stall requires a new timer/thread in the engine executor. This contradicts the spec's "Don't" list item "不修改 OctopusAgentExecutor 引擎逻辑" — needs scope decision. |

### Scope Conflict

The spec says "不修改 OctopusAgentExecutor 引擎逻辑" but `heartbeat_stall` production requires engine-side changes (implementing a stall checker caller). Either:
- Relax the "Don't" constraint to allow stall checker implementation
- Drop `heartbeat_stall` rendering from Story 3 (keep heartbeat + harness_directive only)
- Accept that stall detection will come from a server-side timeout rather than engine emission
