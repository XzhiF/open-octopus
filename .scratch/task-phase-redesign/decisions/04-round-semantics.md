# 04 — Round 语义细则

Type: grilling
Status: resolved
Blocked by: ~~01~~, ~~03~~（均 resolved）

## Question

Round 的精确语义：验收是 per-phase 还是 per-round（末 round 通过 = phase 通过？）；打回→新 Round 的触发链（chat 反馈产物化→选"修复流 vs round-2 spec"的决策者是人还是 agent 推荐）；Round 上限与死循环防护；每 Round 的产物目录（同 slug 内 round-N 子目录？）。

## Answer

Q4.1 裁决 A（四条全收），见 map D13：

1. **Round 形态决策**：agent 推荐 + 人一键确认。打回弹窗人只写反馈 → agent 判严重度：局部修 → 「通用修复流」（产 fix-report-rN.md，不产新 spec）；范围/方案变 → 「round-2 spec」（产 spec-r2.md 再执行原 phase workflow）
2. **产物目录**：同 phase slug 目录内迭代（phase↔slug 恒 1:1）；`spec.md` 冻结首版 + `spec-rN.md` 并存不丢历史；issues/ 原位增量更新（Status 字段即进度真相）
3. **验收粒度**：per-round 执行、per-phase 记账——phase accepted = 账本中该 phase 存在任一 accepted 行（挂 round_index 溯源）
4. **Round 无上限**（状态机不变量）：每 round 必人工点击发起（D10-③），无限循环物理不可能；不设计数器
5. **运行中 chat 介入 = Out of scope 本版不做**：运行中只读，反馈统一在 awaiting_review 输入
