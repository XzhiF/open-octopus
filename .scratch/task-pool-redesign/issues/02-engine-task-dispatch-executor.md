# 02 — engine task_dispatch executor + pause-resume await

## What to build
engine 包：`TaskDispatchExecutor`（implements NodeExecutor）+ `TaskDispatchConfig`（executor-config.ts，含注入的 TaskDispatchPort）+ executor-factory switch case "task_dispatch"。节点 execute 调 `port.dispatchChildSchedule(subunit)` → **pause-resume**（复用 interaction/approval 基建，节点持久化"等待子 schedule"，不阻塞 event loop）；resume 回调 applyOutputsMapping 写 `$taskDispatchId.output`（sub-workflow.ts:247-255 先例）。

## Blocked by
01

## Status
done

## Acceptance Criteria
- [ ] task_dispatch 节点 Zod parse + executor-factory 返回 TaskDispatchExecutor
- [ ] execute 调 port.dispatchChildSchedule + pause（不 throw、不阻塞 loop）
- [ ] resume 回调 applyOutputsMapping 写 nodeResults（下游可读 $taskDispatchId.output.key）
- [ ] 构建期验证：resume API 支持 server-内部触发（非仅人 SSE）——若不支持，记 ADR 补丁

## Verification Method
**Type**: unit + integration
**Steps**: unit — mock TaskDispatchPort，assert dispatch + pause + resume + output mapping；integration — mock 子 schedule 完成 → assert 父节点 resume + output 写入。
**Pass**: assert PASS。**Fail**: max 3 then SKIP。

## Exploration

**Analog studied**:
- `InteractionExecutor` (interaction.ts) + `ApprovalExecutor` (approval.ts) — pause-resume pattern: first `execute()` returns a `pending_*` status + metadata; resume is a NEW executor instance constructed with completion data in its config (server re-invokes `engine.retryFrom` → factory threads resume payload into config).
- `SubWorkflowExecutor` (sub-workflow.ts:243-258) — `output_mapping` precedent: `{ parentVar: childVar }`, reads child snapshot, `pool.set(parentVar, value)`.
- `OctopusAgentConfig.createSessionFn` (executor-config.ts:147) — port-injection precedent: function/port declared `?` on `ExecutorFactoryContext`, passed into the per-executor config.

**Functions chosen**:
- `applyOutputsMapping` from `@octopus/shared` (outputs-resolver.ts:103) — for the `node.outputs` block on resume (interaction/approval precedent). Use this for `$vars.x = expr` style.
- Sub-workflow's `output_mapping` loop (sub-workflow.ts:247-258) — for `node.output_mapping` `{ parentVar: childKey }`, EXTENDED to also write `outputs[parentVar]` so downstream `$taskDispatchId.output.<key>` resolves (spec G1 requirement; sub-workflow only wrote to pool).
- Raw `pool.get` / `loopContext` / `nodeOutputs` lookup for subunit ref resolution (mirrors sub-workflow `resolveMappingValue`:266-284) — NOT `substituteVars` (returns string; SubunitSpec is an object).
- Do NOT use an in-memory Promise to await child completion (spec G1: reuse pause-resume, don't block event loop).

**Files needing modification (engine package only)**:
1. NEW `packages/engine/src/executors/task-dispatch.ts` — `TaskDispatchExecutor`.
2. `packages/engine/src/executors/executor-config.ts` — add `TaskDispatchConfig` (inject `TaskDispatchPort` + `childOutput` resume payload).
3. `packages/engine/src/executor-factory.ts` — add `case "task_dispatch"` + `taskDispatchPort?` / `taskDispatchChildOutput?` on `ExecutorFactoryContext`.
4. `packages/engine/src/executors/types.ts` — add `pending_task_dispatch` status + `TaskDispatchMetadata` (intrinsic to the new executor).
5. NEW `packages/engine/src/__tests__/task-dispatch.test.ts` — unit test (mock port).

**G1 build-time verification: PASS (mechanism) + GAP (noted for ticket 03)**.
- The engine resume API is `engine.retryFrom(nodeId, opts)` (engine.ts:460). It is **trigger-source-agnostic**: the server calls it from `ExecutionLifecycle.ts:1036` (interaction resume, human SSE → `interactionCompletion`) and can equally call it from a server-internal child-complete handler with a `taskDispatchChildOutput` payload. The mechanism does not distinguish human-SSE vs server-internal — it just re-invokes the engine with resume data threaded into `ExecutorFactoryContext`.
- **GAP (ticket 03 wires the trigger)**: (a) `engine.ts` does not yet recognize `pending_task_dispatch` as a pause state — the sequential/parallel pause checks (engine.ts:1330-1338, 1710-1725) only match `pending_approval`/`pending_interaction`; an unknown status falls through and does NOT pause. (b) `engine.ts:retryFrom` does not yet thread `taskDispatchChildOutput` from opts → `ExecutorFactoryContext`. Both are server/engine-integration concerns owned by ticket 03.
- **GAP (this fix, 02/03 leftover)**: `LoopExecutor.createExecutor` (loop.ts:475-632) had NO `task_dispatch` case (default threw `Unknown node type`) and did NOT populate `loopContext.subunit` from the subunits array — so the real `composition-task.yaml` (Loop over task_dispatch inner nodes) could not run end-to-end through the engine. The factory-level `task_dispatch` case (executor-factory.ts:258-267) only covers TOP-LEVEL task_dispatch nodes; the loop's inner-node factory is a separate switch. This fix wires the loop's inner task_dispatch path.

### Exploration (02/03 leftover fix)

**Analog studied**:
- `executor-factory.ts` `task_dispatch` case (lines 258-267) — the TOP-LEVEL construction: `new TaskDispatchExecutor(node, p, { port: ctx.taskDispatchPort, childOutput: ctx.taskDispatchChildOutput, signal, nodeOutputs, cwd })`. The loop's `createExecutor` must mirror this for the inner case.
- `executor-factory.ts` `loop` case (lines 156-183) + `engine.ts` retryFrom path D (lines 491-516) — the two sites that construct `LoopExecutor` / `LoopConfig`. Neither threads `taskDispatchPort`, so the port never reached inner task_dispatch nodes.
- `LoopExecutor.createExecutor` `approval` case (loop.ts:516-523) — the closest inner pause-resume node: passes `loopContext: loopCtx` + `nodeOutputs`. The `loopCtx` (loop.ts:477) only carried `{ iteration }`; TaskDispatchExecutor.resolveSubunit reads `loopContext.subunit` (task-dispatch.ts:219-223), so it resolved to `undefined` → coerceSubunit threw.
- Approval one-shot override delete (loop.ts:164) — the precedent for one-shot resume payloads inside a loop (an override/payload is consumed once then cleared so subsequent iterations re-dispatch, not re-resume).
- engine.ts retryFrom path D approval override (lines 484-487) + path A3 task_dispatch resume (lines 666-681) — path D builds overrides only for `approval`; task_dispatch resume was unhandled inside a loop.

**Functions chosen**:
- `TaskDispatchExecutor` (task-dispatch.ts) — constructed by the loop's inner factory for `task_dispatch` nodes. On first call: `dispatchAndPause` → `pending_task_dispatch`. On resume (config.childOutput set): `processCompletion` → `completed`. Do NOT re-dispatch on resume (one-shot payload).
- `VarPool.get("subunits")` (var-pool.ts:11) — subunits array source. VarPool.set/update preserve object types (no stringification), and the server passes subunits via input_values → `pool.update(initialInputs)` (engine.ts:223). Falls back to `LoopConfig.inputs.subunits` (engine.ts:236 Object.assign). Both land in the pool; `$vars.subunit_count` (composition-task.yaml break_when) is already pool-read, so subunits is read from the pool for consistency.
- `loopContext.subunit = subunits[iteration - 1]` — loop.ts:103 increments `this.iterations` (1-based) before use, so the 0-based array index is `iteration - 1` (runner-confirmed convention).

**Files needing modification (all engine package)**:
1. `packages/engine/src/executors/executor-config.ts` — add `taskDispatchPort?: TaskDispatchPort` to `LoopConfig`; add `taskDispatchChildOutput?: Record<string, unknown>` to `ResumeConfig`.
2. `packages/engine/src/executor-factory.ts` — `loop` case: pass `taskDispatchPort: this.ctx.taskDispatchPort` into LoopConfig.
3. `packages/engine/src/engine.ts` — retryFrom path D: pass `taskDispatchPort: this.taskDispatchPort` (LoopConfig) + `taskDispatchChildOutput: opts?.taskDispatchChildOutput` (ResumeConfig) so a task_dispatch inside a loop both dispatches (subsequent iterations) and resumes (one-shot) correctly.
4. `packages/engine/src/executors/loop.ts` — `createExecutor`: add `task_dispatch` case; populate `loopContext.subunit`; one-shot childOutput (resumeFromNodeId match + clear, approval-delete precedent).
5. NEW `packages/engine/src/__tests__/loop-task-dispatch.test.ts` — end-to-end: loop over 3 subunits + task_dispatch + bash aggregate; mock port; assert 3 dispatches in order, 3 pause-resume cycles, wf completes, $vars.result carries last child output.

### Result (02/03 leftover fix): PASS
- `LoopExecutor.createExecutor` now has a `task_dispatch` case returning `TaskDispatchExecutor` (mirrors executor-factory.ts:258-267 for the inner-loop path); `loopContext.subunit` populated from `pool.get("subunits")` (iteration-1, 1-based→0-based) with `inputs.subunits` fallback; one-shot `taskDispatchChildOutput` consumed on the resume iteration then cleared (approval-override delete precedent, loop.ts:164) so subsequent iterations dispatch the next subunit instead of re-resuming.
- Port threaded end-to-end: `LoopConfig.taskDispatchPort` (executor-config.ts) ← executor-factory `loop` case + engine.ts retryFrom path D; `ResumeConfig.taskDispatchChildOutput` ← path D from `opts.taskDispatchChildOutput`. This matches the server's resume contract (task-dispatch-service.ts → `engine.retryFrom(innerTaskDispatchNodeId, { taskDispatchChildOutput })`, where the inner node id comes from `taskDispatchMetadata.nodeId`).
- New test `loop-task-dispatch.test.ts`: 5/5 PASS (3-subunit iterate+order; pause-resume per iteration; no re-dispatch on resume; output_mapping → $vars.result; single-subunit edge).
- Gates: `pnpm --filter @octopus/engine test` → 819 pass, 4 fail (pre-existing on clean Stage-1: `swarm-host-agent` ×3 model-alias, `outputs-resolver` ×1 literal-string — none touch loop/task-dispatch/engine retryFrom). `pnpm build` exit 0.
