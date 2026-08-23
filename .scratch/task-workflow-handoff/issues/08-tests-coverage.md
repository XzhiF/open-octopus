# 08 — 测试覆盖汇总

## What to build
跨 01-06 的实现，配套测试按"就近原则"分布：
- **shared schema tests**：`EXPECTED_SPEC_FIELDS` 含 `workflow_ref` + `decisions`
- **unit tests**：
  - `workflow-ref-resolver.test.ts` — 11 cases（empty / builtin / task-home / precedence / path-escape / boolean mirror / null builtIn）
  - `task-home-service.test.ts` — createHome / idempotent / workflowsDir / readWorkflowFile / listWorkflowFiles
- **integration tests**：
  - `tasks-v3-gates.test.ts` — AC7 bind (resolvable/unresolvable/empty) + AC8 view × 4 + AC9 S3 gate upgrade
  - `tasks-v3-dispatch.test.ts` — AC1-seam task_workflows_dir 注入 + AC10 dispatch-copy helper
  - `tasks-v3-routes.test.ts` — 构造器更新（stub BuiltInWorkflowService）
- **component tests**：
  - `task-modal-spec-panel.test.tsx` — unbound hint / bound + 查看 / SSE 实时更新

## Blocked by
01-06 全部完成

## Status
done

## Acceptance Criteria
- [x] AC3: 集成 + 组件测试（spec-field → SSE 断言）
- [x] AC4: 集成测试（task-home resolver 命中）
- [x] AC5: 集成测试（task-home resolver 命中）
- [x] AC7: 集成测试三项源
- [x] AC8: 组件 + 集成（view endpoint）
- [x] AC9: 集成（ready-gate upgrade + gates 套件回归）
- [x] AC10: 集成（dispatch-copy helper）
- [x] 全量 255 tests pass（`pnpm test`）

## Verification Method
`pnpm test`（全绿）+ 关键套件单独运行：
- `pnpm vitest run packages/shared/src/__tests__/task-domain-schema.test.ts`
- `pnpm vitest run packages/server/src/services/tasks/__tests__/workflow-ref-resolver.test.ts`
- `pnpm vitest run packages/server/src/services/tasks/__tests__/task-home-service.test.ts`
- `pnpm vitest run packages/server/src/__tests__/tasks-v3-gates.test.ts`
- `pnpm vitest run packages/server/src/__tests__/tasks-v3-dispatch.test.ts`
- `pnpm vitest run packages/web-app/components/tasks/__tests__/task-modal-spec-panel.test.tsx`

## Implementation notes
- 测试 stub 模式：`BuiltInWorkflowService` stub → `ref.includes("e2e-td")` 即返回 `{ ref, content: "stub-builtin" }`
- TaskHomeService 注入 temp `baseDir`（never touch `~/.octopus`）
- 所有测试独立、并行安全
- 测试 id 前缀：`e2e-td-*`
