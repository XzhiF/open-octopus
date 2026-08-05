# Brief: Octopus Agent UI Wiring + Schema Docs

## Overview
接通 octopus_agent 节点在前端的完整数据流（heartbeat 展示、详情面板、日志渲染），修复版本管理 API 路由未挂载问题，同步 octo-workflow-dev 参考文档（requires 新类型 + octopus_agent 节点类型）。

## Summary
- 9 key decisions → [spec.md § Key Decisions](./spec.md)
- 14 acceptance criteria → [spec.md § Acceptance Criteria](./spec.md)
- 4 core stories verified → [spec.md § Appendix](./spec.md)

## Risks
- R1: heartbeat 轮询依赖 agent-events API 返回 heartbeat 数据，需要确认 server 端持久化路径
- R2: OctopusAgentDetailTabs 需要和 AgentTimeline 共享 per-turn 数据结构，确保复用不引入耦合

## Full Spec
[spec.md](./spec.md)
