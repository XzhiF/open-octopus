# 13 — web-app 复合 TaskModal（composition DAG + N 子 + 聚合 + 实时）

## What to build
web-app：复合 TaskModal 模式（点 running [复合] 父卡触发，无 drill-down 二次点击）。composition DAG（复用引擎现成流程图组件）+ N 子卡（ws+workflow_ref+status）+ 聚合节点 + 右侧实时 SSE 事件（父+各子 schedule_status）+ 子 ws 跳转执行详情。父卡聚合状态（任一 running→父 running；全 done+聚合→父 done）。

## Blocked by
12, 04

## Status
ready-for-agent

## Acceptance Criteria
- [ ] 点 [复合] 父卡 → modal 复合视图（DAG+N子+聚合），一步到位
- [ ] SSE 实时刷新父+各子状态
- [ ] 子 ws 点击跳转各子执行详情
- [ ] 父卡聚合状态正确

## Verification Method
**Type**: E2E (Playwright)
**Steps**: dispatch composite（3 subunits）→ 点父卡 → 截图 modal DAG+3子+聚合；等子完成 → assert 实时状态变；点子 ws → assert 跳转。
**Pass**: 截图 + assert PASS。**Fail**: max 3 then SKIP。
