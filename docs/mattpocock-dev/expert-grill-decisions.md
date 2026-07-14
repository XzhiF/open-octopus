# Expert Grill — 决策记录

## D1: 核心变化
Grill 回答者从用户变成专家团。用户只需最后审批共识结果。

## D2: 共识模式
混合模式 — 关键决策（技术方案、数据模型、API 设计）用 debate，简单决策（测试策略、部署）用 review。

## D3: 专家团组成
**核心（必选 3 个）**: 架构师、产品经理、测试专家
**可选（按需 0-3 个）**: 前端专家（仅有 UI 时）、后端专家（复杂 API 时）、安全专家（用户决定）

## D4: 实现路径
方案 A — 纯 YAML 编排，不改 engine。

## D5: 问题处理策略
分批推进 — classify 分析依赖图，批内并行 debate/review，batch 间串行。
需要 loop 包裹 debate/review 节点。
结构: grill-classify → loop [grill-debate/review per batch] → grill-synthesize

## D6: 用户审批
条件审批:
- 默认 auto_answers（全自动，无需用户介入）
- 开启审批模式时：每个 batch 后加 approval 节点（方案 A），用户可逐批审查纠偏

## D7: 产出格式
不单独生成 grill-discussions.md。
- brief.md: 最终共识 decisions + 关键分歧写入"理由"字段
- CONTEXT.md / CONTEXT-MAP.md: 领域词汇（和现有一致）
- 详细讨论可从节点日志查看

## D8: 讨论模式
全部 debate，不做模式分类。
swarm debate 内置共识检测，简单问题 1 轮自动退出。
classify 节点简化为：仅做依赖分析 + 分批。
结构: grill-classify → loop [grill-debate per batch] → grill-synthesize

## D9: Workflow 文件
新文件 `mattpocock-dev-expert.yaml`，和现有 mattpocock-dev 并存。
下游管线（spec → tickets → TDD → ship）两个 workflow 各自声明（engine 不支持 YAML include）。

## D10: Engine 改动 — swarm-in-loop
本次开发内一起做。改动 ~40 行，2 文件：
- loop.ts: constructor 加 checkpointStore/executionId/hookExecutor/agentResolver，createExecutor 加 case "swarm"
- engine.ts: 创建 LoopExecutor 时传入新参数

## D11: 上下文连续性
单 batch 内多轮讨论完整（swarm 内部）。
跨 batch 通过 VarPool 传递结论（不含讨论过程），80% CLI 效果。
每个 swarm 节点 prompt 注入前序 batch 的 decisions 文本。
