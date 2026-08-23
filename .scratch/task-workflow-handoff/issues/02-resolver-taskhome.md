# 02 — workflow-ref resolver + TaskHome workflows/

## What to build
1. `workflow-ref-resolver.ts`（共享 seam）：`resolveWorkflowRef(ref, deps)` / `isWorkflowRefResolvable(ref, deps)`
   - 解析顺序：builtin（`group/name` 或 bare `name`） → task-home（`.yaml` / `.yml` 自动扩展）
   - 排除全局 `~/.octopus/workflows/`（ADR-0013）
2. `TaskHomeService` 扩展：
   - `WORKFLOWS_DIR = "workflows"` 常量
   - `workflowsDir(taskId): string` 纯路径
   - `readWorkflowFile(taskId, ref): string | null` 命中返回内容，路径越界（`/`、`\`、`..`、null byte）返回 null
   - `listWorkflowFiles(taskId): string[]` 列 YAML
   - `createHome` 额外建 `{home}/workflows/` 空目录（与 `skills/`、`artifacts/` 并列）

## Blocked by
01（共享 validator 同文件）

## Status
done

## Acceptance Criteria
- [x] AC4: task-home resolver 命中（自建 flow 写入 `{home}/workflows/`）
- [x] AC5: 同 AC4（绑定前 validate 通过由 agent 在 skill 流程保证，后端只负责 resolver）
- [x] AC7: 三项源解析（builtin / task-home / 拒绝）

## Verification Method
`pnpm vitest run packages/server/src/services/tasks/__tests__/task-home-service.test.ts packages/server/src/services/tasks/__tests__/workflow-ref-resolver.test.ts`

## Implementation notes
- 文件：
  - `packages/server/src/services/tasks/workflow-ref-resolver.ts`（新增）
  - `packages/server/src/services/tasks/task-home-service.ts`（扩展）
  - `packages/server/src/services/tasks/__tests__/workflow-ref-resolver.test.ts`（新增，11 cases）
  - `packages/server/src/services/tasks/__tests__/task-home-service.test.ts`（更新 createHome / idempotent 测试）
- deps 注入：`BuiltInWorkflowService | null` + `TaskHomeService`（测试可脱离 ResourceManager 和真实 homedir）
