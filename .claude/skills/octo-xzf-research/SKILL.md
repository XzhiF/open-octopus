---
name: octo-xzf-research
description: "Codebase 聚焦研究 — debate 模式下的多专家对抗研究方法论"
category: coding-assistant
tags: [xzf-dev]
version: 2.1.0
---

# Codebase 聚焦研究方法论

## 触发条件
Stage 1 `idea-research` swarm debate 节点，每位专家加载此 skill 参与聚焦研究辩论。

## 输入

- **Idea 文档**: `.octopus/xzf/{feature}/00-init/idea.md`
- **Workspace 拓扑**: `.octopus/xzf/{feature}/00-init/workspace-topology.md`

## 00-init/idea.md 格式

```markdown
# Idea
## 需求描述
{原始需求}

## Research 指引（可选）
### 内部研究重点
{codebase 中需要重点研究的模块/方向}

### 外部调研
{需要调研的外部平台/技术/库，可附 URL}
```

## 辩论方法论

本 skill 运行在 **debate 模式**下，专家通过多轮辩论达成共识。核心原则：

### 1. 聚焦 Idea，不写通用概览
- 只研究与这个 Idea **直接相关**的内容
- 引用具体源码文件和行号作为证据
- 不说"我们用了 React"，要说"Idea 影响 web-app/src/components/X，它用了 Y 模式"

### 2. 对抗式讨论
- Round 1：发表你的领域观点（哪些模块受影响、现有模式、约束）
- Round 2：读其他专家观点，**挑战不合理的假设**，补充被遗漏的视角
- 例：architect 说"改 X 模块" → 你质疑"X 的 DB schema/API 能支撑这个改动吗？"

### 3. 诚实评估相关性
- 如果你的领域与这个 Idea **无关**，直接说"本领域无重大影响"
- 不要为了发言而硬凑内容

## Research 指引处理

**如有 Research 指引:**
- **内部研究重点** → 优先定位指引中的模块深入分析
- **外部调研** + URL → 使用 WebFetch 读取文档，提取关键信息
- **外部调研** 无 URL → 使用 WebSearch 搜索相关知识

**如无 Research 指引:**
- 根据 Idea 内容自行判断需要研究什么
- 重点关注 Idea 涉及的现有模块

## 外部调研

仅在 Idea 明确涉及外部 API/技术时进行。调研时提取:
- 认证方式
- 核心接口列表（Method + Path + 用途）
- 对本次 Idea 的影响和约束

## 发言格式

每位专家在辩论中的发言结构:

```
## {你的领域} — 对 Idea 的影响

### Affected Modules
- {模块}: {影响类型} — 证据: {具体源码文件和行号}

### Patterns to Reuse
- {pattern}: {在哪里} → {本 Idea 如何复用}

### Constraints & Risks
- {constraint}: {对实现的影响}

### External Knowledge（仅在需要时）
{外部调研结果}

### Challenges（Round 2+）
{对其他专家观点的质疑或补充}
```

⚠️ 发言控制在 **1000 字以内**。聚焦结论和分歧点。

## Codebase 探索策略

使用 Grep/Glob/Read 按需探索源码。先从 workspace-topology.md 了解项目结构，再聚焦 Idea 相关的模块深入分析。引用具体文件路径和行号作为证据。

## 领域知识读写

### 读取（专家研究前）

研究前先读取项目已有的领域知识文件（如有）：

```
{project}/CONTEXT.md           ← 单上下文项目
{project}/CONTEXT-MAP.md       ← 多上下文项目（读 map → 定位相关包的 CONTEXT.md）
{project}/docs/adr/            ← 已有架构决策
```

已有知识覆盖的模块不需要重新探索，聚焦增量。

多项目 workspace：从 workspace-topology.md 获取项目列表，逐个检查上述文件。

### 写入（Host 综合时）

Host 在生成 research-brief.md 后，追加新发现的术语到项目的 CONTEXT.md：

**CONTEXT.md 格式（兼容 domain-modeling）：**

```markdown
# {Context Name}

{一两句话描述这个上下文}

## Language

**Order**:
客户下的购买请求，包含多个 OrderItem。
_Avoid_: Purchase, transaction

**Token**:
JWT 访问令牌，15 分钟过期。
_Avoid_: 凭证, credential
```

**写入规则：**
- 已有术语不重复添加
- 新术语：`**Term**` + 1-2 句定义 + `_Avoid_` 列表
- 只追加，不修改已有内容
- 文件不存在则创建（lazy creation）
- 只收录项目特有的领域概念，通用编程概念（timeout、error）不收录

**CONTEXT-MAP.md 格式（多上下文项目）：**

```markdown
# Context Map

## Contexts
- [Ordering](./src/ordering/CONTEXT.md) — 接收和跟踪客户订单
- [Billing](./src/billing/CONTEXT.md) — 生成发票和处理付款

## Relationships
- **Ordering → Billing**: Ordering 发出 OrderPlaced 事件，Billing 消费生成发票
```

如果项目用 CONTEXT-MAP.md，新术语写入对应包的 CONTEXT.md。如涉及跨包关系变更，追加到 CONTEXT-MAP.md 的 Relationships。

**多项目 workspace 写入：**
- 根据 Affected Modules 定位所属项目
- 写入该项目的 CONTEXT.md
- 如涉及跨项目关系 → 在 research-brief.md 的 Open Questions 中标注

## Host 综合输出

Host 读取所有轮次讨论，综合为 `research-brief.md`:

```markdown
# Research Brief

## Affected Modules
| 模块/包 | 影响类型 | 现有代码定位 | 证据 |
|---------|---------|-------------|------|

## Existing Patterns to Reuse
- {pattern}: {在哪里} → {本 Idea 如何复用}

## Constraints & Risks
- {constraint}: {原因} → {对实现的影响}

## External Knowledge
{仅在涉及外部技术时有此节}

## Open Questions
{专家间仍有分歧的点，需在澄清阶段确认}
```

⚠️ 只保留有共识的结论。标注仍有分歧的点为 Open Questions。
