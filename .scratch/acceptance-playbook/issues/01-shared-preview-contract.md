# 01 — shared: acceptance_preview 契约

## What to build
`scheduler-job.ts`: `acceptancePreviewSchema`(command≤4000/cwd?/url/readyPattern?)+ `TaskSpec.acceptance_preview` optional;`task.ts` SPEC_FIELDS 枚举 +`"acceptance_preview"`、`validateSpecFieldValue` 加 case(null→undefined,同 acceptance_verify :380 形态);常量文件 `TASK_PREVIEW_EVENT="task_preview"`。

## Blocked by
无

## Status
pending

## Acceptance Criteria
- [ ] AC1: schema parse 正反用例(缺 url 拒、null 清除路径 undefined)
- [ ] AC2: spec-field 白名单 round-trip 不 strip(仿 tasks-verify.test 既有 acceptance_verify 用例)

## Verification Method
**type**: unit — `packages/shared/src/__tests__/`(新增 preview 用例,跑既有 task spec 测试族)。
