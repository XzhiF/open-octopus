# 06 — Tasks Tab

Type: grilling | Status: resolved

## Question
Tasks tab 跟 Scheduler 模块重复，怎么处理？

## Answer
**A: 移除。** Main Agent 不需要重复 Scheduler 的功能。Agent 触发工作流通过 `@@delegate` 给分身或调用 Scheduler API。长任务执行和定时任务是 Scheduler/Workflow Engine 的职责。
