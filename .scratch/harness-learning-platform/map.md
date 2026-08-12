# Wayfinder Map — Harness Learning Platform

## Destination

Harness Agent 成为 Octopus 学习平台的一等公民 — 通过统一的 Experience Store、Knowledge Store、Effectiveness Tracker 和 Evolution Engine，实现跨执行的经验积累和智能进化。所有 Agent 类型通过同一套平台层接口消费记忆和学习能力。

## Decisions so far

| # | Ticket | Decision |
|---|--------|----------|
| 01 | Experience Schema Evolution | 6 新列（scope, scope_ref, pattern_tags, outcome, source_type, execution_id）+ FTS5 content-sync 重建 |
| 02 | Dual Store Unification | 统一到 DB，废弃文件存储（死代码） |
| 03 | Harness Clone Runtime Integration | 混合集成：统一 context 组装 + harness 专用对话管理 + 统一经验持久化 |
| 04 | Unified Prompt Assembler | 全部统一 SystemPromptAssembler + CloneRuntime 为一个接口 |
| 05 | Effectiveness Feedback Loop | 自动追踪 + 统计反馈（outcome pending→success/failed, 定期 reflect 统计成功率） |
| 06 | Harness Evolution Integration | 复用 EvolutionService.reflect()，加 scope 过滤参数 |

## Not yet specified (Fog of War)

- 历史 harness_events 数据是否需要回填到 experiences
- 性能考量：FTS5 搜索在干预路径上的延迟影响
- 前端 Analytics 仪表盘（独立特性，不在本次范围）

## Out of scope

- 向量 embedding / 语义搜索
- Scheduled AgentExecutor 的记忆接入
- 前端 Harness Analytics Dashboard
