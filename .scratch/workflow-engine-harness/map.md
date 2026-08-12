# Wayfinder Map: WorkflowEngine Harness

## Destination

为 Octopus WorkflowEngine 设计一个 **Agentic Harness** —— 一个插件式、可扩展的监督层，能够：
1. 实时监控工作流执行（已有 SSE + Actuator 基础）
2. 检测异常模式（傻重试、死循环、进程冲突）
3. 主动干预执行（暂停、跳过、换策略、换模型、新 session 续跑）
4. 通过注册/插件模式扩展新能力，不侵入引擎核心

最终交付：架构蓝图 + spec + DAG tickets，可直接进入 pipeline 实施。

## Notes

### Octopus 已有的关键基础设施（不要重复造）
- **SSE 事件系统**: 17+ 事件类型，500 条 ring buffer，workspace 隔离
- **Actuator API**: 8 端点（health/executions/errors/system/recovery/scheduler/config）
- **重试策略**: RetryPolicyResolver + FailureClassifier(8类) + backoff(3种+jitter)
- **失败策略**: fail_fast / continue / skip（含下游级联）
- **Checkpoint**: 文件系统 checkpoint（per-node/per-level/per-batch）
- **Recovery Manager**: 启动时自动检测中断执行
- **Repair API**: diagnose/varpool/node-reset/restore-point/reload-yaml/intervene/clear-retry
- **调度器熔断器**: CircuitBreaker + ConsecutiveFailureTracker
- **UI**: 实时节点状态 + DAG 可视化 + Agent 事件渲染 + 控制按钮

### 用户核心诉求
- 不要套用别人方案，要最符合 Octopus 的设计
- 前期不复杂，架构良好，后期通过插件/注册扩展
- 要能从故事/场景角度理解
- Agentic 干预能力（检测 → 判断 → 干预 → 纠正）

### 参考调研（.scratch/research/）
- Pi-Mono: 事件钩子 + Result 模式 + 智能重试分类
- Mastra: TripWire + V8 Isolate + Persist-Every-Step
- Superpowers: 断路器+裁决 + Gap-Focused 迭代 + Ledger

## Decisions so far
<!-- 每个决策一行: [ticket](link) — gist -->
- [01-harness-brain](decisions/01-grilling-harness-brain.md) — 三层委托架构: Detectors → Strategies → Agent Delegation
- [02-engine-hooks](decisions/02-research-engine-hooks.md) — 回调装饰(零改动) + 3个新可选回调(~30行)
- [03-strategy-config](decisions/03-grilling-strategy-config.md) — 全局harness.yaml + 系统管理UI + setup智能合并 + 不加workflow.yaml
- [04-intervention-actions](decisions/04-grilling-intervention-actions.md) — 4种干预模式(inject/takeover/varpool/definition) + 3个新节点状态 + token计费
- [07-ui-enhancement](decisions/07-grilling-ui-enhancement.md) — 悬浮面板(可拖拽/缩放) + chatbot干预 + DAG标记 + LogViewer增强
- [06-process-isolation](decisions/06-grilling-process-isolation.md) — 渐进式安全: 基础层(全平台) + 增强层(Linux/macOS OS沙箱)
- [08-verification](decisions/08-grilling-verification-strategy.md) — 四层验证: 单元+集成(异常workflow)+E2E+接口

## Decision Tickets
<!-- 按编号排列 -->
_待创建_

## Not yet specified (Fog of War)
<!-- 能感觉到但还没法精确定义的问题 -->

- **"Agentic 干预"的具体边界**: 干预者是一个独立的 agent session？还是引擎内的规则引擎？还是两者的结合？
- **插件协议的形式**: middleware chain? event hook? strategy pattern? 需要看引擎代码结构再定
- **UI 增强的范围**: 用户提到"监控在 UI 上的增强"，但具体是什么级别的增强？实时干预面板？异常告警？执行回放？
- **与现有 Repair API 的关系**: repair API 已经有 intervene/clear-retry/node-reset，harness 是包装它们还是替代它们？
- **Scheduler 熔断器 vs 引擎熔断器**: 调度器已有熔断器，引擎级的熔断器应该怎么设计，会不会冲突？

## Out of scope
<!-- 明确不做的事 -->
- OpenTelemetry 分布式追踪导出（已有轻量 tracing）
- Prometheus/Grafana 集成
- 容器级沙箱（Docker/K8s）—— 进程级隔离足够
- 变量类型系统（低优先级）
- 分布式状态存储（Redis）—— SQLite 足够
