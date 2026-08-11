# 04 — Effectiveness Tracker (Outcome + Stats)

## What to build
实现干预效果追踪闭环：在 onExecutionEnd() 中根据执行最终状态批量更新 pending experiences 的 outcome，提供 getSuccessStats 统计接口，并在干预 prompt 中注入成功率数据（含冷启动保护）。

## Blocked by
01 — Schema Migration (needs outcome + node_id columns)
03 — Harness Experience Recording (needs experience rows to update)

## Status
ready-for-agent

## Acceptance Criteria
- [ ] AC-1: onExecutionEnd() 根据执行最终状态批量更新 pending experiences 的 outcome
- [ ] AC-2: 执行 completed → 所有干预 outcome.label = 'success'
- [ ] AC-3: 执行 failed → 最后失败节点的干预 outcome.label = 'failed'，其余为 'success'
- [ ] AC-4: getSuccessStats() 返回 decision × pattern 成功率（30天窗口，min N=5）
- [ ] AC-5: 干预 prompt 中包含成功率数据（≥5 数据点时）
- [ ] AC-6: 冷启动保护：< 5 数据点时跳过注入，显示 "经验积累中..."
- [ ] AC-7: 成功率公式: count(success) / count(total) per decision×detector

## Verification Method
**Verification type**: unit test + integration test

**Verification steps**:
```bash
# 1. Outcome tracking test
pnpm --filter @octopus/server exec vitest run --reporter=verbose src/__tests__/effectiveness-tracker.test.ts

# 2. Stats computation test
pnpm --filter @octopus/server exec vitest run --reporter=verbose src/__tests__/success-stats.test.ts

# 3. Cold start test (verify no injection with < 5 data points)
pnpm --filter @octopus/server exec vitest run --reporter=verbose src/__tests__/cold-start.test.ts
```

**Pass criteria**: All 7 ACs pass
**Failure handling**: Max 3 fix attempts, then mark SKIP with reason
