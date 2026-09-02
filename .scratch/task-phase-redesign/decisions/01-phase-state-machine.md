# 01 — Phase 状态机与看板形态

Type: grilling
Status: resolved

## Question

Task/Phase/Round 三层状态集怎么定？task.status 枚举怎么改（现有 draft/ready/running/completed/failed/aborted）？看板列怎么排（新增待验收列？phase 进度怎么在卡片呈现）？谁驱动 phase 转换（验收动作/引擎自动）？

## Answer

三问三裁决（Q1.1=A, Q1.2=A, Q1.3=A），详见 map D9/D10/D11：

- **状态集**：task `draft→ready→running⇄awaiting_review→archiving→done`（+aborted；无 task 级 failed，失败只归 round 层，task 状态只镜像人的决定）。phase `pending→running→awaiting_review→accepted`；round `running→succeeded/failed`
- **驱动**：首 phase 人工触发（保留定时语义）；验收通过→下一 phase 自动开跑（task 级 `auto_advance` 默认开）；重试永远人工发起（Gate 附反馈开新 Round，绝不自动重试）；末 phase 验收→`archiving`（票08合并）→成功才 done
- **看板**：五列 草稿/待执行/执行中(Phase i/n)/待验收(琥珀高亮)/完成；卡片角标 `Phase i/n · Round m` + phase 时间线；验收界面三栏证据面 = 执行摘要(用时/token/cost) | 产物核对(.scratch 列表+issues 状态) | 动作区(通过/打回[必填反馈]/中止)
- **coding-v4 gate**：phases≥1 ∧ 每 phase 有 spec.md ∧ 每 phase workflow_ref 可解析(沿用 ADR-0013 解析集) ∧ 每 phase required inputs 非空；goal/ac/双确认 4 项停用
