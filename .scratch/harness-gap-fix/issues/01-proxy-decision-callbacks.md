# 01 — 连接 onBeforeRetry/onFailureDecision 决策回调

## What to build
在 DetectorPipeline 的 Proxy 中追加对 `onBeforeRetry` 和 `onFailureDecision` 的拦截，使 StrategyEngine 的干预结果（harnessHint、modelOverride）能够回传给引擎，让 harness 从"只读监控"升级为"可干预控制"。

## Blocked by
None — can start immediately

## Status
done

## Acceptance Criteria
- [x] AC1: `wrapCallbacks()` 的 Proxy 拦截 `onBeforeRetry`，查询 pendingActions 并返回 `{ action, harnessHint?, modelOverride? }`
- [x] AC2: `wrapCallbacks()` 的 Proxy 拦截 `onFailureDecision`，查询 pendingFailureActions 并返回 `{ action }`
- [x] AC3: pendingActions 在 `onNodeEnd` 时清理对应 entry（防内存泄漏）
- [x] AC4: 当 pendingActions 无数据时，回退到原始回调（如有）或返回默认 `{ action: "retry" }`
- [x] AC5: 新增单元测试覆盖以上 4 个场景

## Verification Method
**Verification type**: unit test

**Verification steps**:
```bash
cd packages/server
npx vitest run src/services/harness/__tests__/detector-pipeline.test.ts
```

**Pass criteria**: 所有新增测试 PASS + 现有 harness 测试不回归
**Failure handling**: Max 3 fix attempts, then mark SKIP with reason
