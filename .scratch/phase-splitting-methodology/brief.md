# Brief: 拆 Phase 方法论改造（phase = 完整故事判据）

## Overview
把 task-author 的拆 Phase 方法论从「票层时间预算借位」（≤1h/phase → phase≈issue 的根因）改造为**故事判据体系**：phase 集 = 故事集（MVP 薄切片 + 其后每故事一个 phase），配套两段式对话预算、不画雾纪律、零新增账本的衔接预告。

## Summary
- 10 条关键决策（grilling 七叉全收敛）→ [spec.md § Key Decisions](./spec.md)
- 9 条验收标准 → [spec.md § Acceptance Criteria 与验证映射](./spec.md)
- 5 张票（4 功能 + 1 E2E dogfood），2 个 DAG stage → [issues/](./issues/)

## Risks
- R1: 判据重写下 LLM 执行惯性仍可能滑回票大小 —— dogfood 首航（票 05）是实证检验
- R2: 「故事」与 spec 的 User Stories 清单词层混用 —— CONTEXT-MAP 澄清行兜底
- R3: SKILL/persona/ADR 三源同判据漂移 —— grep 一致性断言兜底（票 04）

## Full Spec
[spec.md](./spec.md)
