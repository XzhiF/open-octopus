# Octopus 战略级设计方向

> **日期**: 2026-06-08
> **类型**: 产品架构与战略方向分析
> **范围**: 全代码库深度审计 + 竞品对标 + 设计哲学
> **配套文档**: `competitive-landscape-2026.md`（竞品分析）、`agent-observability.md`（可观测性规格书）

---

## 执行摘要

本报告基于对 Octopus 全部 7 个包（约 150+ 源文件、200+ 测试用例）的逐文件审计，结合 Temporal、n8n、Mastra、Windmill 等行业标杆的对比分析，聚焦于 5 个战略级设计方向，为 Octopus 从"好用的工作流工具"演进为"不可替代的 AI 工程平台"提供架构决策依据。

核心结论：Octopus 的 Skill 创建流水线 + 工作流引擎组合是真正有差异化的，**没有竞品同时拥有这两者**。五大方向中，**Hybrid Orchestration（混合编排）** 是唯一能重新定义 Octopus 是什么的方向，其他四个在不同维度上扩展能力。

---

## 五大战略方向

### 方向一：从"工具"到"平台"——引入 Execution Graph 作为一等公民

#### 现状的问题

Octopus 现在本质上是一个"跑工作流的工具"。用户写好 YAML → 点运行 → 看结果。数据模型是：

```
Workflow (YAML 定义) → Execution (运行实例) → NodeExecution (节点状态)
```

这是"流水线思维"——线性的、一次性的。

#### 目标模型

工业级产品的模型是：

```
Workflow Definition (版本化)
    → Execution Graph (有向图运行时)
        → Activity (可恢复的原子操作)
            → Event Stream (可追溯的事件流)
```

**核心区别：** Execution Graph 不是执行完就丢掉的日志，而是一个可查询、可回放、可 fork 的活数据结构。

具体能力：
- **可回放（Replay）**：选中某个失败节点，从那个点重新运行，而不是重跑整个工作流。Temporal 的 killer feature。
- **可 fork**：从某个执行的历史节点分叉出一条新执行路径，用于"如果当时参数不一样会怎样"的探索。
- **可组合**：一个工作流的输出可以作为另一个工作流的输入触发——不是手动接线，而是类型化的契约。

#### 需要的中间层

需要一个 Execution Graph 的中间层抽象，它不只是 `node_executions` 表里的状态行，而是一个完整的运行时图结构，支持遍历、查询、操作。

---

### 方向二：从"YAML 执行器"到"Workflow DSL"——双层语言策略

#### 现状的问题

YAML schema 功能已经很强（6 种执行器、变量池、表达式、循环、条件），但它是配置式的——在描述"要什么"，但没有能力描述"怎么组合"。当工作流变复杂时，YAML 会变得极其冗长和不可维护。

对比 Mastra 的做法——函数式组合，可以抽象、复用、类型检查：

```typescript
const analyzeAndFix = createStep({
  id: 'analyze-and-fix',
  run: async ({ context }) => {
    const issues = await analyze(context.code)
    const fixes = await fixIssues(issues)
    return { fixes }
  }
})

const workflow = createWorkflow({ id: 'code-review' })
  .then(analyzeAndFix)
  .parallel([runTests, lintCheck])
  .then(generateReport)
```

#### 双层 DSL 策略

**不要放弃 YAML**——它的声明式、人类可读、Git 友好是巨大优势。但在此之上，增加一个 TypeScript Workflow SDK：

```
层级 1: YAML（声明式，面向配置）
  └─ 适合：简单的线性流水线、CI/CD 配置、非开发者使用

层级 2: TypeScript SDK（编程式，面向组合）
  └─ 适合：复杂编排、自定义逻辑、跨工作流复用、类型安全
```

SDK 不是替代 YAML，而是编译到 YAML（或直接构建 Execution Graph）。这样：
- 简单场景继续用 YAML
- 复杂场景用 TypeScript 写，获得类型检查、IDE 补全、可测试性
- 两者可以互操作：SDK 生成的工作流可以在 Web UI 中可视化，YAML 工作流可以导出为 SDK 代码

**这解决了 Mastra 的函数式组合优势，同时保留 YAML 差异点。**

---

### 方向三：从"单机运行"到"Hub-and-Spoke"——重新思考部署模型

#### 现状的问题

单进程架构：一个 Node.js server 跑所有引擎、所有工作流、所有 SSE。SQLite 是单写者。不能水平扩展，一台机器挂了全挂，不适合团队共享。

#### Hub-and-Spoke 架构

不要走传统的"加 Postgres + Redis + 消息队列"的重型路线。而是考虑：

```
                    ┌─ Octopus Hub (轻量协调) ─┐
                    │  - 工作流注册表           │
                    │  - 执行调度               │
                    │  - 全局状态聚合           │
                    └──────────┬───────────────┘
                               │
              ┌────────────────┼────────────────┐
              │                │                │
     ┌────────▼──────┐ ┌──────▼───────┐ ┌──────▼───────┐
     │ Octopus Edge 1 │ │ Octopus Edge 2│ │ Octopus Edge 3│
     │ (本地开发者)    │ │ (CI Runner)   │ │ (远程 Server) │
     │ 本地 SQLite    │ │ 临时环境      │ │ 持久化运行    │
     └───────────────┘ └──────────────┘ └──────────────┘
```

**Edge 节点**就是现在的 Octopus server，增加了：
- 向 Hub 注册自己的能力（可用的执行器、资源限制）
- 接收 Hub 分配的工作流执行任务
- 将执行事件上报给 Hub

**Hub 是轻量的**——它不执行工作流，只做调度和聚合。

**为什么这个方向重要：**
- 保留"本地运行、数据不离开本机"的核心价值
- 增加团队协作和 CI/CD 场景的能力
- Edge 节点可以独立运行（Hub 不可用时降级为单机模式）
- 这是 Cloudflare Workers、Vercel Edge Functions 验证过的架构模式

---

### 方向四：从"执行引擎"到"Agent Orchestration Fabric"

#### 现状的问题

`AgentExecutor` 把 AI agent 当作一种"节点类型"——跟 bash、python 并列。这是 2024 年的思维。2026 年的现实是：**Agent 不是工作流中的一个步骤，Agent 是工作流的主体。**

看 Claude Code 的 Agent Teams、Cursor 的 Subagent、AutoGen 的 Group Chat——趋势是 Agent 自主决定调用什么工具、走什么路径，而不是被 YAML 预定义。

#### Hybrid Orchestration 模型

```
模式 A: 确定性工作流 (现有的 YAML 引擎)
  └─ 步骤已知、顺序固定、人类定义流程
  └─ 适用：CI/CD、部署、标准化流程

模式 B: Agent 主导工作流 (新增)
  └─ 目标已知、路径未知、Agent 自主规划
  └─ 适用：代码审查、Bug 修复、研究分析

模式 C: 混合模式 (最有价值的)
  └─ 人类定义骨架 + Agent 填充细节
  └─ 适用：复杂工程任务
```

**模式 C 的 YAML 示例：**

```yaml
nodes:
  - id: gather-context
    type: agent
    goal: "收集与 issue #42 相关的所有上下文"
    # Agent 自主决定：读哪些文件、查哪些 PR、问哪些人
    
  - id: propose-solution
    type: agent  
    goal: "基于上下文，提出修复方案"
    constraints:
      - "不能修改 public API"
      - "必须保持向后兼容"
    # Agent 自主规划步骤，但受约束
    
  - id: human-review
    type: approval
    # 人类审批 Agent 的方案
    
  - id: implement
    type: agent
    goal: "按批准的方案实施修改"
    # Agent 执行，但人类已审批了方向
```

**核心设计变化：**
- `type: agent` 节点不再需要预定义 `prompt`——只需要 `goal` + `constraints`
- Agent 有自己的 planning loop（think → plan → act → verify），而不是单次 LLM 调用
- 引擎的角色从"按顺序执行步骤"变成"为 Agent 提供上下文、约束和反馈"

**这才是竞品报告中指出的 Octopus 应该占据的"AI-Native DevOps"象限的真正含义。**

---

### 方向五：从"Skill 文件"到"Skill Registry"——生态层设计

#### 现状的问题

Skill 方案（SKILL.md + 5 步创建 + 6 点验证 + 经验积累）是最大的差异化优势。但 Skill 的分发和发现是原始级别的——文件系统 + Git。没有版本管理、没有依赖解析、没有能力市场。

#### Skill as Package

借鉴 npm/cargo 的包管理思想，但保持 Git-native：

```
层级 1: Skill 文件 (现状)
  └─ 单个 SKILL.md + 辅助文件

层级 2: Skill Package (新增)
  └─ skill.json (元数据、版本、依赖声明)
  └─ SKILL.md (主文件)
  └─ tests/ (Skill 的验证测试)
  └─ examples/ (使用示例)

层级 3: Skill Registry (新增)
  └─ 组织级 Skill 注册表 (Git repo)
  └─ 版本索引、依赖图、使用统计
  └─ `octopus skill install @org/skill-name@^2.0`
  └─ `octopus skill publish`
```

**关键设计决策：**
- **Registry 是一个 Git repo**（不是 SaaS），可以是 `~/.octopus/{org}/registry/`
- **版本用 semver**，与 Git tag 对应
- **依赖解析**：Skill A 可以声明依赖 Skill B，安装时自动解析
- **能力签名**：每个 Skill 声明它的输入/输出类型，用于工作流中的自动组合

**这让 Skill 方案从"个人效率工具"升级为"团队能力资产"。**

---

## 五大方向的优先级矩阵

| 方向 | 影响力 | 实施难度 | 建议时机 |
|------|--------|---------|---------|
| **Hybrid Orchestration（Agent 主导 + 确定性混合）** | 颠覆级 | 高 | 现在就开始设计 |
| **Execution Graph 一等公民** | 极高 | 中高 | 下一轮重构时 |
| **Workflow DSL（TypeScript SDK）** | 高 | 中 | 核心稳定后 |
| **Skill Registry** | 高 | 中 | 团队扩展时 |
| **Hub-and-Spoke 部署** | 高 | 高 | 用户增长后 |

**如果只做一件事：把 Hybrid Orchestration 的模型设计清楚。** 因为这是唯一能让 Octopus 从"好用的工作流工具"变成"不可替代的 AI 工程平台"的方向。其他四个都是在不同维度上扩展能力，但 Hybrid Orchestration 重新定义了 Octopus 是什么。

---

## 做对了什么（不要改）

1. **Skill 创建流水线** — 5 步流程 + 4 项按需查询是真正独特的，领先于 Anthropic Skills
2. **多实例开发隔离** — Git worktree + hash 端口 + 独立 DB，优秀的工程
3. **YAML 工作流定义** — 声明式、可版本控制、人类可读——比大多数纯可视化工具更好
4. **VarPool + 表达式引擎** — 干净、经过充分测试、fork/merge 语义正确
5. **可观测性规格书** — 1,790 行的 agent 可观测性规格书是企业级架构，只需要实现
6. **隐私过滤器** — 12 种密钥脱敏模式，比大多数商业产品更彻底
7. **测试覆盖** — engine/server/shared 约 200+ 测试，包含真实子进程集成测试

---

## 竞争格局定位

```
              可观测性深度 ▲
                          │
        ★ Octopus (目标)  │
        Workflow-native + │
        Agent-deep +      │
        Optimization      │
                          │
  Langfuse ●    Braintrust ●
  LLM-deep      Eval-first
  but wf-agnostic  but wf-agnostic
                          │
       n8n ●         Zapier ●
       Workflow-native  Workflow-native
       but agent-shallow  but agent-shallow
                          ├──────────────────────▶ Workflow 理解深度
```

**目标象限右上角目前是空的。** Octopus 的 Skill 系统 + 工作流引擎的组合没有竞品同时拥有。

---

## 方法论

- 逐文件审计了全部 7 个包（shared、providers、cli、engine、server、web-app、core-pack）的所有源文件
- 分析了 engine 的 6 种执行器实现、21 个测试文件（约 150+ 测试用例）
- 分析了 server 的 18 个测试文件、所有 API 路由和服务
- 分析了 web-app 的所有页面、组件、hooks、API 客户端
- 交叉引用了项目内部的竞品分析报告（`competitive-landscape-2026.md`）和可观测性规格书（`agent-observability.md`）
- 对标产品：Temporal、n8n、Mastra、Windmill、Prefect、Dagster、Langfuse、Braintrust
