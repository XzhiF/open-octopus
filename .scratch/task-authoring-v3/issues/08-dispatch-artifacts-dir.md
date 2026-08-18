# 08 — dispatch 注入 $vars.task_artifacts_dir（三路径）

## What to build
执行期交接（US12/D14）：任务物化为 WorkflowConfig 时注入 `$vars.task_artifacts_dir` = 家目录 artifacts 绝对路径。注入点在 **server scheduler-service.ts**（不是 engine task-dispatch）：simple 任务走 `materializeTaskSpecToConfig`；composite 走 `buildCompositeInputValues`；composition 工作流子单元经 input_mapping 透传。

## Blocked by
02 — TaskHomeService（homePath 纯函数）

## Status
ready-for-agent

## Acceptance Criteria
- [ ] AC1: `scheduler-service.ts materializeTaskSpecToConfig` — simple 任务生成的 config 含 `input_values.task_artifacts_dir = {home}/artifacts`（或等价 vars 注入位）
- [ ] AC2: `buildCompositeInputValues`（workflow-executor.ts composite 路径）同步注入，不被 chain input_values 替换逻辑丢掉
- [ ] AC3: `core-pack/workflows/composition-task.yaml` 子工作流 input_mapping 增 `task_artifacts_dir: "$vars.task_artifacts_dir"`（或 engine task-dispatch 子单元 enrichment，二选一，测试锁定所选路径）
- [ ] AC4: task 无家目录（历史任务）时注入跳过，不报错（向后兼容）

## Verification Method
**Verification type**: integration test

**Verification steps**:
```bash
cd packages/server && pnpm vitest run src/__tests__/tasks-v3-dispatch.test.ts
```
三条独立断言（SW-BP7）：① simple 任务物化 → config vars 含 task_artifacts_dir == homePath(id)/artifacts；② composite 任务 → buildCompositeInputValues 输出含该键；③ composition workflow 执行（simulator/真跑）→ 子单元 `$vars.task_artifacts_dir` 可解析且等值。历史任务 fixture（无家目录）→ 物化正常无该键。

**Pass criteria**: All verification steps PASS
**Failure handling**: Max 3 fix attempts, then mark SKIP with reason
