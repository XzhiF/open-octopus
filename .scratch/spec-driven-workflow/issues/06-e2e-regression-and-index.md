# 06 — 回归收口 + 文档接线

Status: needs-info

## What
pnpm build 全链绿；server/web 全量对基线（红数只降不升）；playwright 四流（task-authoring-v4 / task-phase-acceptance / task-phase-board / task-domain-draft-linkage）；persona-v3-instructions 测试适配；SKILL/persona sync-builtin 三处一致；本目录 + index.md 状态回填。

## Verification Method
- 四方交叉手测：新建 v4 草稿 → 看板绑 matt-spec-dev → ready → trigger（本机不再撞冒号）→ 待验收 → 打回选 fix → schedules.config.workflow_chain[0].workflow_ref='built-in/task-fix'（DB）+ ws 批次目录有合成输入（fs）+ 弹窗回显（UI）
- 若真机执行仍被环境挡 → 如实标 SKIP，不假绿
