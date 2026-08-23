# 04 — dispatch-copy + task_workflows_dir injection

## What to build
1. `materializeTaskSpecToConfig` 签名加可选 `taskWorkflowsDir` 参数（尾追加）：
   - 注入 `$vars.task_workflows_dir` 到 `workflow_chain[0].input_values`
   - simple + composite 两路
   - v2 任务（无 `task_type`）不注入（向后兼容）
2. `WorkflowExecutor.execute` 增加 `copyTaskWorkflowsToWs(taskWorkflowsDir, wsPath)` 调用：
   - 在 `createFromSpec` 之后、`execution.create` 之前
   - 从 `firstStep.input_values.task_workflows_dir` 读源路径
   - 把 `{src}/*.yaml` ∪ `*.yml` 拷进 `{wsPath}/workflows/`
   - 跳过子目录
   - 非致命：拷贝失败 log + 继续，引擎 resolver 会在 miss 时清晰报 "Workflow not found"
3. 抽出 `copyTaskWorkflowsToWs` 为命名导出 helper（便于测试）
4. `TasksService.readyTask` 计算 `taskWorkflowsDir` 并传入 `materializeTaskSpecToConfig`

## Blocked by
02（TaskHome workflows/）

## Status
done

## Acceptance Criteria
- [x] AC1 (seam): `task_workflows_dir` 注入到 simple + composite 的 input_values（v2 不注入）
- [x] AC10: task-home flow 入队后执行 ws `workflows/` 出现该 YAML

## Verification Method
`pnpm vitest run packages/server/src/__tests__/tasks-v3-dispatch.test.ts`

## Implementation notes
- 文件：
  - `packages/server/src/services/scheduler/scheduler-service.ts`（materializeTaskSpecToConfig 加 taskWorkflowsDir 参数）
  - `packages/server/src/services/scheduler/executors/workflow-executor.ts`（copyTaskWorkflowsToWs helper + execute 调用）
  - `packages/server/src/services/tasks/tasks-service.ts`（readyTask 注入 taskWorkflowsDir）
  - `packages/server/src/__tests__/tasks-v3-dispatch.test.ts`（AC1-seam + AC10 dispatch-copy 测试）
- 修复：firstStep 声明顺序（copy 块必须在 firstStep 声明后执行）
- engine 边界：WorkflowExecutor 不关心 taskId，只读 input_values（保持 engine / server 职责分离）
