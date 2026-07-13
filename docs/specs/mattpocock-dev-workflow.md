# Spec: mattpocock-dev Workflow

## Problem Statement

使用 prd-forge + prd-impl 工作流实现复杂需求时，产出的 PR 始终存在三类问题：

1. **Blocker** — 代码审查发现阻塞性问题（宿主契约违反、接线缺失）
2. **断点** — 部分功能实现不完整，中途断裂
3. **TODO/空实现** — 代码中存在 TODO 注释、空函数体、placeholder 实现

无论需求描述多详细，问题始终存在。简单的需求可以完成，稍复杂就糟糕。

**根因分析**：

- **实现单元太大** — implement 节点是单体 agent（24h timeout），一次性吃掉 plan 的所有 phases。上下文随 task 数膨胀，超过 smart zone（~120k tokens）后推理质量急剧下降。
- **反馈环太长** — Plan 在 Phase 0 写，Implement 在 Phase 2 执行，中间隔了大量 LLM 调用。Plan 的细节在 implement 的上下文中被稀释。
- **TDD 可选** — subagent-driven-development 的 implementer-prompt 说"如果任务要求则遵循 TDD"。不强制 TDD → TODO/空实现可以存活（没有失败测试逼迫实现）。
- **水平分层** — Plan 按层拆（P1: 数据模型 → P2: API → P3: UI），不是按功能垂直切片。导致前面层的错误在后面的层才暴露，雪崩式阻塞。
- **文档交接断裂** — prd-forge 产出 5 个文档 → prd-impl 重新读取解释 → 推理链断裂。implement 读到的是"死文档"，不是写文档时的推理上下文。

已尝试的方法论（superpowers-zh 工程方法论、Matt Pocock skills 分析）对简单需求有效，复杂需求仍然失败。

## Solution

创建一个单一的 `mattpocock-dev` 工作流，融合 Matt Pocock 的链条哲学与 Octopus 引擎能力：

```
Grill → Spec → Tickets → 逐 Ticket TDD → Ship
```

**核心设计决策**：

1. **单一工作流** — 不拆 forge/impl。链条连续性保证推理上下文不丢失。每个 Ticket 自带完整 spec 片段，不依赖外部文档。
2. **Ticket = Node（1:1 映射）** — 每个 Ticket 是一个 Octopus agent 节点，使用 `context: new` 隔离上下文。废弃 Phase/Task 概念。
3. **垂直切片** — 每个 Ticket 是端到端功能切片（test → schema → API → UI），禁止水平分层。
4. **强制 TDD** — 每个 Ticket 遵循 SEAM → RED → GREEN → VERIFY 循环。测试不过 = Ticket 未完成。从根本上消灭 TODO/空实现。
5. **两轴并行审查** — 每个 Ticket 完成后，Standards sub-agent 和 Spec sub-agent 并行独立审查，互不污染。
6. **Spec 替代 PRD + Plan** — 单一连贯文档，包含问题 → 方案 → 用户故事 → 测试决策 → Seam 约定 → Out of Scope。

## User Stories

### Grill 阶段
1. As a product owner, I want工作流逐个问题拷问我的 Idea 并带推荐答案, so that 所有关键决策在实现前被显式确认
2. As a product owner, I want AI 能从代码查到的事实不问我, so that 交互只聚焦在真正需要人决策的地方
3. As a product owner, I want工作流在无人值守时自动选择推荐答案, so that 我可以启动后离开
4. As a product owner, I want每个决策都记录在案, so that 后续 Ticket 能追溯决策理由

### Spec 阶段
5. As a workflow user, I want从 Grill 共识综合出单一 Spec 文档, so that 不需要在 5 个独立文档间跳转
6. As a workflow user, I want Spec 包含 Seam 约定（测试边界）, so that TDD 阶段知道在哪个接口写测试
7. As a workflow user, I want Spec 包含明确的 Out of Scope, so that 实现不会蔓延到不需要的功能
8. As a workflow user, I want Spec 包含跨模型审查（sonnet 审 opus）, so that 打破同模型回音室
9. As a workflow user, I want Spec 的用户故事列表极其详尽, so that 每个行为都被覆盖

### Tickets 阶段
10. As a developer, I want Spec 被拆分为垂直切片 Tickets, so that 每个 Ticket 可独立完成和验证
11. As a developer, I want每个 Ticket 自带完整 spec 片段, so that 实现时不依赖外部文档上下文
12. As a developer, I want每个 Ticket 声明 blocking edges, so that 按依赖顺序执行，不出现"上游没完成就开始下游"
13. As a developer, I want每个 Ticket ≤ 3 个文件变更, so that 始终在 smart zone 内完成
14. As a developer, I want Ticket 描述端到端行为而非按层实现清单, so that 实现者有完整视角
15. As a developer, I want禁止水平切片 Ticket, so that 不会出现"所有数据模型"这种粗粒度任务

### TDD 实现阶段
16. As a developer, I want每个 Ticket 在 fresh context window 中执行, so that 前一个 Ticket 的上下文不污染当前
17. As a developer, I want先确认 Seam 再写测试, so that 测试在正确的抽象层
18. As a developer, I want先写失败测试再写实现（RED → GREEN）, so that TODO/空实现不可能通过测试
19. As a developer, I want持续 typecheck 而非只在最后检查, so that 类型错误在引入时就被发现
20. As a developer, I want每个 Ticket 完成后立即两轴并行审查, so that 问题在当 Ticket 发现而非积累
21. As a developer, I want Standards 审查检查 12-smell baseline + 宿主契约, so that 代码质量有底线
22. As a developer, I want Spec 审查检查 missing/partial/scope-creep, so that 实现与 spec 对齐
23. As a developer, I want反 TODO 硬门禁（grep 扫描）, so that placeholder 代码被自动检测
24. As a developer, I want每个 Ticket 一个 commit, so that git 历史清晰可追溯

### Ship 阶段
25. As a developer, I want所有 Ticket 完成后自动创建 PR, so that 交付不依赖手动操作
26. As a developer, I want PR 描述从 Spec 综合而非审计报告转储, so that reviewer 能理解功能意图

### 整体
27. As a workflow user, I want工作流保持宿主项目契约（host-contract）扫描, so that 新代码复用现有组件而非凭空创造
28. As a workflow user, I want工作流支持 interactive/autonomous 两种模式, so that 简单场景可以无人值守
29. As a workflow user, I want每个阶段有通知（notify hook）, so that 我能追踪进度

## Implementation Decisions

### D1: 单一工作流，不拆 forge/impl

**决策**：`mattpocock-dev.yaml` 是一个工作流文件，包含完整链条。

**理由**：forge/impl 拆分导致文档交接断裂。implement 读到的是"死文档"，丢失了 forge 阶段的推理链。单一工作流中，Spec 和 Tickets 在变量池中保持结构化数据，Ticket 节点直接消费。

**Trade-off**：单一工作流 timeout 更长。但每个 Ticket 节点 `context: new`，实际 token 消耗分散。

### D2: Ticket = Octopus Agent Node（1:1 映射）

**决策**：每个 Ticket 对应 YAML 中的一个 `type: agent` 节点，设 `context: new`。

**理由**：`context: new` 保证每个 Ticket 在 fresh context window 中执行，防止上下文膨胀。Octopus 引擎的 `depends_on` 天然实现 blocking edges。

**实现约束**：Tickets 数量在 Spec 阶段确定，但 YAML 是静态文件。解决方案：用 `loop` 节点遍历 tickets 队列（变量池 JSON），每个迭代 `context: new`。

### D3: Grill 节点用 agent + auto_answers

**决策**：Grill 阶段用 `type: agent` 节点，prompt 中编码 grilling 纪律。`auto_answers` 让 AI 自决（无人值守时）。

**理由**：`type: approval` 只能提供预设选项，不够灵活。agent 节点可以生成开放式问题 + 推荐答案。

**交互模式**：
- `inputs.interactive == "true"` → 用 approval 节点逐题确认
- `inputs.interactive == "false"`（默认）→ auto_answers 自动选推荐答案

### D4: Spec 文档结构

**决策**：单一 Spec 文档，结构遵循 Matt Pocock `/to-spec` 模板：

1. Problem Statement（用户视角）
2. Solution（用户视角）
3. User Stories（极其详尽的编号列表）
4. Implementation Decisions（模块/接口/架构/schema/API）
5. Testing Decisions（Seam 约定 + 测试策略）
6. Out of Scope

**不包含**：具体文件路径或代码片段（它们会很快过时）。

### D5: Seam 约定

**决策**：Spec 必须包含 Testing Decisions 章节，声明测试边界（Seam）。

**Seam 来源优先级**：
1. 宿主项目现有 Seam（host-audit 提取的公共接口）
2. 新 Seam（仅在现有 Seam 无法覆盖时创建）

**规则**：Seam 数量越少越好，理想为 1。

### D6: Ticket 垂直切片约束

**决策**：每个 Ticket 必须是端到端垂直切片。

**硬约束**：
- ≤ 3 个文件变更
- 包含测试 + 实现（不允许"只写测试"或"只写实现"的 Ticket）
- 描述端到端行为（"用户可以登录并看到 dashboard"），不是按层实现清单（"创建 User schema"）
- 可在单个 context window 内完成

**例外**：宽重构（rename column, retype shared symbol）使用 expand-contract 序列而非垂直切片。

### D7: TDD 循环（SEAM → RED → GREEN → VERIFY）

**决策**：每个 Ticket 节点的 prompt 强制 TDD 循环。

**步骤**：
1. **SEAM** — 从 Ticket spec 片段提取测试边界
2. **RED** — 写一个失败测试（Given/When/Then）
3. **GREEN** — 最小实现让测试通过
4. **VERIFY** — build + typecheck + test 全绿
5. 重复 2-4 直到 Ticket 所有验收标准通过

**禁止**：
- 水平切片（先写所有测试再写所有实现）
- TDD 循环内重构（重构属于 code-review 阶段）
- 自证测试（expected value 必须来自独立真相源）
- mock 内部协作者（只 mock 系统边界：外部 API、数据库、时间、文件系统）

### D8: 两轴并行 Code Review

**决策**：每个 Ticket VERIFY 通过后，spawn 两个并行 sub-agent 做 code review。

**轴 1: Standards**
- 输入：diff + 宿主契约 + 12-smell baseline（Fowler ch.3）
- 检查：命名/重复/Feature Envy/Data Clumps/Primitive Obsession 等
- 宿主契约违反计为 BLOCKER

**轴 2: Spec**
- 输入：diff + Ticket spec 片段
- 检查：(a) missing/partial 实现 (b) scope creep (c) 实现看起来错的地方
- Missing/partial 计为 BLOCKER

**规则**：两轴独立报告，不合并不重排。任一轴有 BLOCKER → Ticket 未完成。

### D9: 反 TODO 硬门禁

**决策**：每个 Ticket commit 前执行 grep 扫描。

```
grep -rn "TODO\|FIXME\|HACK\|XXX\|not.implemented\|throw new Error.*Not\|throw new Error.*not yet"
```

每个匹配计为 BLOCKER，必须由 code-review 的 Spec 轴确认后修复。

### D10: Host-Audit 保留

**决策**：保留当前 prd-impl 的 host-audit 节点设计。

**理由**：host-contract.md 防止 LLM 不看现有代码就凭空创造组件。这个设计经过验证，效果好。

**位置**：在 Grill 之前执行（先了解宿主项目再拷问 Idea）。

### D11: Loop 节点实现 Ticket 队列

**决策**：用 Octopus `type: loop` 节点遍历 tickets 队列。

```yaml
- id: tickets-loop
  type: loop
  max_iterations: $vars.ticket_count
  nodes:
    - id: ticket-impl
      type: agent
      context: new
      prompt: |
        实现 Ticket $iteration/$vars.ticket_count:
        $vars.tickets[$iteration]
```

**理由**：避免静态 YAML 中硬编码 N 个节点。loop 天然支持可变数量的 tickets。

**约束**：每个迭代 `context: new`，防止跨 ticket 上下文污染。

### D12: 通知策略

**决策**：每个关键节点成功时发通知（保留当前 prd-impl 的 notify hook 模式）。

**通知节点**：
- host-audit 完成
- grill 完成
- spec 完成
- tickets 拆分完成（含 ticket 数量和依赖图）
- 每个 ticket 完成（含进度 N/Total）
- ship 完成

## Testing Decisions

### 什么是好的测试

- 测试验证行为（通过公共接口），不测试实现细节
- Expected value 来自独立真相源（已知正确的字面量、worked example、spec），不从被测代码推导
- 测试不因内部重构而失败（"代码完全换了，测试不该变"）

### 测试哪些模块

**Seam 1: Workflow 级别**
- 工作流 YAML 通过 `octopus workflow validate` 校验
- 工作流可被 `octopus workflow run` 执行
- 每个阶段的产出文件存在且非空

**Seam 2: Ticket 级别**
- 每个 Ticket 的 TDD 循环产出通过的测试
- 反 TODO grep 扫描通过
- 两轴 code review 通过

### 先验参考

- 当前 prd-impl 的 `octopus workflow validate` 校验模式
- 当前 prd-impl 的 host-contract 门禁检查模式
- Matt Pocock `/tdd` 的红绿循环模式

## Out of Scope

1. **修改 Octopus 引擎** — 不新增执行器类型、不修改变量系统、不改变 loop 节点行为。完全在现有引擎能力内实现。
2. **E2E 测试集成** — 不在 mattpocock-dev 中集成 E2E 测试运行。E2E 是独立关注点，由现有 prd-impl-e2e-resume 或独立 E2E 流程处理。
3. **多项目支持** — 初版只支持单项目。多项目（split-code）路由逻辑不在范围内。
4. **替代现有 prd-forge/prd-impl** — mattpocock-dev 是并行选项，不替代现有工作流。用户自选使用哪个。
5. **交互式 UI 改造** — 不改 web-app 的工作流执行 UI。interactive 模式通过 approval 节点实现。
6. **Ticket 持久化到外部 tracker** — 初版 tickets 存在变量池 + 输出文件，不推送到 GitHub Issues / Linear。

## Further Notes

### 与 subagent-driven-development 的关系

mattpocock-dev **不替代** subagent-driven-development skill。它是更高层的工作流编排，内部可以使用 subagent-driven-development 的模式（子代理委派 + 两阶段审查）。但增加了三个硬约束：
1. 强制 TDD（不是可选）
2. 垂直切片（不是水平分层）
3. 两轴并行审查（不是串行）

### 与现有工作流的关系

| 工作流 | 定位 | 适合场景 |
|--------|------|---------|
| prd-forge | 文档锻造 | 需要完整 PRD 文档的场景 |
| prd-impl | 实现流程 | 已有 PRD，需要大团队式实现 |
| **mattpocock-dev** | **链条式全流程** | **需要高完成度交付的场景** |

### 模型选择策略

| 节点 | 推荐模型 | 理由 |
|------|---------|------|
| host-audit | pro（sonnet 级） | 扫描任务，不需要最强推理 |
| grill | pro-max（opus 级） | 决策质量要求高 |
| spec | pro-max | 综合能力要求高 |
| tickets | pro-max | 切片质量决定下游成败 |
| ticket-impl | pro（机械性任务）/ pro-max（集成任务） | 按 ticket 复杂度动态选择 |
| code-review（两轴） | pro-max | 审查质量要求高 |
| ship | pro | 机械性操作 |

### 关键风险

1. **Ticket 粒度不当** — 太大则回到老问题，太小则 ticket 数量爆炸。需要 tickets 节点有自检逻辑。
2. **Loop context 泄漏** — 需验证 `context: new` 在 loop 迭代间确实隔离。
3. **TDD 循环超时** — 单个 ticket 的 RED→GREEN 循环可能因反复失败而超时。需设合理 timeout + 失败上报。
4. **auto_answers 决策质量** — 无人值守时 AI 自选推荐答案，可能做出用户不同意的决策。需在 spec 中记录所有自动决策供人工审查。
