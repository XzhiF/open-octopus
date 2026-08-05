# Story Walk-Through Analysis — Harness Gap-Fix

**Date**: 2026-08-05
**Analyst**: Claude (automated)
**Specs analyzed**:
- `.scratch/harness-gap-fix/spec.md` (Gap-Fix spec)
- `.scratch/workflow-engine-harness/spec.md` (Round 1 spec)
- 5 tickets in `.scratch/harness-gap-fix/issues/`

---

## Executive Summary

The gap-fix spec correctly identifies 6 gaps preventing the harness from being a "read-write control system." However, tracing the 3 Appendix stories through the ACTUAL codebase reveals **4 CRITICAL, 3 HIGH, and 3 MEDIUM break points**. The most severe is a **Magic Bridge** in Story 1 and Story 3: the Proxy in `detector-pipeline.ts` routes events to detectors but **never returns intervention decisions back to the engine**. The spec's data flow diagrams assume a return path that simply does not exist in the code.

**Tickets are largely sufficient** but have ordering issues — Ticket 04's dependency on Ticket 01 is correct; Ticket 05 correctly depends on all others. However, Ticket 01 does not fully address the CRITICAL break in `onBeforeNode` (Story 3), which requires a separate mechanism from `onBeforeRetry`.

---

## Story 1: 傻重试自动纠正 — Full Trace

### Expected Flow (from spec)
```
[Exec] bash-build fails → onNodeEnd(failed)
[Exec] RetryPolicy allows → onNodeRetry(attempt: 2)
[Harness] DetectorPipeline Proxy intercepts onNodeRetry:
  → StupidRetryDetector.observe() → DiagnosisReport
  → StrategyEngine.handleReport() → match stupid_retry
  → Action: retry_with_hint → { harnessHint: "先 npm install" }
  → Store in pendingActions["bash-build"]
  → SSE emit harness_intervention
[Exec] 第 3 次重试前: onBeforeRetry(nodeId, attempt, lastResult)
  → Proxy intercepts → query pendingActions["bash-build"]
  → Return { action: "retry", harnessHint: "先 npm install" }
  → Engine pool.set("harness_hint", "先 npm install")
[Exec] 第 3 次执行 uses harness_hint → success
```

### Actual Code Trace

| Step | Code Location | Status | Notes |
|------|--------------|--------|-------|
| bash-build fails | `engine.ts:870` `executeSingleNode()` | ✅ WORKS | Executor runs, returns failed result |
| onNodeEnd(failed) | `engine.ts:892` | ✅ WORKS | Callback fires |
| Proxy intercepts onNodeEnd | `detector-pipeline.ts:204-220` | ✅ WORKS | Routes to all detectors |
| RetryPolicy allows retry | `engine.ts:939-970` `executeSingleNodeWithRetry()` | ✅ WORKS | If pipeline config has retry policy |
| onNodeRetry fires | `engine.ts:999` | ✅ WORKS | Callback fires after backoff calculation |
| Proxy intercepts onNodeRetry | `detector-pipeline.ts:223-239` | ✅ WORKS | Routes to detectors |
| StupidRetryDetector produces report | `detectors/stupid-retry.ts` | ✅ WORKS | Checks errorHash + threshold |
| handleDiagnosis persists + SSE | `detector-pipeline.ts:137-179` | ✅ WORKS | DB insert + SSE emit |
| StrategyEngine.handleReport() | `strategy-engine.ts:140-170` | ⚠️ ASYNC | Called via `.catch()` (fire-and-forget) |
| retry_with_hint action produces harnessHint | `action-registry.ts:18-30` | ✅ WORKS | Returns `{ harnessHint: hint }` |
| **Store in pendingActions** | — | ❌ **MISSING** | **No pendingActions map exists anywhere** |
| **onBeforeRetry Proxy intercept** | — | ❌ **MISSING** | **`onBeforeRetry` is NOT in the Proxy's switch statement** |
| Engine calls onBeforeRetry | `engine.ts:972-993` | ✅ WORKS | Engine correctly calls and processes the result |
| pool.set("harness_hint", ...) | `engine.ts:987` | ✅ WORKS | Engine sets VarPool if decision has harnessHint |

### Break Points in Story 1

#### BP-1: CRITICAL — `onBeforeRetry` NOT intercepted by Proxy
**Anti-pattern**: Magic Bridge

The Proxy in `detector-pipeline.ts:196-272` has cases for `onNodeStart`, `onNodeEnd`, `onNodeRetry`, `onAgentEvent`, `onBeforeNode`, `onError` — but **NOT `onBeforeRetry`** and **NOT `onFailureDecision`**. These two callbacks fall through to the `default` case which returns the original callback untouched.

This means:
- The StrategyEngine runs `retry_with_hint` asynchronously and produces `{ harnessHint: "..." }` in an `InterventionResult`
- But this result is **never stored** in a `pendingActions` map (no such map exists in DetectorPipeline)
- Even if it were stored, the Proxy doesn't intercept `onBeforeRetry` to look it up
- The engine's `onBeforeRetry` at `engine.ts:972` calls the original callback (or nothing), so `harnessHint` is never returned

**Impact**: Story 1 is completely broken. The harness detects the stupid retry, logs it, emits SSE events — but **the intervention never reaches the engine**. The node retries with the same approach and fails again.

**This is exactly what Gap #1 / Ticket 01 is supposed to fix.** The spec's description of the fix (add pendingActions map + Proxy intercept) is correct but the current code has ZERO of this implemented.

#### BP-2: HIGH — StrategyEngine.handleReport() is fire-and-forget
**Anti-pattern**: Unconnected Feedback

In `detector-pipeline.ts:175`:
```typescript
this.strategyEngine.handleReport(report).catch((err) => {
  console.error("[DetectorPipeline] StrategyEngine error:", err)
})
```

The StrategyEngine runs asynchronously. Even if we add `pendingActions`, there is a **race condition**:
1. `onNodeRetry` fires → routes event → detector produces report → handleReport() starts (async)
2. Engine continues to `onBeforeRetry` immediately after `onNodeRetry` (see `engine.ts:999` — `onNodeRetry` fires, then `sleepWithAbort`, but `onBeforeRetry` fires BEFORE `onNodeRetry` at line 972)

**Wait — re-reading engine.ts**: `onBeforeRetry` fires at line 972, THEN `onNodeRetry` fires at line 999. So the ordering is:
```
attempt fails → onNodeEnd(failed) → classify → onBeforeRetry → sleep → onNodeRetry → next attempt
```

This means `onBeforeRetry` fires BEFORE the detector has even seen the retry event! The detector sees `onNodeRetry` (which fires after the sleep), but `onBeforeRetry` already fired and returned before that.

**Impact**: The data flow in the spec is WRONG about ordering. The correct ordering should be:
1. Attempt N fails → onNodeEnd(failed) → detector sees failure
2. **onBeforeRetry** fires → Proxy needs to check pendingActions (which should have been populated by the diagnosis from step 1)
3. sleep
4. onNodeRetry fires → detector sees retry (too late for this attempt)

So the pendingActions should be populated during `onNodeEnd` (when the detector diagnoses the failure), NOT during `onNodeRetry`. This means the detector needs to observe `nodeEnd` events and produce diagnosis THEN, so that by the time `onBeforeRetry` fires, the pending action is already available.

**Actually, looking more carefully at the StupidRetryDetector**: It needs to see 2 failures with the same errorHash. So:
- Attempt 1 fails → onNodeEnd → detector records errorHash (no report yet, threshold not met)
- Attempt 2 fails → onNodeEnd → detector sees 2nd same errorHash → produces DiagnosisReport → StrategyEngine stores in pendingActions
- onBeforeRetry fires → Proxy checks pendingActions → finds harnessHint → returns it

But the timing issue remains: `onBeforeRetry` fires between the failed attempt and the next sleep/retry. So `handleReport()` (async) must complete BEFORE `onBeforeRetry` returns. Since `handleReport` is async and involves DB writes, this is a race condition.

**Recommended fix**: Make the diagnosis → pendingActions path synchronous (or at least await it) in the `onNodeEnd` proxy handler.

---

## Story 2: Chatbot 主动干预 — Full Trace

### Expected Flow (from spec)
```
[UI] User types in chatbot: "告诉 agent-write 分两步写"
[Chatbot] POST /executions/:id/harness-intervene
  body: { nodeId: "agent-write", directive: { type: "inject", message: "..." } }
[Route] type === "inject" → repairService.intervene(executionId, "agent-write", message)
[Agent] agent-write receives injected message → adjusts behavior
```

### Actual Code Trace

| Step | Code Location | Status | Notes |
|------|--------------|--------|-------|
| User types in chatbot | `harness-chatbot.tsx:41` `handleSend()` | ✅ WORKS | Input + send button |
| POST body includes nodeId | `harness-chatbot.tsx:62-70` | ❌ **MISSING** | **Body only has `directive`, no `nodeId` at top level** |
| Server receives request | `routes/execution.ts:400-456` | ✅ WORKS | Route handler exists |
| Server validates nodeId | `routes/execution.ts:422` | ✅ WORKS | `if (!body.nodeId)` → 400 |
| inject delegates to repairService | `routes/execution.ts:430-444` | ✅ WORKS | Creates repairService, calls intervene() |
| repairService.intervene() | `services/repair.ts:319` | ✅ WORKS | Method exists and works |
| **repairService in HarnessController** | `harness-controller.ts:44` | ⚠️ **PARTIAL** | HarnessController accepts repairService, but... |
| **ExecutionLifecycle passes repairService** | `ExecutionLifecycle.ts:122-126` | ❌ **MISSING** | **HarnessController constructed WITHOUT repairService** |

### Break Points in Story 2

#### BP-3: CRITICAL — Chatbot POST body missing `nodeId`
**Anti-pattern**: Orphan Field

In `harness-chatbot.tsx:62-70`:
```typescript
body: JSON.stringify({
  directive: {
    type: "inject",
    reason: text,
    issued_by: "user",
    message: text,
  },
}),
```

The server route at `execution.ts:422` checks `if (!body.nodeId || !body.directive?.type)` and returns 400.

The chatbot **never sends `nodeId`**. The `HarnessChatbotProps` interface (`harness-chatbot.tsx:18-22`) has `workspaceId`, `executionId`, `isRunning` — but **no `currentNodeId` or `nodeId`**.

The `HarnessFloatingPanel` which renders the chatbot (`harness-floating-panel.tsx:376-380`) also doesn't pass nodeId:
```tsx
<HarnessChatbot
  workspaceId={workspaceId}
  executionId={executionId}
  isRunning={isRunning}
/>
```

And `WorkflowDetailPanel` (`workflow-detail-panel.tsx:578-582`) doesn't pass any nodeId to the floating panel.

**Impact**: Every chatbot inject request returns 400. Story 2 is completely broken.

**This is exactly Gap #3 / Ticket 03.** The fix is correct: add `currentNodeId` prop chain from WorkflowDetailPanel → HarnessFloatingPanel → HarnessChatbot.

#### BP-4: HIGH — ExecutionLifecycle doesn't pass repairService to HarnessController
**Anti-pattern**: Orphan Field

In `ExecutionLifecycle.ts:119-126`:
```typescript
this.harnessController = new HarnessController({
  dao: harnessDAO,
  sse,
  configService: harnessConfigService,
  // repairService: ← MISSING
})
```

The `HarnessController` accepts `repairService` as an optional dep (line 22-23), and passes it to `StrategyEngine` (line 80). The `inject_message` action handler checks for `repairService` and returns a failure if it's not available (`actions/inject-message.ts:21-26`).

However, **this only matters for automatic injection** (Story 1's strategy-driven inject_message). For Story 2 (chatbot), the route at `execution.ts:435` creates a **fresh RepairService** via `createRepairServiceForWorkspace(workspaceId)` — so the chatbot path is NOT blocked by this gap.

**Impact**: Automatic `inject_message` actions (from strategies) fail silently (return `{ success: false }`), but chatbot manual injection works. Story 2 is NOT blocked by this, but Story 1's `inject_message` strategy action is.

**This is exactly Gap #2 / Ticket 02.**

---

## Story 3: 进程冲突阻断通知 — Full Trace

### Expected Flow (from spec)
```
[Exec] bash-test prepares to execute "kill $OCTOPUS_HOST_PID"
[Harness] ProcessConflictDetector (onBeforeNode):
  → DiagnosisReport { severity: "critical" }
  → StrategyEngine: match process_conflict → abort
  → SSE emit harness_intervention
  → SSE emit harness_blocked  ← Gap #5 fix
  → onBeforeNode returns { action: "skip" }
[Exec] Node skipped, script not executed
[UI] Panel shows "进程冲突已阻断"
```

### Actual Code Trace

| Step | Code Location | Status | Notes |
|------|--------------|--------|-------|
| bash-test about to execute | `engine.ts:840-870` `executeSingleNode()` | ✅ WORKS | Engine prepares executor |
| onBeforeNode fires | `engine.ts:853-854` | ✅ WORKS | `callbacks.onBeforeNode(nodeId, nodeType, node)` |
| Proxy intercepts onBeforeNode | `detector-pipeline.ts:247-260` | ⚠️ PARTIAL | Routes event to detectors, BUT... |
| ProcessConflictDetector observes | `detectors/process-conflict.ts:109-138` | ✅ WORKS | Scans script, finds kill pattern |
| DiagnosisReport produced | `process-conflict.ts:140-168` | ✅ WORKS | Returns critical report |
| handleDiagnosis → persist + SSE | `detector-pipeline.ts:137-179` | ✅ WORKS | Emits harness_diagnosis |
| StrategyEngine.handleReport() | `strategy-engine.ts:140-170` | ⚠️ ASYNC | Called via `.catch()`, fire-and-forget |
| Match process_conflict strategy | `strategy-engine.ts:78-97` | ✅ WORKS | Exact match + severity filter |
| Execute abort action | `action-registry.ts:32-42` | ✅ WORKS | Returns `{ success: true, action: "abort" }` |
| **Return skip to engine** | — | ❌ **BROKEN** | **Proxy returns original callback's result, not skip** |
| **Emit harness_blocked SSE** | — | ❌ **MISSING** | **No code emits harness_blocked anywhere in server** |
| Engine processes skip | `engine.ts:855-862` | ✅ WORKS | If it received skip, it would work |
| Frontend parses harness_blocked | `use-harness-events.ts:79-88` | ✅ WORKS | Parser exists |
| Frontend renders blocked event | `harness-floating-panel.tsx:87-89` | ✅ WORKS | Timeline shows 🚨 |

### Break Points in Story 3

#### BP-5: CRITICAL — onBeforeNode Proxy doesn't return StrategyEngine's skip decision
**Anti-pattern**: Magic Bridge

This is the most critical break. In `detector-pipeline.ts:247-260`:
```typescript
case "onBeforeNode":
  return async function (nodeId, nodeType, nodeConfig) {
    pipeline.routeEvent({ type: "beforeNode", nodeId, nodeType, nodeConfig })
    return original.call(target, nodeId, nodeType, nodeConfig)
  }
```

The Proxy:
1. Routes the event to detectors (synchronous — `routeEvent` is sync)
2. ProcessConflictDetector produces a DiagnosisReport (synchronous)
3. `handleDiagnosis` persists + emits SSE + calls `strategyEngine.handleReport(report).catch(...)` (ASYNC, fire-and-forget)
4. Returns `original.call(target, ...)` — which is the ORIGINAL callback, likely returning `{ action: "proceed" }`

The StrategyEngine's abort decision happens asynchronously AFTER the Proxy has already returned `{ action: "proceed" }` to the engine. The engine then executes the dangerous script.

**Impact**: Story 3 is completely broken. The process conflict is DETECTED (SSE fires, DB records), but the node is NOT blocked. The script executes and kills the host process.

**This is a subset of Gap #1 but requires a DIFFERENT mechanism than onBeforeRetry.** Ticket 01 mentions `onBeforeRetry` and `onFailureDecision` but does NOT mention `onBeforeNode`. The spec's Gap #1 description also only mentions `onBeforeRetry` and `onFailureDecision`.

**Recommended fix**: The `onBeforeNode` Proxy handler needs to:
1. Route event to detectors synchronously
2. If a critical-severity report is produced AND a matching strategy has an abort/skip action, execute the action SYNCHRONOUSLY and return the result
3. This requires making the StrategyEngine's match-and-execute path synchronous for the onBeforeNode case, OR making the engine's `onBeforeNode` call await the full pipeline

#### BP-6: CRITICAL — `harness_blocked` SSE event never emitted by server
**Anti-pattern**: Missing Trigger

Grep for `harness_blocked` in `packages/server/src` returns ZERO results. No server code ever emits this event type. The abort action handler (`action-registry.ts:32-42`) returns `{ action: "abort", message: reason }` but doesn't emit any SSE event. The StrategyEngine's `emitInterventionSSE` emits `harness_intervention` (not `harness_blocked`).

The frontend is READY to receive it:
- `use-harness-events.ts:79-88` parses `harness_blocked` events
- `harness-floating-panel.tsx:87-89` renders them in the timeline

But the server never sends them.

**Impact**: Even if the skip decision were correctly returned, the frontend would never show the "进程冲突已阻断" notification.

**This is exactly Gap #5 / Ticket 04.** The fix should:
1. Add a `harness_blocked` SSE emit in the abort action handler (when the matched pattern is `process_conflict`)
2. Or add it in the StrategyEngine when executing an abort action for a critical-severity report

---

## Additional Break Points (Across All Stories)

#### BP-7: HIGH — `totalExtraTokens` always returns 0
**Anti-pattern**: Silent Failure  
**Story**: 4 (token cost display)

In `use-harness-events.ts:200-206`:
```typescript
const totalExtraTokens = events.reduce((sum, e) => {
  if (e.report?.context?.nodeDurationMs) {
    return sum  // ← returns sum unchanged
  }
  return sum    // ← returns sum unchanged
}, 0)
```

Both branches return `sum` unchanged. The reduce is a no-op.

**Additionally**: The harness_intervention SSE event (`strategy-engine.ts:294-315`) doesn't include any token information. The `harness_delegation` event from `AgentDelegationService` would need to include `tokenUsage`, but the delegation flow (Layer 3) is explicitly out of scope for this gap-fix.

**Impact**: Token display is always 0. Story 4 is broken.

**This is Gap #4 / Ticket 03.** Fix requires:
1. Extract token info from delegation events (when Layer 3 is implemented)
2. For now, estimate tokens from `inject_message` actions or set to a fixed overhead

#### BP-8: MEDIUM — `getWrappedCallbacks()` always returns undefined
**Anti-pattern**: Silent Failure

In `harness-controller.ts:116-122`:
```typescript
getWrappedCallbacks(executionId: string): EngineCallbacks | undefined {
  const pipeline = this.pipelines.get(executionId)
  return pipeline ? undefined : undefined  // ← always undefined
}
```

Both branches return `undefined`. This is acknowledged dead code but the spec says to fix or delete it.

**Impact**: Low — no callers depend on this method currently. But it's misleading.

**This is Gap #6 / Ticket 04.**

#### BP-9: MEDIUM — `onBeforeNode` Proxy routes to detectors but ProcessConflictDetector runs ASYNCHRONOUSLY through StrategyEngine
**Anti-pattern**: Unversioned State

The diagnosis-to-action pipeline has two different timing paths:
- **Detection**: Synchronous (routeEvent → detector.observe → handleDiagnosis)
- **Action**: Asynchronous (handleDiagnosis → strategyEngine.handleReport().catch())

This means the engine's `onBeforeNode` call gets the original callback's return value (proceed), while the StrategyEngine independently decides to abort — but too late.

**Impact**: Even if we add `pendingActions` for `onBeforeNode`, the async timing means the action won't be stored before the engine asks for it.

#### BP-10: MEDIUM — No pendingActions cleanup on node end
**Anti-pattern**: Silent Failure (memory leak)

The spec mentions `pendingActions` should be cleaned up on `onNodeEnd` (Ticket 01 AC3). Currently there is no `pendingActions` map at all, so this is a future concern. But the implementation in Ticket 01 must include cleanup logic, or it will leak memory for long-running executions.

---

## Ticket Sufficiency Analysis

### Coverage Matrix

| Gap | Story | Break Point | Ticket | Covered? |
|-----|-------|------------|--------|----------|
| #1: onBeforeRetry/onFailureDecision | Story 1 | BP-1, BP-2 | 01 | ✅ YES — but see note about onBeforeNode |
| #1: onBeforeNode (process_conflict) | Story 3 | BP-5 | 01? | ❌ **NOT COVERED** — Ticket 01 only mentions onBeforeRetry and onFailureDecision |
| #2: repairService injection | Story 2 (auto) | BP-4 | 02 | ✅ YES |
| #3: chatbot nodeId | Story 2 (manual) | BP-3 | 03 | ✅ YES |
| #4: totalExtraTokens | Story 4 | BP-7 | 03 | ✅ YES |
| #5: harness_blocked event | Story 3 | BP-6 | 04 | ✅ YES |
| #6: getWrappedCallbacks | — | BP-8 | 04 | ✅ YES |
| Race condition (timing) | Story 1, 3 | BP-2, BP-9 | ??? | ❌ **NOT COVERED** by any ticket |

### Missing Ticket: `onBeforeNode` skip mechanism

Ticket 01 covers `onBeforeRetry` and `onFailureDecision` but NOT `onBeforeNode`. Story 3 (process_conflict blocking) depends on `onBeforeNode` returning `{ action: "skip" }`. The spec's Gap #1 description only mentions `onBeforeRetry` and `onFailureDecision`.

**Recommendation**: Extend Ticket 01 to also cover `onBeforeNode`, OR create a new ticket specifically for `onBeforeNode` blocking. The mechanism is different:
- `onBeforeRetry` uses `pendingActions[nodeId]` (stored during onNodeEnd, consumed during onBeforeRetry)
- `onBeforeNode` needs **synchronous** action execution (detect → match → abort all before returning)

### Missing Dependency: Synchronous Strategy Execution

Neither Ticket 01 nor any other ticket addresses the fundamental timing issue: `StrategyEngine.handleReport()` is async (involves DB writes, SSE emits), but `onBeforeNode` and `onBeforeRetry` need the result synchronously (or at least before the engine proceeds).

**Recommendation**: Ticket 01 should specify that the `pendingActions` population must happen synchronously within the detector dispatch (i.e., the StrategyEngine's match-and-store path must be sync for the pendingActions case, even if DB persist and SSE emit happen async).

### DAG Ordering

The current dependency chain:
```
01 (proxy callbacks)  → no deps
02 (repairService)    → no deps
03 (frontend fixes)   → no deps
04 (blocked event)    → depends on 01
05 (e2e tests)        → depends on 01, 02, 03, 04
```

This ordering is **correct** for the current ticket scope. However:
- Ticket 04 should ALSO depend on the `onBeforeNode` fix (currently uncovered)
- Ticket 05 (E2E) correctly depends on all others

### Parallel vs Sequential

Tickets 01, 02, 03 can be done in parallel (no interdependencies). Ticket 04 needs 01 first. Ticket 05 needs all.

---

## Recommendations

### 1. Extend Ticket 01 to cover `onBeforeNode` blocking (CRITICAL)

Add acceptance criteria:
- AC6: Proxy intercepts `onBeforeNode`, queries `pendingBlockActions[nodeId]`, returns `{ action: "skip" }` for critical process_conflict matches
- AC7: StrategyEngine populates `pendingBlockActions` synchronously when a critical-severity report matches an abort strategy

### 2. Address the sync/async timing in Ticket 01 (HIGH)

The `pendingActions` map must be populated BEFORE the engine queries it. Two approaches:
- **Option A**: Make the detector → strategy → pendingActions path synchronous (hold the DB persist and SSE emit for async, but store the decision sync)
- **Option B**: Make the Proxy's `onBeforeRetry` handler await the StrategyEngine's result (add a Promise-based barrier)

Option A is simpler and aligns with the existing synchronous `routeEvent` design.

### 3. Add harness_blocked emit to Ticket 04 (already covered, verify)

Ensure the `harness_blocked` SSE is emitted in the abort action handler specifically, or in a post-action hook when the action type is `abort` and the detector is `process_conflict`.

### 4. Add a lightweight Ticket 06 or extend Ticket 03 for token estimation (MEDIUM)

Since Layer 3 (Agent Delegation) is out of scope, `totalExtraTokens` should at least estimate tokens from `inject_message` actions (e.g., `message.length / 4` as rough token count) or from `harness_delegation` events if they include token data.

---

## Summary of All Break Points

| ID | Severity | Story | Anti-Pattern | Description | Ticket |
|----|----------|-------|-------------|-------------|--------|
| BP-1 | CRITICAL | 1 | Magic Bridge | `onBeforeRetry` not intercepted by Proxy — intervention results never reach engine | 01 ✅ |
| BP-2 | HIGH | 1 | Unconnected Feedback | StrategyEngine.handleReport() is fire-and-forget async, races with engine's onBeforeRetry | 01 (add timing fix) |
| BP-3 | CRITICAL | 2 | Orphan Field | Chatbot POST body missing `nodeId` — server returns 400 | 03 ✅ |
| BP-4 | HIGH | 2 (auto) | Orphan Field | ExecutionLifecycle doesn't pass repairService to HarnessController | 02 ✅ |
| BP-5 | CRITICAL | 3 | Magic Bridge | onBeforeNode Proxy returns original callback, not skip — process_conflict never blocks | **NOT COVERED** |
| BP-6 | CRITICAL | 3 | Missing Trigger | `harness_blocked` SSE never emitted by any server code | 04 ✅ |
| BP-7 | HIGH | 4 | Silent Failure | `totalExtraTokens` reduce returns sum unchanged in all branches | 03 ✅ |
| BP-8 | MEDIUM | — | Silent Failure | `getWrappedCallbacks()` always returns undefined | 04 ✅ |
| BP-9 | MEDIUM | 1,3 | Unversioned State | Diagnosis→action pipeline is async but engine needs sync results | **NOT COVERED** |
| BP-10 | MEDIUM | 1 | Silent Failure | pendingActions cleanup not specified (future memory leak) | 01 (AC3 covers) |

---

## Conclusion

**4 CRITICAL break points** prevent all 3 stories from working:
- BP-1 and BP-5 are the same root cause (Proxy doesn't return decisions) but affect different callbacks
- BP-3 is a missing prop chain in the frontend
- BP-6 is a missing SSE emit

**The 5 tickets are ALMOST sufficient** but have one significant gap:
- **Ticket 01 must be extended** to cover `onBeforeNode` blocking (BP-5) and the sync timing issue (BP-9)
- Without this extension, Story 3 (process_conflict blocking) will not work even after all 5 tickets are implemented

**Recommended action**: Add `onBeforeNode` intercept + synchronous pendingActions to Ticket 01's acceptance criteria. This is a natural extension of the same Proxy mechanism.
