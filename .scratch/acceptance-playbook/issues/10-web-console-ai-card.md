# 10 — web: 控制台撤 verdict + AI 消耗卡三层化

## What to build
phase-surface.tsx:删 :353-372 verdict 行 → 「→ 去验货台验收」CTA(ctx.openAcceptance,原样式);TaskAiUsageCard 迁入 phase-surface 主列第一块(agg 口径=任务全量非 round:fetchLLMCalls 按 execIds 合并 useRunsAggregates 已有),卡片按 S5/原型重做:总计 7 瓷砖(∑↑↓⚡🗡️请求成本)/按模型行(AggInline 同款串)/分轮行(有轮数据才列;Top3 节点数据缺则整行不显示,不猜)/编写期开关(数据源缺就隐藏开关并注);验货台侧删干净(summary 卡、agg state、import)。

## Blocked by
08

## Status
pending

## Acceptance Criteria
- [ ] AC1: 控制台 DOM 无 data-verdict-row/acceptance-approve;CTA 切 tab 生效
- [ ] AC2: AI 卡三层字段完整(七量纲),execution-summary.test.tsx 更新全绿
- [ ] AC3: 验货台无 token/cost 字样(grep test 断言)

## Verification Method
**type**: component test + e2e 两 spec 更新(task-phase-acceptance:487,572 / task-phase-lifecycle:722,775 改走验货台锚点)。
