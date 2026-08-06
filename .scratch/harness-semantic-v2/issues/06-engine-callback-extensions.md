# 06 — Engine Callback Extensions

## What to build
扩展 engine 回调接口：onBeforeRetry 增加 varPoolPatches，onFailureDecision 增加 override action。

## Blocked by
01 — Shared Types + DB Migration

## Status
ready-for-agent

## Acceptance Criteria
- [ ] AC1: onBeforeRetry 返回 varPoolPatches 时，engine 执行 `pool.update(patches)` 批量更新变量
- [ ] AC2: onFailureDecision 返回 `{ action: "override", overrideResult }` 时，engine 用 overrideResult 替代原始 failed result
- [ ] AC3: override 结果写入 node_executions（status: completed, outputs 从 overrideResult 来）
- [ ] AC4: 向后兼容：旧回调不提供新字段时行为不变
- [ ] AC5: 现有 engine 测试仍通过

## Verification Method
**Verification type**: unit test

**Verification steps**:
1. `pnpm --filter @octopus/engine test` — 所有测试通过
2. 新增测试：onBeforeRetry with varPoolPatches → 验证 pool 更新
3. 新增测试：onFailureDecision with override → 验证结果替换

**Pass criteria**: 新旧测试全部通过
