# Brief: Harness Learning Platform

## Overview
统一 Octopus Agent 学习平台层，让 Harness Agent 通过已有的 experiences + FTS5 + Evolution 基础设施实现跨执行的经验积累和智能进化。

## Summary
- 6 个关键决策 → [spec.md § Key Decisions](./spec.md)
- 12 个验收标准 → [spec.md § Acceptance Criteria](./spec.md)
- 4 个核心故事 → [spec.md § Appendix](./spec.md)

## Risks
- R1: Unified Prompt Assembler 统一范围大，可能影响现有 Clone 行为
- R2: FTS5 搜索在干预路径上增加延迟（需 < 200ms）
- R3: Schema migration 需保证现有 experiences 读写不受影响

## Full Spec
[spec.md](./spec.md)
