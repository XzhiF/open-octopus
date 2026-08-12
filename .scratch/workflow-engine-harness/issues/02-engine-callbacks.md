# 02 — Engine 回调扩展 (3 个新可选回调)

## What to build
在 `packages/engine/src/engine.ts` 中新增 3 个可选回调，并在精确位置插入钩子代码。所有回调可选，向后兼容。

## Blocked by
01 (需要 shared 类型定义)

## Status
done

## Acceptance Criteria
- [x] AC1: `EngineCallbacks` 接口新增 `onBeforeNode`、`onBeforeRetry`、`onFailureDecision` 三个可选字段
- [x] AC2: `onBeforeNode` 在 `executeSingleNode()` 的 `executor.execute()` 之前调用，返回 skip/override 时跳过执行
- [x] AC3: `onBeforeRetry` 在 `executeSingleNodeWithRetry()` 的 retry delay 之前调用，支持 harnessHint 注入 VarPool + modelOverride 修改节点模型
- [x] AC4: `onFailureDecision` 在 `executeNodesSequential()` 的 failure strategy 决策处调用，返回 delegate 时暂停引擎
- [x] AC5: 不传新回调时引擎行为完全不变（向后兼容测试）

## Verification Method
**Verification type**: unit test + integration test

**Verification steps**:
1. `pnpm --filter @octopus/engine build` — 编译通过
2. `pnpm --filter @octopus/engine test` — 现有测试全部通过（向后兼容）
3. 新增测试: 传入 onBeforeRetry 回调 → 验证 harnessHint 写入 VarPool
4. 新增测试: 传入 onBeforeNode 返回 skip → 验证节点被跳过
5. 新增测试: 传入 modelOverride → 验证 node.model 被修改

**Pass criteria**: 所有 AC 通过 + 现有测试无回归
