# 05 — failed/aborted 生命周期 writers + buildSchedulerJob cast

## What to build
server：handleChainComplete 失败路径（workflow-executor.ts:372-399 现只标 schedule_executions）→ 加 `schedules.status='failed'` writer。buildSchedulerJob（scheduler-engine.ts:653）cast 扩到全 ScheduleStatus（含 running/done/failed/aborted，不再只 draft/queued/claimed）。

## Blocked by
01

## Status
ready-for-agent

## Acceptance Criteria
- [ ] 执行失败 → schedules.status='failed'（非卡 running）
- [ ] **failed/aborted 是 terminal：checkStaleClaimed 不回滚 failed/aborted**（否则 stale→重派无限循环，scheduler-engine.ts:413）
- [ ] retry cap：连续失败 N 次后停（不再无限重派）
- [ ] buildSchedulerJob 返回 running/done/failed/aborted 正确（不丢类型）
- [ ] 看板 failed 列能收到 failed 任务

## Verification Method
**Type**: unit + integration
**Steps**: unit — buildSchedulerJob 各 status assert；integration — 触发执行失败（mock workflow fail）→ SELECT schedules.status='failed' + schedule_executions.status='failed'。
**Pass**: assert PASS。**Fail**: max 3 then SKIP。
