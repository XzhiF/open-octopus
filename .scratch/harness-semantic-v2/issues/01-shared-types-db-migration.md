# 01 — Shared Types + DB Migration

## What to build
更新 shared 类型定义和数据库 schema，为 Harness Semantic V2 打基础。

## Blocked by
None — can start immediately

## Status
done

## Acceptance Criteria
- [ ] AC1: `HarnessDecisionType` 类型在 `packages/shared/src/harness/types.ts` 中定义（5 种决策类型）
- [ ] AC2: `DelegationResult` 接口更新为新字段（decision, varPoolPatches, harnessHint, modelOverride, takeoverOutput, blockReason, continueSubsequent, reasoning）
- [ ] AC3: `executions` 表增加 `harness_status TEXT DEFAULT NULL` 列
- [ ] AC4: `executions` 表增加 `harness_summary TEXT DEFAULT NULL` 列
- [ ] AC5: `schema.ts` 中有 ensureColumn migration 代码
- [ ] AC6: `OnBeforeRetryResult` 增加 `varPoolPatches?: Record<string, string>`
- [ ] AC7: `OnFailureDecisionResult` 增加 `action: 'override'` + `overrideResult`

## Verification Method
**Verification type**: unit test + DB check

**Verification steps**:
1. `pnpm --filter @octopus/shared test` — types 编译通过
2. `sqlite3 ~/.octopus/db/octopus.db "PRAGMA table_info(executions)"` — 验证新列存在
3. 检查 `packages/shared/src/harness/types.ts` 导出正确

**Pass criteria**: 所有 AC 检查通过
