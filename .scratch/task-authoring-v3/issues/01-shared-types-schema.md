# 01 — shared 类型 + taskSpecSchema 扩展

## What to build
task_spec 的新字段获得 schema 身份：`task_type`（coding/generic）、`skill_groups[]`、`decisions[]`、`goal_confirmed`、`ac_confirmed[]` 经 zod 校验且 PUT 往返不丢失；`decisions` 成为合法的 spec-field 字段；AssistWorkflowRun / ArtifactIndexEntry 类型就位。

## Blocked by
None — can start immediately

## Status
ready-for-agent

## Acceptance Criteria
- [ ] AC1: `shared/src/types/scheduler-job.ts` 的 taskSpecSchema 增 `task_type: z.enum(["coding","generic"]).optional()`、`skill_groups: z.array(z.string()).default([])`、`decisions: z.array(z.string()).default([])`、`goal_confirmed: z.boolean().optional()`、`ac_confirmed: z.array(z.string()).default([])`
- [ ] AC2: `shared/src/types/task.ts` 的 TaskSpecFieldSchema 增 `"decisions"`；validateSpecFieldValue 增 decisions 分支（string[] 校验）
- [ ] AC3: 新增 ArtifactIndexEntry 类型：`{ path, by, title, external, updated_at }`；AssistWorkflowRun 类型：`{ run_id, execution_id, workspace_id, template, status, logs[], output?, output_raw?, output_parse_error? }`
- [ ] AC4: 既有字段 goal/ac min(1) 约束不被破坏

## Verification Method
**Verification type**: unit test

**Verification steps**:
```bash
cd packages/shared && pnpm vitest run src/__tests__  # 新增 task-schema-v3.test.ts
```
断言：`taskSpecSchema.parse({goal:"g",ac:["a"],task_type:"coding",skill_groups:["open-spec"],decisions:["x"]})` 往返后三新字段存在；`validateSpecFieldValue("decisions", ["a"])` 通过；`validateSpecFieldValue("unknown", ...)` 仍抛错。

**Pass criteria**: All verification steps PASS
**Failure handling**: Max 3 fix attempts, then mark SKIP with reason
