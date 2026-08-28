# Brief: goal-task-dev — goal 模式 loop 语义升级 + task-dev 默认工作流

## Overview

把引擎假 goal 模式(纯 prompt 装配、死字段、撒谎截断)升级为 Claude Code 原生 `/goal` 薄适配器(evaluator 收敛 + error_max_turns 硬保险丝 + active_goal 证据链),并新建两节点 skills-free 的 task-dev 替换看板默认推荐,跑通「入队 → 无人值守 → 人验收」。

## Summary

- 9 个关键决策(K1-K9,含 3 组 CLI 实测锤定)→ [spec.md § Key Decisions](./spec.md)
- 9 条验收条件(AC1-AC9,含两条**真跑不收敛**反向验证 + 存量迁移)→ [spec.md § AC Mapping](./spec.md)
- 3 条核心故事已独立 walkthrough:15 断点(A-O)全部修入 spec → [story-walkthrough.md](./story-walkthrough.md)
- 7 张 DAG 工单 4 stages → [issues/](./issues/)
- 决策地图(9/9 resolved,零遗留 fog)→ [map.md](./map.md) · [decisions/](./decisions/)

## Risks

- R1:/goal 属交互面能力,headless 行为存在版本漂移风险 → supportedCommands() 探测 + buildGoalPrompt 降级保留
- R3:agent-runner 终态白名单触及既有 is_error 路径 → 仅增两 subtype,engine 测试基线回归
- R4:evaluator 质量取决于 condition 写法 → 模板"逐条+证据"句式 + max_turns 兜底可诊断
- 成本:真跑集成测试每次 ~$0.1-0.3

## Full Spec

[spec.md](./spec.md)
