# ADR 0001: mattpocock-dev 单一工作流架构

**Status**: Accepted
**Date**: 2026-07-14

## Context

Octopus 现有两个 PRD 工作流：prd-forge（文档锻造）和 prd-impl（实现流程）。两者独立运行，prd-forge 产出 5 个文档，prd-impl 消费这些文档进行实现。

复杂需求场景下，prd-impl 始终产出含 blocker/断点/TODO 的 PR。根因分析指向：
1. implement 节点上下文饱和（单体 agent 吃所有 phases）
2. 文档交接导致推理链断裂（prd-impl 重新解释 prd-forge 的产出）
3. TDD 可选导致 TODO/空实现可存活

## Decision

创建单一 `mattpocock-dev` 工作流，融合完整链条：

```
Host-Audit → Grill → Spec → Tickets → Loop[Ticket TDD + Two-Axis Review] → Ship
```

不拆分为 forge/impl 两个工作流。

**关键架构约束**：
- Ticket = Octopus agent node（1:1），`context: new` 隔离
- Spec 替代 PRD + Plan（单一连贯文档）
- 强制 TDD（SEAM → RED → GREEN → VERIFY）
- 两轴并行 code review（Standards ∥ Spec）
- 垂直切片（禁止水平分层）

## Consequences

**Positive**:
- 推理链连续：Grill 的决策 → Spec 综合 → Ticket 拆分 → 实现，无断裂
- 上下文隔离：每个 Ticket fresh context，不随 ticket 数膨胀
- TDD 强制：测试不过 = 未完成，从根本上消灭 TODO/空实现
- 反馈环短：每个 Ticket 完成后立即 review，不积累到最终

**Negative**:
- 单一工作流 timeout 更长（需覆盖全链条）
- Ticket 粒度控制难度：太大回到老问题，太小数量爆炸
- `context: new` 在 loop 迭代间的隔离效果需实测验证
- 无人值守时 Grill 的 auto_answers 可能做出用户不同意的决策

**Neutral**:
- 与现有 prd-forge/prd-impl 并行存在，不替代。用户自选。
- 需要 CONTEXT.md 领域模型支撑术语一致性
