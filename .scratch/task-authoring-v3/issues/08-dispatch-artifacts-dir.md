# 08 — dispatch 注入 $vars.task_artifacts_dir（三路径）

## What to build
执行期交接（US12/D14）：任务物化为 WorkflowConfig 时注入 `$vars.task_artifacts_dir` = 家目录 artifacts 绝对路径。注入点在 **server scheduler-service.ts**（不是 engine task-dispatch）：simple 任务走 `materializeTaskSpecToConfig`；composite 走 `buildCompositeInputValues`；composition 工作流子单元经 input_mapping 透传。

## Blocked by
02 — TaskHomeService（homePath 纯函数）

## Status
done

## Exploration

### Analog studied
The closest existing feature is the **subunit_count injection** (SG5, ticket 06):
`materializeTaskSpecToConfig` injects `input_values.subunit_count` into the
composite path's `workflow_chain[0]`. The composite executor
(`buildCompositeInputValues` in workflow-executor.ts) RE-COMPUTES subunit_count
from task_spec/origin at execute time, completely replacing `firstStep.input_values`.
This is the exact "chain input_values replacement drops injected keys" hazard
AC2 warns about.

### Files needing modification
1. `packages/server/src/services/scheduler/scheduler-service.ts` —
   `materializeTaskSpecToConfig`: add `taskArtifactsDir?: string` (7th param, tail).
   Inject into `workflow_chain[0].input_values.task_artifacts_dir` for BOTH
   simple and composite paths (composite needs it so buildCompositeInputValues
   can read+preserve it). Skip when undefined (AC4 backward compat).
2. `packages/server/src/services/scheduler/executors/workflow-executor.ts` —
   `buildCompositeInputValues`: read `task_artifacts_dir` from
   `config.workflow_chain[0].input_values` and include in the returned object
   (preserve, don't drop — AC2). Both legacy (config.task_spec) + new (origin)
   branches.
3. `packages/server/src/services/tasks/tasks-service.ts` — `readyTask`: compute
   `new TaskHomeService().artifactsDir(id)` (pure, no FS) and pass as the 7th
   arg to materializeTaskSpecToConfig.
4. `packages/core-pack/workflows/composition-task.yaml` — dispatch-child node:
   add `task_artifacts_dir: "$vars.task_artifacts_dir"` to `input_mapping`
   (alongside existing `goal: "$vars.goal"`).
5. `packages/engine/src/executors/task-dispatch.ts` — `dispatchAndPause`: resolve
   `this.node.input_mapping` from the parent pool and merge into the subunit's
   `input_values` before dispatching (mirrors sub-workflow.ts:98-108
   `resolveMappingValue` pattern). This is the "engine task-dispatch 子单元
   enrichment" option from AC3 (the input_mapping is currently declared in the
   YAML but NOT resolved by the executor — a pre-existing gap; this makes both
   `goal` and `task_artifacts_dir` forward to child schedules).

### Functions chosen
- **TaskHomeService.artifactsDir(taskId)** — pure path derivation
  (`baseDir/tasks/{id}/artifacts`), no FS side effect. Use this (NOT a raw
  path.join) so the path convention stays in one place (ADR-0011).
- **materializeTaskSpecToConfig** — the single server-side injection point for
  BOTH simple and composite paths (simple: input_values read directly by
  execute(); composite: input_values read by buildCompositeInputValues).
- **buildCompositeInputValues** — the composite execute-time input_values
  builder. Must PRESERVE task_artifacts_dir from the config (AC2's "not
  dropped" concern). Do NOT use `firstStep.input_values` directly (it's
  completely replaced).
- **TaskDispatchExecutor.resolveMappingValue** pattern (from sub-workflow.ts:266)
  — resolve `$vars.xxx` via `this.pool.get(key)`, object-preserving. Reuse the
  same regex pattern for the task-dispatch executor's input_mapping resolution.

### Lane safety check
- composition-task.yaml is NOT an assist workflow (ticket 07 owns assist YAMLs
  only: moa-requirements-review / spec-review-swarm / clarify-debate). ✓
- task-dispatch.ts (engine) is NOT owned by tickets 03 or 07. AC3 explicitly
  allows "engine task-dispatch 子单元 enrichment". ✓
- Existing tests (task-dispatch.test.ts, loop-task-dispatch.test.ts) do NOT
  declare `input_mapping` on task_dispatch nodes, so adding resolution is
  gated on `this.node.input_mapping` presence → no breakage. ✓

## Acceptance Criteria
- [x] AC1: `scheduler-service.ts materializeTaskSpecToConfig` — simple 任务生成的 config 含 `input_values.task_artifacts_dir = {home}/artifacts`（或等价 vars 注入位）
- [x] AC2: `buildCompositeInputValues`（workflow-executor.ts composite 路径）同步注入，不被 chain input_values 替换逻辑丢掉
- [x] AC3: `core-pack/workflows/composition-task.yaml` 子工作流 input_mapping 增 `task_artifacts_dir: "$vars.task_artifacts_dir"`（或 engine task-dispatch 子单元 enrichment，二选一，测试锁定所选路径）
- [x] AC4: task 无家目录（历史任务）时注入跳过，不报错（向后兼容）

## Verification Method
**Verification type**: integration test

**Verification steps**:
```bash
cd packages/server && pnpm vitest run src/__tests__/tasks-v3-dispatch.test.ts
```
三条独立断言（SW-BP7）：① simple 任务物化 → config vars 含 task_artifacts_dir == homePath(id)/artifacts；② composite 任务 → buildCompositeInputValues 输出含该键；③ composition workflow 执行（simulator/真跑）→ 子单元 `$vars.task_artifacts_dir` 可解析且等值。历史任务 fixture（无家目录）→ 物化正常无该键。

**Pass criteria**: All verification steps PASS
**Failure handling**: Max 3 fix attempts, then mark SKIP with reason
