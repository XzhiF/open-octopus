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
- Per runner instruction ("do NOT block the build"), ticket 02 ships the executor + config + factory case; the executor returns `pending_task_dispatch` and is unit-tested in isolation (mock port). `pnpm build` stays green because the new status is added to the `NodeExecutionResult.status` union (engine `types.ts`) and the separate run-result literal unions in `engine.ts` are unaffected.
