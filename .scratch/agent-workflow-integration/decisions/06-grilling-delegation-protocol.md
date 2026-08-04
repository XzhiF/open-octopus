# 06 — Grilling: Delegation Protocol Design

Type: grilling
Status: resolved
Blocked by: 05, 01, 02, 03

## Question

主 workflow session 委派任务给 Agent 时，采用哪种通信协议模式？

## Answer

**Decision: Task Contract + Supervisory Protocol (四层协议栈)**

### Layer 4: Intervention (控制注入)
- `HarnessDirective`: pause | redirect | abort | checkpoint | continue
- 复用 `engine.intervention()` 机制 + promptInjector
- 支持从任意层级注入（父 workflow → 子 workflow → agent）

### Layer 3: Observation (状态观察)
- Agent 发出 `Heartbeat` 事件: {step, tokens_used, artifacts, issues, confidence}
- Harness 规则引擎检查: 预算阈值、停滞检测、置信度阈值
- Heartbeat 通过 SSE 冒泡到任何层级的监控端

### Layer 2: Contract (任务契约)
- `TaskMessage` (入): brief + context + constraints + expected_output + budget + checkpoint_every + sop
- `StructuredResult` (出): status + output + artifacts + vars_update + summary

### Layer 1: Transport (传输)
- 现有 AgentNodeRunner streaming + SSE events
- 复用 VarPool + `$nodeId.output` 变量解析

### 编排兼容性
- Delegation Protocol 与 Orchestration Layer 独立
- octopus_agent 节点在 chain/DAG/loop/dynamic_sub_workflow 中使用一致的 YAML 结构
- Budget 可层级分配（父 workflow → 子 workflow → agent）
- dynamic_sub_workflow 生成 YAML 时直接包含 `type: octopus_agent` 节点
