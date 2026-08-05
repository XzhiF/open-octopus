# 05 — Grilling: OctopusAgent Executor Positioning

Type: grilling
Status: resolved
Blocked by: 04

## Question

`octopus_agent` 节点在执行器层面应该怎么定位？与现有 `agent` 节点的关系？

## Answer

**Decision: Agent 扩展模式**

- `OctopusAgentExecutor` 继承/扩展 `AgentExecutor`，复用 90% 基础设施
- 新增能力：
  1. `resolveAgentVersion(agent, version)` — 版本解析（persona/config/skills）
  2. `buildTaskBrief(task)` — 结构化任务简报注入（替代 raw prompt）
  3. `parseStructuredResult(result)` — 结构化结果输出解析
- 新 node type `octopus_agent`，在 ExecutorFactory switch 中注册
- 与现有 `agent` 节点共存，互不干扰
- YAML 结构：agent + version + task{brief, context, expected_output, timeout}
