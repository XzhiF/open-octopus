# Context Map — Octopus Workflow Platform

## System-wide Glossary

| Term | Definition | Primary Package |
|------|-----------|----------------|
| **Ticket** | 垂直切片 — 端到端功能单元（test + schema + API + UI），可在单个 context window 内完成。 | engine, core-pack |
| **Spec** | 实现契约 — 单一连贯文档，含问题、方案、用户故事、测试决策、Seam 约定、Out of Scope。 | core-pack |
| **Seam** | 可测试的公共边界 — 测试和调用者走同一个接口。数量越少越好，理想为 1。 | core-pack |
| **Grilling** | 逐问决策拷问 — 一次一个问题，带推荐答案。决策归人，事实归环境。 | core-pack |
| **Vertical Slice** | Ticket 的结构约束 — 切片穿越所有层（schema → API → UI → test）。 | core-pack |
| **Blocking Edge** | Ticket 间依赖声明 — 引擎通过 `depends_on` 实现拓扑排序。 | engine |
| **Tracer Bullet** | Ticket 的执行模式 — 从测试到实现到验证的完整路径。 | core-pack |
| **Node** | YAML 中的一个执行单元（agent / bash / python / condition / approval / loop / swarm）。 | engine |
| **VarPool** | 全局变量池 — `$vars.xxx` 语法访问。节点通过 `vars_update` JSON 写入。 | engine, shared |
| **context: new** | agent 节点属性 — 在全新 context window 中执行，不继承父 agent 上下文。 | engine |
| **Two-Axis Review** | 两轴并行审查 — Standards 和 Spec 作为独立 sub-agent 并行执行，报告不合并不重排。 | engine, core-pack |
| **Standards Axis** | Code review 的代码质量轴 — 12-smell baseline + 项目约定。独立 sub-agent。 | engine |
| **Spec Axis** | Code review 的需求覆盖轴 — 检查实现与 Spec 的对齐。独立 sub-agent。 | engine |
| **RED** | TDD 循环第一步 — 写一个失败测试。 | core-pack |
| **GREEN** | TDD 循环第二步 — 最小实现让测试通过。 | core-pack |
| **Tautological Test** | 自证测试 — expected value 从被测代码推导。禁止。Expected 必须来自独立真相源。 | core-pack |
| **Restore Point** | 工作流中一个已完成节点的时间点标记，包含该时刻的 VarPool 快照和节点结果。用于恢复点重跑。 | engine, server |
| **Intervention** | 向正在运行的节点注入额外的指导消息，引导 agent 改变行为方向。 | engine, server |
| **Hot Reload** | 工作流执行过程中修改 YAML 定义，后续未执行节点使用新定义。正在执行的节点不受影响。 | engine, server |
| **False Completion** | Agent 节点返回 completed 状态但实际工作未完成。通过诊断发现，通过节点重置修复。 | server |
| **Diagnose Report** | 对执行现场的结构化分析，包含节点状态、异常识别（stuck/exhausted/false_completion/infinite_retry）、修复建议。 | server |
| **Output Injection** | 人工提供节点的输出数据，替代自动执行的结果。用于跳过故障节点继续执行。 | server |

## Anti-Patterns（禁止）

| Pattern | Why Banned |
|---------|-----------|
| **Horizontal Slicing** | 按层拆任务导致层间依赖雪崩。必须垂直切片。 |
| **Monolithic Implement** | 单 agent 节点吃所有 phases 导致上下文饱和。必须 Ticket 级隔离。 |
| **Optional TDD** | TDD 可选 → TODO/空实现可存活。TDD 必须强制。 |
| **Document Handoff** | 上游产出文档 → 下游重新读取解释 → 推理链断裂。Ticket 必须自带完整 spec 片段。 |
| **TODO as Delivery** | TODO/FIXME/placeholder 作为交付物。grep 硬门禁自动检测。 |

## Package Contexts

| Package | Context File | Domain |
|---------|-------------|--------|
| shared  | `packages/shared/CONTEXT.md` | Cross-cutting types, schemas, config |
| providers | `packages/providers/CONTEXT.md` | AI provider abstraction |
| cli | `packages/cli/CONTEXT.md` | CLI commands and user interaction |
| engine | `packages/engine/CONTEXT.md` | Workflow execution engine |
| server | `packages/server/CONTEXT.md` | REST API + SSE + WebSocket |
| web-app | `packages/web-app/CONTEXT.md` | Next.js frontend |
| core-pack | `packages/core-pack/CONTEXT.md` | Bundled skills, agents, workflows |

## Cross-Package Relationships

```
shared ← (无依赖，所有包依赖它)
providers ← shared
cli ← shared + engine + core-pack
engine ← shared + providers
server ← shared + engine + core-pack + providers
web-app ← shared
core-pack ← (纯数据资源)
```

## System-wide ADRs

- [0001-mattpocock-dev-single-workflow.md](docs/adr/0001-mattpocock-dev-single-workflow.md) — 单一工作流 vs 拆分
