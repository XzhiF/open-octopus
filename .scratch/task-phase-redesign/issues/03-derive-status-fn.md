# 03 — 状态派生纯函数 deriveTaskView（唯一真相）

## What to build
server 层纯函数：输入 task+executions+acceptances → 输出 `{taskStatus, phaseViews[{status, rounds[{exec, state}], acceptedRound}]}`。不变量：v4 task 永不返回 failed；round 终态(成/败)→无该轮 acceptance 记录时 phase=awaiting_review；accepted 行→phase accepted；exec 在跑→running。

## Blocked by
01（TaskPhase 类型）

## Status
ready-for-agent

## Acceptance Criteria
- [ ] AC1: 参数化单测覆盖全状态矩阵（≥12 组合：跑中/成/败 × accepted/rejected/无 × 首/中/末 phase）
- [ ] AC2: 不变量断言：输出枚举中 taskStatus ∈ {ready,running,awaiting_review,archiving,done,aborted}，永不为 failed
- [ ] AC3: 纯函数零 IO（不 import dao）

## Verification Method
**Verification type**: unit test

**Verification steps**:
1. `packages/server/src/services/tasks/__tests__/derive-task-view.test.ts` it.each 状态表
2. `pnpm -F @octopus/server test -- derive-task-view`

**Pass criteria**: 全绿且覆盖率报告该文件分支 ≥95%
**Failure handling**: Max 3 fix attempts, then mark SKIP with reason
