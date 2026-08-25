# 14 — 集成 + E2E 全链路（composite 端到端 + crash recovery + abort + failed）

## What to build
端到端验证：composite 真 dispatch（真子 schedule，非 mock）+ crash recovery（composite 父/子 stale 回滚，failed terminal 不重派）+ abort + failed 显示。Playwright 全链路：author 简单 & 复合 → enqueue → dispatch → modal → done；abort；failed→failed 列。

## Blocked by
11, 13, 06, 07

## Status
ready-for-agent

## Acceptance Criteria
- [ ] composite 真 dispatch（3 子真 ws）→ 全 done + moa 聚合
- [ ] composite 父 stale 回滚；子 failed → 父 failed（terminal，不无限重派）
- [ ] abort 运行 composite → aborted + 各子 ws cleaned
- [ ] failed 任务 → 看板 failed 列
- [ ] Playwright 全链路绿（author 简单 + 复合 + abort + failed）

## Verification Method
**Type**: E2E (Playwright) + integration
**Steps**: Playwright `e2e/task-pool.spec.ts`：author simple → enqueue → dispatch → modal → done；author composite(3 subunits) → dispatch → composite modal → 子跳转 → done；dispatch → abort → assert aborted+cleaned；触发失败 → assert failed 列 + 不重派。integration: composite stale → rollback + SSE。
**Pass**: all PASS + 截图。**Fail**: max 3 then SKIP。
