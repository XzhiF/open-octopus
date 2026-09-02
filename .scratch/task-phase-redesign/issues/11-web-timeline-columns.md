# 11 — web：TemplatePicker 简化 + 五列看板 + phase 时间线（含 legacy 渲染）

## What to build
TemplatePicker：coding 流去 skill_groups 勾选与 preset 预选（直通 task-author）；看板列改为 草稿/待执行/执行中(Phase i/n)/待验收(琥珀)/完成；卡片角标 `Phase i/n · Round m` 与 ⏳超预算徽标（阈值来自 task 派生视图，env `OCTOPUS_PHASE_BUDGET_MS` 可注入）；TaskRunDetailView 顶部 phase 时间线（名/状态/workflow/round 史），v3 legacy 任务派生 `[{legacy:true}]` 单行渲染。

## Blocked by
01, 07

## Status
ready-for-agent

## Acceptance Criteria
- [ ] AC1: 新建 coding 任务全程无技能组/preset 控件（e2e 选择器断言不存在）
- [ ] AC2: 五列正确归属：awaiting_review 任务出现在待验收列且样式高亮
- [ ] AC3: 时间线行数=phases 数；legacy v3 卡不报错、显示单行
- [ ] AC4: env 注入小阈值后 ⏳ 徽标出现

## Verification Method
**Verification type**: browser E2E（Playwright，复用 e2e/helpers/task-domain-helpers.ts）

**Verification steps**:
1. `packages/web-app/e2e/task-phase-board.spec.ts`：AC1-AC4（fixture 任务经 API 直造）
2. `pnpm -F @octopus/web-app exec npx playwright test e2e/task-phase-board.spec.ts`

**Pass criteria**: 全绿
**Failure handling**: Max 3 fix attempts, then mark SKIP with reason
