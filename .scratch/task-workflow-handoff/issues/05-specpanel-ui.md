# 05 — SpecPanel UI: workflow_ref display

## What to build
`SpecPanel` 增加 workflow_ref 可视化：
- 读 `task.workflow_ref`（顶层列，非 `task_spec` 字段）
- SSE `spec_field_update` 事件实时更新 `workflowRef` state
- 未绑定显示降级提示（"尚未绑定 workflow_ref"）
- 绑定后显示 ref + [查看] 按钮
- 点击 [查看] 调 `GET /:id/workflow-ref` → 渲染 `content` + `source`

## Blocked by
03（view endpoint）

## Status
done

## Acceptance Criteria
- [x] AC3: 绑定后 SpecPanel 实时显示（SSE）
- [x] AC8: 查看按钮 → 渲染 content + source

## Verification Method
`pnpm vitest run packages/web-app/components/tasks/__tests__/task-modal-spec-panel.test.tsx`

## Implementation notes
- 文件：
  - `packages/web-app/components/tasks/spec-panel.tsx`（workflowRef state + WorkflowRefDisplay 子组件）
  - `packages/web-app/components/tasks/__tests__/task-modal-spec-panel.test.tsx`（新增 describe block × 3 tests：unbound hint / bound + button / SSE live update）
- UI 约定：复用既有 `applySpecField` SSE handler；新增 `workflowRef` state；查看按钮用 `fetch(serverUrl + /tasks/${id}/workflow-ref)`
