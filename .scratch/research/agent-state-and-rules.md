# Agent 状态管理与 Claude Rules 系统调研报告

> 调研日期: 2026-08-04
> 调研范围: Agent 状态管理最佳实践、Claude Code Rules 系统、Claude Agent SDK、Octopus 现状分析

---

## 目录

1. [Agent 状态管理最佳实践](#1-agent-状态管理最佳实践)
2. [Claude Rules 系统分析](#2-claude-rules-系统分析)
3. [Octopus 当前实现分析](#3-octopus-当前实现分析)
4. [对 Octopus 的建议](#4-对-octopus-的建议)
5. [引用来源](#5-引用来源)

---

## 1. Agent 状态管理最佳实践

> 主要来源: [ai-agent-book/chapter2.md](https://github.com/bojieli/ai-agent-book/blob/main/book/chapter2.md)

### 1.1 核心问题: Agent 的状态盲区

Agent 在执行复杂任务时存在"状态盲区"——无法自然地追踪工具被调用了多少次、约束是否被违反、距离原始目标还有多远。根本原因是上下文窗口是一个**"缺少摘要层的检索引擎"**——它擅长定位特定事实，但无法自动聚合、计数或提炼散布在数千 token 中的隐式状态。

### 1.2 Agent 状态栏 (Agent Status Bar)

#### 概念

Agent 状态栏是一种机制，Agent Harness 在**每一轮对话的末尾注入结构化元信息**。类比是手机的状态栏——它不占主屏幕，但一眼就能看到电量、时间和信号。

> System prompt 是入职时发放的员工手册；状态栏是贴在屏幕边缘的实时仪表盘。

#### 理论基础

**理论 1 — 上下文学习是检索，不是推理。** 注意力机制擅长"查找"特定 token，但难以在一次前向传播中完成聚合（如计数）。没有状态栏时，模型必须消耗思考 token 来重新扫描整个轨迹。有了状态栏，预计算的结论变为直接可检索的知识。

**理论 2 — 通过近因性操纵注意力。** 将结构化元信息放在上下文的最末端，它在空间上最接近正在生成的 token，获得最高的注意力权重。

#### 注入方式

状态栏以 **`user` 角色消息追加到消息列表末尾**——不修改 system prompt（这会破坏 KV Cache）：

```
messages: [
  { role: "system",    content: "You are a customer service assistant..." }  // 固定前缀
  { role: "user",      content: "Help me cancel my Xfinity plan" }
  { role: "assistant", content: null, tool_calls: [...] }
  { role: "tool",      content: "Call log..." }
  ...
  { role: "user",      content: "<agent_status>
      Current State:
      - phone_call invoked 3 times (Xfinity: 3/3 max)
      - Current time: 2025-09-14 10:30:45
      - TODO: [1] Cancel plan (in_progress)
    </agent_status>" }
]
```

这里的 `user` 角色是**协议级的槽位借用**——内容是框架生成的，而非终端用户输入的。

### 1.3 五种状态栏技术

| 技术 | 功能 | 效果 |
|---|---|---|
| **时间戳追踪** | 在 user 消息和 tool 响应前加 `[2025-09-14 10:30:45]` | 启用时间推理；不放在 system prompt 中以保护 KV Cache |
| **工具调用计数器** | 维护全局调用计数，标注 `"Tool call #3 for 'read_file'"` | 触发模式识别：第1次失败→检查路径，第2次→列目录，第3次→放弃并找替代方案 |
| **TODO 列表管理** | 使用专用 `rewrite_todo_list` 和 `update_todo_status` 工具 | 外化记忆；有 TODO 的 agent 平均 15 轮 vs 无 TODO 的 21 轮 |
| **详细错误消息** | 四层：错误类型/描述、完整参数 JSON、堆栈跟踪、定向修复建议 | 找到替代方案的成功率从 60% 跃升至 95% |
| **系统状态感知** | 注入当前时间、工作目录、OS 类型、shell 环境、Python 版本 | 启用平台感知决策（Linux 用 `apt`，macOS 用 `brew`） |

这些技术组合使用时会产生**涌现效应**——时间戳 + 计数器 → 频率感知；TODO + 系统状态 → 环境自适应策略。

### 1.4 关键轮次 Prompt 补充的三条核心规则

#### 规则 1: 用代码维护状态栏，不要用 LLM

一个 20 行的正则函数就能达到"基准真相"准确率。让前沿 LLM 批量摘要整个历史反而会把准确率拖到没有状态栏的水平以下。如果必须用 LLM，逐条提取后用代码聚合——绝不要一次性批量统计。

#### 规则 2: 删除原始上下文前，确认状态栏覆盖了所有将被问到的问题

状态栏是有损投影。如果问题落在其维度之外，准确率会灾难性崩溃（一项测试中 Claude 从 100% 跌到 7.6%）。添加新查询维度应像**修改数据库 schema** 一样对待——要么先添加字段，要么同时保留原始上下文。

#### 规则 3: 将状态栏准确率视为一线生产指标

模型几乎无条件信任状态栏——如果它说"3 次调用"，模型就假定是 3 次而不独立验证。错误直接传播到最终答案。容差大约 ±10%；超出这个范围，错误的状态栏比没有更糟。

### 1.5 状态更新策略与 KV Cache 权衡

两种实现方式，有明确的缓存成本：

#### 实现 1: 逐轮替换
删除上一条状态消息，在末尾追加最新的。确保只有一份状态副本，始终是最新的。**代价**：删除旧状态会使从该点开始的缓存失效——与"动态时间戳"反模式相同的失败机制，虽然仅限于上下文尾部而非整个前缀。

#### 实现 2: 持久追加
状态消息在轨迹中永久累积；每轮在末尾追加新的。**完全缓存友好**——所有消息只追加，前缀保持稳定。**代价**：过时的状态累积，消耗 token 并要求模型关注最新条目而忽略过时的。

**经验法则**：频繁更新 + 长轨迹 → 实现 2。短轨迹或大型单条状态消息 → 实现 1。

### 1.6 长期运行 Agent 的时间感知

超越基本计数器，长期运行的 agent 需要**物理时间感知**——根据实际经过的时间调节节奏的能力：

| 轴 | 维度 | 含义 |
|---|---|---|
| **紧迫感** | 预算轴 | 匹配工作量与时钟：紧迫截止日期→果断交付；充裕时间→深入挖掘、更多验证 |
| **持久性** | 终止轴 | 区分真墙和假墙；知道工作是否真正完成 |
| **警觉性** | 监控轴 | 上报工具响应中的时间异常（500ms 的调用花了 5 秒；1ms 的"成功"但 body 为空） |

**关键发现**：单独的读数不会改变行为。原始时间戳本身几乎没有改善（2-3 个百分点）。真正将通过率从 ~10% 提升到 40-60% 的是**操作手册**——关于*如何处理*读数的指令。

> 模型不缺读数；缺的是如何使用它们的策略。

### 1.7 上下文压缩作为状态管理

#### 为什么压缩

1. **长度/成本约束** — 工具结果可能数万字符；几轮就能耗尽 128K 窗口
2. **思维质量** — 即使窗口够大，摘要化的知识比原始形式更可用。**上下文腐烂**：窗口没满但 agent 找不到关键信息或重新争论已解决的问题

#### 六种压缩策略

| 策略 | Token 使用 | 压缩率 | 关键特征 |
|---|---|---|---|
| 无压缩 | ~165K 溢出 | N/A | 失败——7 次工具调用耗尽 128K |
| 独立摘要 | 276,608 | 10.9% | 碎片化信息；页面间冗余 |
| 合并摘要 | 93,449 | 4.3% | 必须截断长输入；丢失尾部信息 |
| **上下文感知** | **40,157** | **3.0%** | 查询意图 + 累积信息引导压缩 |
| 上下文感知 + 引用 | 222,992 | 4.1% | 添加源 URL 用于验证 |
| 自适应窗口 | 174,601 | — | 阈值触发（80% 容量），批量压缩 |

**上下文感知**策略成功是因为它识别到不同任务阶段需要不同的信息密度：早期→广泛收集，中期→精确验证，后期→综合。

### 1.8 隔离优于压缩：子 Agent 上下文隔离

更激进的方案：**防止大型中间内容进入主上下文**。主 agent 将产生大量中间输出的任务（文件读取、广泛代码搜索）委托给独立子 agent；子 agent 在自己的上下文中完成探索，只返回几百 token 的结论。

> 压缩是有损的事后补救，需要额外的 LLM 调用；隔离从一开始就确保噪声与主上下文绝缘，主 agent 的 KV Cache 前缀完全不受影响。

代价：子 agent 没有主 agent 的完整上下文，任务描述必须是自包含和目标特定的。

---

## 2. Claude Rules 系统分析

### 2.1 Claude Code 的 Rules 系统

> 来源: [Claude Code Memory 文档](https://code.claude.com/docs/en/memory), [paddo.dev 分析](https://paddo.dev/blog/claude-rules-path-specific-native/), [Piebald-AI/claude-code-system-prompts](https://github.com/Piebald-AI/claude-code-system-prompts)

#### 2.1.1 CLAUDE.md 层级

Claude Code 的记忆系统分为多个层级：

| 层级 | 路径 | 作用域 |
|---|---|---|
| **用户级** | `~/.claude/CLAUDE.md` | 跨所有项目的全局偏好 |
| **项目级** | `<project>/CLAUDE.md` | 项目特定的编码规范和架构决策 |
| **目录级** | `<project>/path/to/CLAUDE.md` | 子目录/模块级别的规范 |
| **自动记忆** | `~/.claude/projects/<hash>/` | Claude 自动生成的跨会话记忆 |

#### 2.1.2 `.claude/rules/` 目录

从 Claude Code v2.0.64 起引入的规则目录系统：

- 在 `.claude/rules/` 目录下存放标准 Markdown 文件
- 通过 **frontmatter** 指定文件路径匹配规则：`paths: "src/**/*.ts"`
- 没有 `paths` 指令时，规则全局适用
- 可用 `/memory` 命令查看当前激活的规则

**示例规则文件**：

```markdown
---
paths: "src/api/**/*.ts"
description: "API route handler conventions"
---

- Use Zod for request validation
- Return typed responses with proper status codes
- Log all errors with structured metadata
```

#### 2.1.3 与 Cursor 规则系统的对比

| 特性 | Claude Code | Cursor |
|---|---|---|
| **规则类型** | 无显式分类 | Always / Auto Attached / Agent Requested |
| **文件扩展名** | `.md` | `.mdc` |
| **路径匹配** | frontmatter `paths:` | frontmatter `globs:` |
| **alwaysApply** | 无此开关（缺省即全局） | 显式 `alwaysApply: true/false` |
| **Agent 自主选择** | 不支持 | "Agent Requested" 类型 |
| **聊天生成规则** | 不支持 | 支持 |

**关键差异**：Claude Code 没有 Cursor 的"Agent Requested"规则类型——即让模型自主决定是否激活某条规则。这在 Claude Code 社区是一个活跃的讨论话题（[GitHub Issue #8395](https://github.com/anthropics/claude-code/issues/8395)，已被关闭为"not planned"）。

#### 2.1.4 Claude Code 内部系统提示架构

根据 [Piebald-AI/claude-code-system-prompts](https://github.com/Piebald-AI/claude-code-system-prompts) 的分析（Claude Code v2.1.221），Claude Code 内部有 **515 个独立的提示字符串**，以模块化、可组合的片段形式组织：

- **条件装配**：不使用单一静态字符串，而是"根据环境和配置有条件地添加大量内容"
- **插值**：包含"内置工具名称引用、可用子 agent 列表和各种上下文特定变量"
- **记忆系统**：多层知识管理，包括私有记忆、团队记忆、项目记忆、反馈记忆和组合记忆索引
- **Dream 记忆整合**：多阶段记忆维护——"定位现有记忆、从日志和转录中收集近期信号、合并更新到主题文件、修剪索引"

### 2.2 Claude Agent SDK 的 Rules 支持

> 来源: [Promptfoo Claude Agent SDK 文档](https://www.promptfoo.dev/docs/providers/claude-agent-sdk/), [Claude Agent SDK Modifying System Prompts](https://code.claude.com/docs/en/agent-sdk/modifying-system-prompts)

#### 2.2.1 系统提示配置

Agent SDK 提供三种系统提示配置方式：

| 方式 | 说明 |
|---|---|
| **默认** | 使用 Claude Code 系统提示 |
| **`custom_system_prompt`** | 完全替换系统提示 |
| **`append_system_prompt`** | 在默认系统提示后追加指令 |

关键特性：
- `exclude_dynamic_sections: true` 剥离每用户上下文（工作目录、git 状态），使缓存前缀在高流量 eval 中保持静态
- SDK **将 rules 内容注入对话中，而非系统提示**，因此它们适用于任何系统提示配置

#### 2.2.2 知识/经验注入机制

| 机制 | 说明 | 适用场景 |
|---|---|---|
| **`setting_sources`** | 启用 `"user"`, `"project"`, `"local"` 来加载 CLAUDE.md 文件和 slash commands | 复用现有项目知识 |
| **Plugins** | 自包含目录，捆绑命名空间技能 | 打包经验库为可分发单元 |
| **Skills** | `.claude/skills/` 下的 SKILL.md 文件，通过 frontmatter 描述自动发现 | 按任务类型自动激活经验 |
| **`append_system_prompt`** | 直接追加指令文本 | 动态注入运行时经验 |

#### 2.2.3 权限模式

六种权限模式控制 agent 行为：`default`、`plan`、`acceptEdits`、`bypassPermissions`、`dontAsk`、`auto`（使用分类器批准/拒绝）。

#### 2.2.4 关于"经验库"场景

Agent SDK **没有专门的"经验库" API**。最接近的等价物是：

1. **Skills 系统**：将经验打包为 SKILL.md 文件，按描述自动发现和激活
2. **Plugins 系统**：将多个 skills 捆绑为可分发的插件目录
3. **`append_system_prompt`**：运行时动态注入经验文本
4. **`setting_sources: ["project"]`**：让 SDK 自动读取项目的 CLAUDE.md

官方推荐做法是将经验组织为 **Skills**——每个经验是一个 SKILL.md 文件，包含 frontmatter 描述，让 SDK 在匹配任务时自动激活。

### 2.3 社区需求与现状

[GitHub Issue #8395](https://github.com/anthropics/claude-code/issues/8395) 提出了用户级 Agent 规则传播的需求：

- 请求 `~/.claude/primary-agent-rules.md` 和 `~/.claude/agent-rules.md` 文件
- 请求子 agent 规则继承机制
- 请求 `settings.json` 中的 `agentRules` 配置

**结果**：被关闭为"not planned"。这表明 Claude Code 目前没有跨 agent 规则传播的路线图。

---

## 3. Octopus 当前实现分析

### 3.1 知识注入系统架构

Octopus 的知识注入系统由以下组件组成：

```
packages/server/src/services/knowledge/
├── index.ts          ← KnowledgeService 编排器
├── precompute.ts     ← 预计算 hook（执行前填充 VarPool）
├── extract.ts        ← LLM 规则提取 + 冲突检测 + 复现陷阱检测
├── generate.ts       ← 知识文件模板生成
├── file-ops.ts       ← 文件系统操作（CRUD、解析、索引）
├── effectiveness.ts  ← 有效性追踪 + 衰减/退役
├── maintenance.ts    ← 文件压缩 + Clone 合并
├── review.ts         ← 审批工作流（approve/reject/defer/edit）
├── llm.ts            ← Haiku LLM 调用封装
├── validators.ts     ← 文件名验证
└── repo-resolver.ts  ← 仓库名称解析

packages/engine/src/
├── knowledge-injector.ts  ← 从 VarPool 读取规则，格式化为 prompt
└── prompt-injector.ts     ← YAML 定义的 global/targeted prompts
```

### 3.2 注入流程

```
[执行前]
  KnowledgeService.createPrecomputeHook()
    → precomputeRelevantRules(org, repos, workflow, inputs, pool)
      → getEffectiveUserPreference() → pool.__user_preference_text
      → listAllActiveRules() → pool.__knowledge_rule_cache
      → pool.__knowledge_rule_meta (ruleId → {fileName, scope})
      → pool.__knowledge_scope_filter ({repoNames, workflowName})
      → pool.__relevant_rule_ids

[执行中 — buildPrompt()]
  KnowledgeInjector.getInjectedPrompts(workflowName, nodeId)
    → 读取 VarPool 中的预计算数据
    → filterByScope() — global 总是注入, project 匹配 repoName, workflow 匹配 workflowName
    → groupByScope() — 按 global/project/workflow 分组
    → formatGroupedPrompts() — 预算控制 (max 10 rules, max 4000 chars)
    → 输出 string[] 追加到 agent prompt 前面

[执行后]
  trackEffectiveness() — 关键词重叠检测规则是否有帮助
  retireStaleRules() — 低置信度 + 长期未注入的规则标记为 retired
```

### 3.3 三种规则作用域

| 作用域 | 存储路径 | 匹配条件 | 示例 |
|---|---|---|---|
| **Global** | `~/.octopus/knowledge/` | 总是注入 | 编码规范、通用最佳实践 |
| **Project** | `~/.octopus/orgs/<org>/knowledge/projects/<repo>.md` | repoName 匹配 scopeFilter | 项目特定的构建/测试经验 |
| **Workflow** | `~/.octopus/orgs/<org>/knowledge/workflows/<name>.md` | workflowName 精确匹配 | 工作流特定的执行要点 |

### 3.4 规则生命周期

```
[来源] → [提取] → [审查] → [注入] → [追踪] → [衰减/退役]
   │         │        │        │        │         │
   │    LLM/Haiku  pending   prompt  keyword   confidence
   │    启发式回退   review    前注入   重叠检测   < 0.2 且
   │               队列               判定      注入≥3次
   │                                             且30天未用
   └── 6 种来源:
       workspace_archive, agent_conversation,
       clone_merge, system, recurring_pitfall,
       knowledge_pattern, scheduler
```

### 3.5 当前 `.claude/` 结构

Octopus 项目的 `.claude/` 目录没有 `rules/` 子目录，但有丰富的 skills 和 agents 生态：

- `.claude/skills/` — 90+ 个 skill 目录（octo-*, matt-*, 通用 skills）
- `.claude/agents/` — 自定义 agent 定义（devil-advocate, architecture-explorer 等）
- `.claude/settings.local.json` — 本地设置
- `CLAUDE.md` — 根级项目文档

### 3.6 当前经验库的局限性

| 局限 | 说明 |
|---|---|
| **静态注入时机** | 规则仅在 `buildPrompt()` 时一次性注入，执行过程中不会根据上下文变化动态调整 |
| **无关键轮次补充** | 没有 Agent Status Bar 机制，不能在关键轮次（如错误恢复、决策点）补充特定 prompt |
| **预算硬编码** | max 10 rules / max 4000 chars 是硬编码的，不支持按节点/阶段动态调整 |
| **无路径感知** | 不像 Claude Code 的 `.claude/rules/` 支持按文件路径模式匹配规则 |
| **无 Agent 自主选择** | 不支持 Cursor 的"Agent Requested"规则类型——agent 不能自主决定是否需要某条经验 |
| **有效性追踪粗糙** | 基于关键词重叠判定，没有因果推理——一条规则可能恰好与错误文本共享关键词而被误判 |
| **无运行时状态注入** | 不像 Agent Status Bar 那样注入工具调用计数、TODO 列表、系统状态等运行时信息 |
| **压缩仅限规则文件** | 文件压缩 (compact) 是手动触发的 LLM 操作，没有上下文窗口级别的自适应压缩 |
| **无子 Agent 隔离** | 经验库不感知子 agent 与主 agent 的上下文隔离需求 |
| **与 Claude Code 生态脱节** | 不使用 `.claude/rules/` 目录，不生成 CLAUDE.md 兼容格式，无法被 Claude Code 原生读取 |

---

## 4. 对 Octopus 的建议

### 4.1 短期: 引入 Agent Status Bar 概念

**目标**：让长期运行的 agent 节点获得运行时状态感知。

**实现思路**：

1. 在 `AgentExecutor.buildPrompt()` 中增加"状态栏"注入点
2. 从 `VarPool` 和执行上下文中收集运行时状态：
   - 当前节点在工作流中的位置（第 N/M 个节点）
   - 已执行节点的耗时和状态摘要
   - 前序节点的输出摘要（不是完整输出）
   - 当前迭代次数（Loop 节点中）
   - 已用时间 / 预算时间比
3. 将状态栏作为 prompt 的最后一部分注入（利用近因性注意力优势）

```typescript
// 示例状态栏注入
const statusBar = `<agent_status>
  Workflow: ${workflowName} | Node: ${nodeId} (${nodeIndex}/${totalNodes})
  Elapsed: ${elapsed}s / Budget: ${budget}s
  Previous nodes: ${prevNodesSummary}
  Loop iteration: ${iteration} / max: ${maxIterations}
  Failed nodes: ${failedNodesList || "none"}
</agent_status>`
```

### 4.2 中期: 动态规则注入

**目标**：根据执行阶段和节点类型动态调整注入的规则集合和预算。

**实现思路**：

1. **节点类型感知预算**：
   - Agent 节点：标准预算（10 rules / 4000 chars）
   - Loop 节点内 Agent：减少预算，优先注入错误恢复相关规则
   - Condition 节点后的 Agent：注入与条件分支相关的经验
2. **阶段感知注入**：
   - 执行早期：注入广泛的架构/规范规则
   - 执行中期：注入精确的技术规则
   - 错误恢复阶段：注入错误处理和调试经验
3. **实现方式**：`KnowledgeInjector.getInjectedPrompts()` 接受 `NodeContext` 参数

### 4.3 中期: 桥接 Claude Code Rules 生态

**目标**：让 Octopus 经验库与 Claude Code 的 `.claude/rules/` 双向互通。

**实现思路**：

1. **读取 `.claude/rules/`**：当 Octopus 在 Claude Code 项目内运行时，自动读取 `.claude/rules/` 下的规则文件作为额外知识源
2. **导出为 `.claude/rules/` 格式**：让已审批的 Octopus 经验规则可以导出为 Claude Code 兼容的规则文件
3. **统一规则格式**：在 Octopus 规则文件中支持 frontmatter，使其同时被 Claude Code 和 Octopus 识别

```markdown
---
scope: project
target: octopus
octopus_id: octopus-20260804-a1b2
---
- Always use Zod schemas for input validation in API routes
<!-- id:octopus-20260804-a1b2 | 2026-08-04 | workspace_archive -->
```

### 4.4 长期: 子 Agent 上下文隔离

**目标**：对 Swarm/Dynamic 编排模式中的子 agent 实现上下文隔离。

**实现思路**：

1. 主 agent 的经验库注入保持在主上下文中
2. 子 agent 只接收与其任务相关的规则子集（通过 `scopeFilter` 精确过滤）
3. 子 agent 完成后，只将结论（而非完整执行轨迹）返回主上下文
4. 这与 Agent Status Bar 的"用代码维护状态"原则一致——子 agent 的结论是代码提取的结构化数据

### 4.5 长期: 关键轮次 Prompt 补充

**目标**：在 Agent 执行的关键转折点动态补充特定 prompt。

**实现思路**：

1. **错误恢复点**：当 agent 节点失败重试时，注入"错误处理经验"和"替代方案建议"
2. **决策点**：当 Condition 节点产生分支时，注入与该分支相关的经验
3. **循环检测**：当 Loop 节点检测到重复模式时，注入"打破循环"的策略
4. **实现机制**：
   - 在 `ExecutionLifecycle` 中注册关键轮次回调
   - 回调根据执行状态选择性地补充 prompt
   - 补充内容通过 VarPool 传递给下一轮 `buildPrompt()`

### 4.6 优先级排序

| 优先级 | 建议 | 复杂度 | 价值 |
|---|---|---|---|
| **P0** | Agent Status Bar 注入 | 低 | 高——立即改善长工作流中 agent 的状态感知 |
| **P1** | 桥接 Claude Code Rules | 中 | 高——打通 Claude Code 生态，复用已有规则 |
| **P1** | 动态规则注入预算 | 中 | 高——减少 token 浪费，提高规则相关性 |
| **P2** | 关键轮次 Prompt 补充 | 高 | 高——解决"状态盲区"的核心问题 |
| **P3** | 子 Agent 上下文隔离 | 高 | 中——Swarm 场景显著改善，但实现复杂 |

---

## 5. 引用来源

### Agent 状态管理

1. [ai-agent-book/chapter2.md](https://github.com/bojieli/ai-agent-book/blob/main/book/chapter2.md) — Agent 状态栏、上下文压缩、子 Agent 隔离等概念的系统性论述

### Claude Code Rules

2. [Claude Code Memory 文档](https://code.claude.com/docs/en/memory) — CLAUDE.md 层级、.claude/rules/ 目录、自动记忆机制（注：访问时遇到连接问题，信息来自搜索引擎摘要和第三方引用）
3. [Claude Code Gets Path-Specific Rules](https://paddo.dev/blog/claude-rules-path-specific-native/) — Claude Code v2.0.64 路径特定规则分析，与 Cursor 规则系统对比
4. [Piebald-AI/claude-code-system-prompts](https://github.com/Piebald-AI/claude-code-system-prompts) — Claude Code v2.1.221 全部 515 个系统提示字符串的逆向工程分析
5. [Complete Guide to CLAUDE.md and AGENTS.md 2026](https://medium.com/data-science-collective/the-complete-guide-to-ai-agent-memory-files-claude-md-agents-md-and-beyond-49ea0df5c5a9) — AI Agent 记忆文件完整指南
6. [Context Tiering for Claude Code](https://medium.com/@sohit_kumar/context-tiering-for-claude-code-the-claude-md-setup-that-survives-long-sessions-82f058736731) — 长会话的 CLAUDE.md 分层策略

### Claude Agent SDK

7. [Claude Agent SDK — Promptfoo](https://www.promptfoo.dev/docs/providers/claude-agent-sdk/) — Agent SDK 配置、权限模式、setting_sources、Skills 系统
8. [Modifying System Prompts — Claude Code Docs](https://code.claude.com/docs/en/agent-sdk/modifying-system-prompts) — SDK 系统提示修改方式（注：访问时遇到连接问题）
9. [GitHub Issue #8395: User-Level Agent Rules](https://github.com/anthropics/claude-code/issues/8395) — 用户级规则传播请求（已关闭为 not planned）

### Octopus 代码库

10. `packages/engine/src/knowledge-injector.ts` — KnowledgeInjector 实现
11. `packages/engine/src/prompt-injector.ts` — PromptInjector 实现
12. `packages/engine/src/executors/agent.ts` — AgentExecutor.buildPrompt() 注入流程
13. `packages/server/src/services/knowledge/` — 知识服务完整实现（index.ts, precompute.ts, extract.ts, file-ops.ts, effectiveness.ts, maintenance.ts, review.ts）
