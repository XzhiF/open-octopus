# WorkflowEngine Harness — Code Review

**Scope**: Critical integration points that could break existing functionality
**Files reviewed**:
- `packages/engine/src/engine.ts`
- `packages/server/src/services/execution/ExecutionLifecycle.ts`
- `packages/engine/src/executors/bash.ts`
- `packages/engine/src/executors/python.ts`
- `packages/engine/src/executors/process-isolation.ts`
- `packages/server/src/services/harness/harness-controller.ts`
- `packages/server/src/services/harness/strategy-engine.ts`

---

## 🔴 Must Fix

### 1. `strategy-engine.ts:220-234` — Missing try-catch in `executeOneAction`

One failing action will abort the entire action loop in `executeActions` (line 109), skipping all subsequent actions in the strategy. The `registry.execute(ctx)` call is unguarded.

**Impact**: A single buggy action (e.g., a misconfigured `repair_service` call or DB write failure) cascades into complete strategy failure. The `DetectorPipeline` will receive an unhandled exception.

**Fix**:
```typescript
private async executeOneAction(
  report: DiagnosisReport,
  actionDef: StrategyAction,
): Promise<InterventionResult> {
  const ctx: ActionContext = { ... }
  try {
    return await this.registry.execute(ctx)
  } catch (err) {
    return {
      success: false,
      action: actionDef.type,
      message: `Action failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}
```

---

### 2. `engine.ts:985` — `node.model` mutation persists in shared NodeDef

```typescript
if (retryDecision.modelOverride && node.type === "agent") {
  node.model = retryDecision.modelOverride
}
```

This directly mutates the `NodeDef` object which is part of the workflow definition (shared across executions). If the same workflow is executed concurrently or the engine is reconstructed, the mutation persists.

**Impact**: Model override bleeds into subsequent retries, other concurrent executions of the same workflow, and `reconstructEngine` flows.

**Fix**: Apply the override to the executor's config, not the node definition itself. The `AgentExecutor` already accepts a `model` option — pass `modelOverride` through the executor factory instead.

---

## 🟡 Should Fix

### 3. `ExecutionLifecycle.ts:1147-1216` — `autoResume` missing harness cleanup

The `autoResume` method completes execution (calls `updateStatus`, `executeWorkflowHooks`, `sse.emit`) but never calls `this.harnessController.onExecutionEnd(id)`. This leaks a `DetectorPipeline` in `HarnessController.pipelines` map.

**Impact**: On server restart with `pending_resume` executions, harness detectors continue running indefinitely, consuming resources and potentially emitting stale events.

**Fix**: Add harness cleanup after `sse.emit("complete")` in `autoResume`:
```typescript
if (this.harnessController) {
  try { this.harnessController.onExecutionEnd(execId) } catch {}
}
```

---

### 4. `ExecutionLifecycle.ts:956-998` — `runInteractionCompleteInBackground` missing harness cleanup

Same issue as #3 — interaction completion path ends without calling `onExecutionEnd`.

**Impact**: Detector pipeline leaks for executions that complete via interaction.

**Fix**: Same pattern — add `onExecutionEnd` call after `enginePool.remove`.

---

### 5. `python.ts:8,37-38` — No harness wrapper for Python scripts

`bash.ts:84` calls `prependWrapper(script)` to inject the safety wrapper. `python.ts` does not. Python scripts can freely call `os.kill(host_pid, signal)` without restriction.

**Impact**: A Python script can kill the host Node.js process (the Octopus server), crashing the entire system.

**Fix**: Either implement a Python equivalent of the harness wrapper, or restrict `OCTOPUS_HOST_PID` visibility in Python scripts by not injecting it into `buildHostEnv()` when running Python (though this is fragile). At minimum, document this gap.

---

### 6. `engine.ts:1223-1227` — "delegate" action indistinguishable from user pause

```typescript
if (failureDecision.action === "delegate") {
  this.pausedAt = node.id
  this.callbacks?.onError?.(node.id, ...)
  return { status: "paused" }
}
```

The `delegate` action sets `pausedAt` and returns `"paused"` — identical to a user-initiated pause. The caller (`ExecutionLifecycle`) has no way to know this was a harness delegation vs. a user clicking "Pause".

**Impact**: Frontend and SSE consumers cannot differentiate "paused by user" from "paused by harness delegation". This may confuse operators and break automation that responds to pause events.

**Fix**: Add a distinguishing field to the result (e.g., `pauseReason: "user" | "harness_delegate"`) or emit a distinct SSE event.

---

### 7. `process-isolation.ts:28-36` — Incomplete sensitive env filtering

`buildHostEnv()` only removes `OCTOPUS_DB_PATH`. Child processes still receive:
- `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`
- Any database connection strings
- Session tokens and cookies

**Impact**: Bash/Python scripts executed by the engine have full access to all server secrets. This is a security boundary issue — a malicious or buggy script could exfiltrate API keys.

**Note**: This may be intentional (scripts may need API keys for legitimate work). If so, document this as a known trade-off. Consider an allowlist approach for production deployments.

---

### 8. `ExecutionLifecycle.ts:1443-1450` — Harness `onExecutionStart` in `reconstructEngine` creates duplicate pipeline

When an engine is reconstructed (retry/resume), `onExecutionStart` is called again. `HarnessController.onExecutionStart` (line 63) defensively calls `onExecutionEnd` first to clean up any existing pipeline. This is correct, but:

**Impact**: If the original execution's pipeline was still active (e.g., during a retry without explicit end), the detector state is lost. Detector accumulators (e.g., error counts, timing data) are reset to zero.

**Note**: This may be acceptable behavior (fresh start on retry), but should be documented as a design decision.

---

## 🔵 Notes

### 9. `harness-controller.ts:116-122` — Dead `getWrappedCallbacks` method

The method always returns `undefined` and has a comment saying "exists for future use". This is dead code.

**Recommendation**: Either remove it or implement it properly. Dead methods on public interfaces confuse consumers.

---

### 10. `engine.ts:971-975` — `onBeforeRetry` skip/abort returns stale result

```typescript
if (retryDecision.action === "skip") {
  return { ...result, status: "skipped", retryCount: attempt - 1 }
}
if (retryDecision.action === "abort") {
  return { ...result, status: "failed", retryCount: attempt - 1 }
}
```

When `skip` or `abort` is chosen, the returned result is a spread of the *last failed result* with a status override. This means `logLines`, `exitCode`, and `error` fields reflect the original failure, not the harness decision.

**Recommendation**: Add a log line like `["Harness: skipped by strategy"]` or `["Harness: aborted by strategy"]` to make the result self-documenting.

---

### 11. `engine.ts:869-877` — `onBeforeNode` skip doesn't fire `onNodeStart` callback

When `onBeforeNode` returns `"skip"`, the node is skipped without firing `onNodeStart`:

```typescript
if (decision.action === "skip") {
  // onNodeStart was NOT called before this
  this.callbacks?.onNodeEnd?.(node.id, "skipped", 0, skippedResult, node.type)
  return skippedResult
}
```

But `onNodeStart` IS called at line 846 (before `onBeforeNode` check), so this is actually correct — `onNodeStart` fires, then `onBeforeNode` can skip, then `onNodeEnd` fires. ✅ No issue here.

---

## Summary

| Severity | Count | Key Concerns |
|----------|-------|--------------|
| 🔴 Must Fix | 2 | Strategy action crash cascades; node mutation bleed |
| 🟡 Should Fix | 6 | Resource leaks in autoResume/interaction; Python isolation gap |
| 🔵 Note | 3 | Dead code, stale result metadata |

**Overall assessment**: The harness integration is **architecturally sound** — all 3 callbacks are properly optional (no breaking changes), cleanup is called in the main success/error/cancel/retry paths, and the force kill chain is correctly implemented. The two 🔴 issues are the most urgent: strategy action failures must be isolated, and `node.model` mutation must not leak across executions.
