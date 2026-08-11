# Map: Harness Semantic V2

## Destination
让 Harness 系统的干预语义完整闭环：每种问题类型有明确的"检测 → 智能路由 → Harness Agent 裁决 → 执行流 → 最终状态"路径，用户能在 UI 上清晰区分正常完成和被干预的执行。

## Notes
- 现有 harness 已经历 3 轮迭代（#35-#37），三层架构已实现（Detector → Strategy → Agent Delegation）
- 参考调研：pi-mono（extension event hooks）和 mastra（Processor + TripWire）都不用 LLM 做 guard
- 但用户明确要求 Harness Agent 统一智能裁决，这是 Octopus 的差异化设计
- 现有 AgentDelegationService 用内联 LLM 调用，不是注册的 core-pack agent

## Decisions so far
- [D1] 阻断后执行流 → Harness Agent 智能裁决（修/阻断/继续）
- [D2] Harness Agent 注册 → core-pack agent（分身管理可见）
- [D3] 干预分类 → 统一智能裁决（策略层只做路由/分级，不执行 action）
- [D4] 执行状态模型 → 双状态补充（executions 表加 harness_status 列）
- [D5] Agent 决策类型 → 5 种：fix_and_retry / guide_and_retry / reconfigure_and_retry / agent_takeover / block_node
- [D6] 策略层路由 → 统一路由到 Agent

## Not yet specified
- Harness Agent 的 prompt 设计（system prompt + delegation context 格式）
- Harness Agent 的 tool 列表（它需要什么工具来分析问题？）
- block_node 后续节点的依赖分析机制
- agent_takeover 的执行方式（Harness Agent 如何替代完成节点目标？）
- timeout_cascade 的修复（当前 pause 是 advisory only）
- 模型映射可配置化（当前硬编码 claude-sonnet-4-20250514）

## Out of scope
- 容器级沙箱（Docker/K8s）
- OpenTelemetry 分布式追踪
- 经验升级系统（Phase 2+）
- workflow.yaml 格式变更
