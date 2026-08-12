# 04 — Effectiveness Tracker (Outcome + Stats)

## What to build
实现干预效果追踪闭环：在 onExecutionEnd() 中根据执行最终状态批量更新 pending experiences 的 outcome，提供 getSuccessStats 统计接口，并在干预 prompt 中注入成功率数据（含冷启动保护）。

## Blocked by
01 — Schema Migration (needs outcome + node_id columns)
03 — Harness Experience Recording (needs experience rows to update)

## Status
done

## Acceptance Criteria
- [x] AC-1: onExecutionEnd() 根据执行最终状态批量更新 pending experiences 的 outcome
- [x] AC-2: 执行 completed → 所有干预 outcome.label = 'success'
- [x] AC-3: 执行 failed → 最后失败节点的干预 outcome.label = 'failed'，其余为 'success'
- [x] AC-4: getSuccessStats() 返回 decision × pattern 成功率（30天窗口，min N=5）
- [x] AC-5: 干预 prompt 中包含成功率数据（≥5 数据点时）
- [x] AC-6: 冷启动保护：< 5 数据点时跳过注入，显示 "经验积累中..."
- [x] AC-7: 成功率公式: count(success) / count(total) per decision×detector

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

## Exploration

### Analog studied
- Ticket 03 (Harness Experience Recording) — `HarnessController.recordSessionExperiences()` as the analog for outcome updating
- `EvolutionDAO.getSuccessStats()` — existing stats aggregation used for injection
- `AgentDelegationService.buildPromptWithHistory()` — existing prompt assembly path

### Files modified
1. `packages/server/src/db/dao/evolution-dao.ts` — Added `listByExecutionId()` to query experiences by execution_id with optional outcome filter
2. `packages/server/src/services/harness/effectiveness-tracker.ts` — **NEW** — Cold start protection + stats prompt formatting
3. `packages/server/src/services/harness/harness-controller.ts` — Added `updateExperienceOutcomes()` + optional `opts` param to `onExecutionEnd()`
4. `packages/server/src/services/harness/agent-delegation.ts` — Wired `evolutionDao` into deps, added stats injection to `buildPromptWithHistory()`
5. `packages/server/src/services/execution/ExecutionLifecycle.ts` — Updated 3 main callers to pass execution status (completed/failed/cancelled)
6. `packages/server/src/__tests__/effectiveness-tracker.test.ts` — **NEW** — 12 tests covering all 7 ACs

### Key functions
- `EvolutionDAO.listByExecutionId(executionId, opts?)` — query experiences for outcome batch-update
- `EvolutionDAO.updateOutcome(id, outcome)` — existing, used to update each experience
- `HarnessController.updateExperienceOutcomes()` — new private method for batch update
- `buildStatsSection(stats)` — handles cold start check + prompt formatting
- `AgentDelegationService.buildStatsSectionForReport()` — private helper for per-detector stats
