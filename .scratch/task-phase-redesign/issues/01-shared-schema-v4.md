# 01 — shared：task_spec v4 schema（phases/autoAdvance/flag + goal/ac 转 optional）

## What to build
`@octopus/shared` 中 taskSpecSchema 支持 v4：新增 `format?: "v4"`、`phases?: TaskPhase[]`、`autoAdvance?: boolean`；`goal/ac` 及双 confirmed 转 optional（v3/generic 兼容不破）。导出 `TaskPhase = { index, name, slug, specPath, workflowRef, inputValues }` Zod 单源，前端类型派生。

## Blocked by
None — can start immediately.

## Status
done

## Acceptance Criteria
- [ ] AC1: v4 payload（无 goal/ac，phases≥1）parse 通过；v3 payload 行为不变（回归）
- [ ] AC2: TaskPhase Zod→TS 类型导出，web 侧类型引用同一来源，契约快照测试绿
- [ ] AC3: `pnpm -F @octopus/shared test` 与全仓 build 绿

## Verification Method
**Verification type**: unit test + contract test

**Verification steps**:
1. `packages/shared/src/__tests__/task-spec-v4.test.ts`：v4 正/反例（phases 空数组、specPath 缺、v3 无 format 仍过）
2. 契约测试：生成 TaskPhase TS 快照对比 web-app 引用处类型文件
3. `pnpm -F @octopus/shared test && pnpm build`

**Pass criteria**: 全部测试绿
**Failure handling**: Max 3 fix attempts, then mark SKIP with reason
