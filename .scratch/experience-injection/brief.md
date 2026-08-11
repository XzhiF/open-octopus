# Brief: Experience Injection — 全 Agent 经验注入

## Overview
创建 ContextEnricher 智能富化层，让所有 Agent 类型（Main/Clone/Harness/Workflow）在 prompt 组装时智能检索和注入相关历史经验。

## Summary
- 7 个关键决策 → [spec.md § Key Decisions](./spec.md)
- 10 个验收标准 → [spec.md § Acceptance Criteria](./spec.md)
- 4 个核心故事 → [spec.md § Appendix](./spec.md)

## Risks
- R1: FTS5 搜索在高频聊天路径上增加延迟（目标 < 100ms）
- R2: 经验注入可能引入 token 噪声（需要智能过滤）
- R3: 修改 SystemPromptAssembler 的优先级系统可能影响现有行为

## Full Spec
[spec.md](./spec.md)
