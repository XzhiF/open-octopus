# Brief: Workflow Execution Observability

## Overview
增强 workflow harness 面板的可观测性：浮动面板摘要指标 + 独立观测详情页（token 消耗图表、轮次追踪、预算对比、错误时间线），支持实时 SSE + 历史分析。

## Summary
- 7 key decisions → [spec.md § Key Decisions](./spec.md)
- 8 acceptance criteria → [spec.md § Acceptance Criteria](./spec.md)
- 4 core stories verified → [spec.md § Appendix](./spec.md)

## Risks
- R1: 实时 SSE 聚合大量节点 token 数据时可能有性能压力
- R2: 图表渲染依赖前端图表库（需选型）
- R3: 预算不设置时为"不限"，UI 需要优雅处理"无预算"状态

## Full Spec
[spec.md](./spec.md)
