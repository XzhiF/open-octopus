# CONTEXT — Octopus Workflow Platform

## Glossary

### Workflow 方法论层

| Term | Definition |
|------|-----------|
| **Ticket** | 垂直切片 — 端到端功能单元（test + schema + API + UI），可在单个 context window 内完成。1 Ticket = 1 Octopus agent node。替代原 Phase/Task 概念。 |
| **Spec** | 实现契约 — 单一连贯文档，含问题、方案、用户故事、测试决策、Seam 约定、Out of Scope。替代原 PRD（5 文档）+ Plan（阶段任务清单）。 |
| **Seam** | 可测试的公共边界 — 测试和调用者走同一个接口。Seam 数量越少越好，理想为 1。优先复用宿主项目现有 Seam。 |
| **Grilling** | 逐问决策拷问 — 一次一个问题，带推荐答案。决策归人，事实归环境（能从代码查到的不问）。 |
| **Vertical Slice** | Ticket 的结构约束 — 切片穿越所有层（schema → API → UI → test），不是单层水平切片。 |
| **Blocking Edge** | Ticket 间依赖声明 — Ticket B depends_on Ticket A。引擎通过 `depends_on` 实现拓扑排序。 |
| **Tracer Bullet** | Ticket 的执行模式 — 从测试到实现到验证的完整路径，验证功能可工作。 |

### Workflow 引擎层（已有，不重定义）

| Term | Definition |
|------|-----------|
| **Node** | YAML 中的一个执行单元（agent / bash / python / condition / approval / loop / swarm）。 |
| **VarPool** | 全局变量池 — `$vars.xxx` 语法访问。节点通过 `vars_update` JSON 写入。 |
| **context: new** | agent 节点属性 — 在全新 context window 中执行，不继承父 agent 上下文。Ticket 隔离的基础。 |
| **Host Contract** | host-audit 节点产出的项目契约文档 — 声明必须复用的现有资产、路由约定、集成门禁。 |

### 审查层

| Term | Definition |
|------|-----------|
| **Standards Axis** | Code review 的 Standards 轴 — 检查代码质量（12-smell baseline + 宿主契约）。独立 sub-agent。 |
| **Spec Axis** | Code review 的 Spec 轴 — 检查实现与 Spec 的对齐（missing / partial / scope-creep）。独立 sub-agent。 |
| **Two-Axis Review** | 两轴并行审查 — Standards 和 Spec 作为独立 sub-agent 并行执行，报告不合并不重排。 |

### TDD 层

| Term | Definition |
|------|-----------|
| **RED** | TDD 循环第一步 — 写一个失败测试。 |
| **GREEN** | TDD 循环第二步 — 最小实现让测试通过。 |
| **Tautological Test** | 自证测试 — expected value 从被测代码推导（如 `expect(add(a,b)).toBe(a+b)`）。禁止。Expected 必须来自独立真相源。 |

## Anti-Patterns（禁止）

| Pattern | Why Banned |
|---------|-----------|
| **Horizontal Slicing** | 按层拆任务（"P1: 所有数据模型"）导致层间依赖雪崩。必须垂直切片。 |
| **Monolithic Implement** | 单 agent 节点吃所有 phases 导致上下文饱和。必须 Ticket 级隔离。 |
| **Optional TDD** | TDD 可选 → TODO/空实现可存活。TDD 必须强制。 |
| **Document Handoff** | 上游产出文档 → 下游重新读取解释 → 推理链断裂。Ticket 必须自带完整 spec 片段。 |
| **TODO as Delivery** | TODO/FIXME/placeholder 作为交付物。grep 硬门禁自动检测。 |
