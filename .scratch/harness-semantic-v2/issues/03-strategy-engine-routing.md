# 03 — Strategy Engine Routing Refactor

## What to build
重构 StrategyEngine 为三域路由器：process_conflict 保留同步阻断，其余统一路由到 Agent。

## Blocked by
01 — Shared Types + DB Migration

## Status
done

## Acceptance Criteria
- [x] AC1: `StrategyEngine.handleReport()` 对 process_conflict+critical 返回 `{ delegate: true, synchronousBlock: true }`
- [x] AC2: 对非 process_conflict 报告返回 `{ delegate: true }` (无 action 执行)
- [x] AC3: ActionRegistry 中仅保留 `abort` handler（删除 inject_message, modify_varpool, modify_definition, switch_model, retry_with_hint, pause, pause_and_notify）
- [x] AC4: `synchronouslyStorePendingAction()` 对 process_conflict 仍存储 pendingBlockAction（同步域）
- [x] AC5: 现有单元测试更新后通过

## Verification Method
**Verification type**: unit test

**Verification steps**:
1. `pnpm --filter @octopus/server test -- strategy-engine` — 所有测试通过
2. 验证 handleReport 对不同 detector 的返回值正确
3. 验证 synchronouslyStorePendingAction 仅对 process_conflict 存储 block action

**Pass criteria**: 单元测试全部通过
