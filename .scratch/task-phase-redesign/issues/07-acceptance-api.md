# 07 — acceptance API：通过/打回/auto_advance/入 archiving

## What to build
`POST /api/tasks/:id/acceptance {phase_index, round_index, decision, feedback?}`：写账本（校验当前派生态=awaiting_review、round 匹配最新，否则 409）→ accepted 且 autoAdvance∧i<n → dispatchPhaseRound(i+1,1)；accepted∧i=n → task 进 archiving 并触发归档（票 08 接线，此处可先置状态）；rejected → 反馈产物化 `fix-feedback-r{N}.md` 入 slug 目录并 dispatchPhaseRound(i, round+1)。GET /:id 返回 phases 视图（票 03 派生）。

## Blocked by
03, 05, 06

## Status
ready-for-agent

## Acceptance Criteria
- [ ] AC1: accepted 行落账 + 返回体 next_action=dispatched(next_phase) 或 archiving
- [ ] AC2: autoAdvance=false 时 accepted 不自动开跑，next_action=awaiting_manual_trigger
- [ ] AC3: rejected → feedback 文件生成、round+1 执行开跑、账本两行可追溯
- [ ] AC4: 非 awaiting_review 态调用 → 409；重复 accepted 同 (phase,round) → 幂等或 409（择一有测试）
- [ ] AC5: spec-field 支持 field=phases（乐观锁 version bump）

## Verification Method
**Verification type**: integration test

**Verification steps**:
1. `packages/server/src/__tests__/tasks-v4-acceptance.test.ts`（真 DB + stub dispatch 到 in-process 执行）
2. `pnpm -F @octopus/server test -- tasks-v4-acceptance`

**Pass criteria**: 全绿
**Failure handling**: Max 3 fix attempts, then mark SKIP with reason
