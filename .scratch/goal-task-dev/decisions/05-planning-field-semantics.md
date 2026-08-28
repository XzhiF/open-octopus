# 05 — D4 planning 字段语义表 + tools 救活范围

Type: grilling
Status: resolved
Blocked by: 03

## Question

基于 03 的 SDK 能力清单,钉死 planning 字段去向与 tools 接线范围。

## Answer

**planning 块整体废弃**(零 YAML 遗留,research 08 锤实)。实测锤定 maxTurns×/goal 正交性:`--max-turns 2` 成功掐断永不满足的 goal(`error_max_turns / terminal_reason:max_turns / num_turns:3`)——evaluator 拦停续跑同样消耗 turn 计数,是行业所称 outermost fuse。

字段去向:
| 旧 | 新 | 接线 |
|---|---|---|
| planning.max_turns | **节点级 `max_turns:`**(通用,所有 agent 节点受益) | provider L2/L3 → SDK Options.maxTurns |
| planning.verify | 删除 | — |
| planning.tools | 删除,统一走**既有 `node.tools:`**(现状死字段) | → SDK Options.tools(=可用工具基础集,语义吻合;provider 已直通) |
| planning.disallowed_tools | **节点级 `disallowed_tools:`** | → SDK disallowedTools(已从模型上下文移除) |
| (新增)**`max_budget_usd:`** | 节点级 | → SDK maxBudgetUsd(原生终态 error_max_budget_usd;SendQueryOptions 已有定义,救活死字段)。钱与 turn 是无人值守两条独立失控轴(5a=要) |

**引擎降级策略(5b=确认)**:claude engine 之外的节点写了 max_turns/tools/disallowed_tools/max_budget_usd → **静默忽略 + validate 警告**(能力差异如实报告,不炸)。
constraints **保留**(prompt 段,与 planning 无关)。agent-runner 需特判 error_max_turns/error_max_budget_usd 两终态(L6,现 throw)。
