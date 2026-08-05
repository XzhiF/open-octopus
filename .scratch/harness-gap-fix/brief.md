# Brief: Harness Gap-Fix — 让悬浮窗口真正工作

## Overview
修复 WorkflowEngine Harness 的 6 个运行时 Gap，使悬浮面板从"只读监控"升级为"可干预控制系统"，并通过 E2E 测试验证端到端闭环。

## Summary
- 6 个 Gap 修复 → [spec.md § Implementation Decisions](./spec.md)
- 8 个验收标准 → [spec.md § AC to Verification](./spec.md)
- 3 个核心故事闭环验证 → [spec.md § Appendix](./spec.md)

## Risks
- R1: Proxy 拦截决策回调可能影响引擎性能（每个 retry 增加一次 StrategyEngine 查询）
- R2: repairService 依赖注入可能引入循环依赖

## Full Spec
[spec.md](./spec.md)

## Existing Spec (Round 1)
[../workflow-engine-harness/spec.md](../workflow-engine-harness/spec.md)
