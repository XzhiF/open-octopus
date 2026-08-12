# 05 — Effectiveness Feedback Loop

Type: grilling
Status: resolved
Blocked by: 01

## Answer

**自动追踪 + 统计反馈闭环**：
- 干预发生时记录 experience（outcome: pending）
- 节点重试后自动更新 outcome（success / failed）
- 定期 reflect 统计各 decision × pattern 的成功率
- 下次干预时将成功率数据注入 prompt（"历史相似案例: fix_and_retry 成功率 87%"）

## Question

如何追踪 Harness 干预是否有效？

- 干预后节点重试成功 → outcome: success
- 干预后节点再次失败 → outcome: failed
- 如何关联 intervention → retry outcome？
- 与 knowledge_effectiveness 的关系？
- 效果数据如何影响后续干预决策？
