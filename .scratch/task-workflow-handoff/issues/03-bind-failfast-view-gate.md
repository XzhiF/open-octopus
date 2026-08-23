# 03 — bind fail-fast + view endpoint + readyTask gate

## What to build
1. `updateSpecField(field="workflow_ref", value)`：
   - 共享 validator 拒 empty / non-string → 400
   - resolver 预检不可解析 → 400 `workflow not resolvable`
   - 命中 → 写入 `tasks.workflow_ref` 顶层列（不进 `task_spec`，与 `skills`/`projects` 同处理）
   - bump version + emit `spec_field_update` SSE
2. `GET /:id/workflow-ref` 端点：
   | 状态 | 响应 |
   |------|------|
   | task 不存在 | 404 |
   | 未绑定 | 200 `null` |
   | 绑定但不可解析 | 400 |
   | 绑定且可解析 | 200 `{ref, content, source}` |
3. `readyTask` 升级（S3）：v3 简单任务（`subunits.length < 2`）从"非空"改为"**可解析**"
4. `ServerApp` index 注入：构造 `BuiltInWorkflowService` 并传给 `TasksService`

## Blocked by
01（validator），02（resolver + task-home）

## Status
done

## Acceptance Criteria
- [x] AC7: bind resolvable → 200 + SSE + column；bind unresolvable → 400；empty → 400
- [x] AC8: view endpoint × 4（unbound / bound / stale / missing）
- [x] AC9: S3 gate upgrade（non-empty 不可解析 → 409 missing）+ 既有 gates 回归

## Verification Method
`pnpm vitest run packages/server/src/__tests__/tasks-v3-gates.test.ts`

## Implementation notes
- 文件：
  - `packages/server/src/services/tasks/tasks-service.ts`（updateSpecField 新增 workflow_ref 分支；viewWorkflowRef 方法；readyTask 升级；resolverDeps 私有 helper；构造器加 builtInWorkflowService tail 参数）
  - `packages/server/src/routes/tasks.ts`（新增 GET route）
  - `packages/server/src/index.ts`（注入 BuiltInWorkflowService）
  - `packages/server/src/__tests__/tasks-v3-routes.test.ts`（构造器更新）
