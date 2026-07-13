# mattpocock/skills — AI Agent 工程纪律框架分析

> **项目地址**: https://github.com/mattpocock/skills
> **作者**: Matt Pocock（TypeScript 圈知名教育者）
> **分析日期**: 2026-07-13
> **许可**: MIT

---

## 项目定位

AI agent 工程纪律框架。核心信念：**AI coding 最大的问题不是代码生成能力，而是沟通、架构和质量控制的失败。**

不是 vibe coding 工具。是**反 vibe coding**。

**技术栈**: Shell (77.2%) + JavaScript (22.8%)，模型无关。

---

## 目录结构

```
skills/
├── engineering/          ← 日常编码纪律
│   ├── ask-matt/         ← 路由器，问"哪个 skill 适合我"
│   ├── code-review/      ← 双轴审查（标准 + 规格）
│   ├── codebase-design/  ← 深模块设计词汇
│   ├── diagnosing-bugs/  ← 六阶段 debug 纪律
│   ├── domain-modeling/  ← 领域建模 + CONTEXT.md
│   ├── grill-with-docs/  ← 带文档的拷问
│   ├── implement/        ← 按 spec 实现
│   ├── improve-codebase-architecture/  ← 架构扫描 + HTML 报告
│   ├── prototype/        ← 抛原型回答设计问题
│   ├── research/         ← 后台 agent 做调研
│   ├── resolving-merge-conflicts/
│   ├── setup-matt-pocock-skills/  ← 一次性配置
│   ├── tdd/              ← 红绿循环
│   ├── to-spec/          ← 对话 → spec 文档
│   ├── to-tickets/       ← spec → 拆分 tickets
│   ├── triage/           ← issue 状态机
│   └── wayfinder/        ← 超大任务的迷雾地图
├── productivity/         ← 非编码工作流
│   ├── grill-me/         ← 拷问入口
│   ├── grilling/         ← 无情拷问引擎
│   ├── handoff/          ← 会话交接文档
│   ├── teach/            ← 交互教学
│   └── writing-great-skills/  ← 元技能：怎么写好 skill
├── deprecated/
├── in-progress/
├── misc/
└── personal/
```

---

## 核心设计：调用层级

```
User-invoked（人手动触发，slash command）
    ↓ 可以调用
Model-invoked（AI 自动触发，或人手动）
    ↓ 不能调用
User-invoked（禁止！）
```

规则：**user-invoked 可以调 model-invoked，反之不行。** 避免 AI 自己启动编排层 skill。

Skill 通过 `disable-model-invocation: true` 标记为仅用户触发。

---

## 核心 Skill 详解

### 1. `grilling` — 无情拷问

最短但最核心的 skill。全文：

> 无情拷问我计划的每个方面。逐个走设计树分支，一个一个解决决策依赖。每个问题给推荐答案。**一次只问一个问题。** 能从代码查到的事实不要问我。**决策是我的。** 我确认达成共识前不要执行。

为什么好：大部分 AI coding 失败是因为**需求没搞清就开始写代码**。grilling 强制对齐。

### 2. `codebase-design` — 深模块词汇表

定义了 7 个精确术语：

| 术语 | 定义 |
|------|------|
| **Module** | 有接口有实现的任何东西，故意 scale-agnostic |
| **Interface** | 调用者正确使用模块需要知道的一切（不只类型签名） |
| **Implementation** | 模块内部代码 |
| **Depth** | 接口背后的杠杆：少量接口控制大量行为 |
| **Seam** | 可以改变行为而不需要编辑的地方（Feathers 定义） |
| **Adapter** | 在 seam 处满足 interface 的具体实现 |
| **Leverage/Locality** | 深模块给调用者和维护者的收益 |

核心原则：
- **删除测试**：想象删掉模块，复杂度消失 = 模块是 pass-through；复杂度扩散到 N 个调用者 = 模块有价值
- **接口就是测试表面**：调用者和测试走同一个 seam
- **一个 adapter = 假设的 seam；两个 adapter = 真的 seam**

### 3. `diagnosing-bugs` — 六阶段 debug

```
Phase 1: 建反馈循环（这是核心技能！）
Phase 2: 复现 + 最小化
Phase 3: 生成 3-5 个假设（先列出来再测）
Phase 4: 针对性埋点（一次改一个变量）
Phase 5: 修复 + 回归测试
Phase 6: 清理 + 事后分析
```

Phase 1 最关键：**如果你有一个紧致的 pass/fail 信号，你就能找到 bug。** 没信号，看再多代码也没用。给了 10 种构建反馈循环的方法，按优先级排序：

1. Failing test
2. Curl / HTTP 脚本
3. CLI 调用 + snapshot diff
4. Headless browser（Playwright/Puppeteer）
5. 重放捕获的 trace
6. Throwaway harness
7. Property / fuzz 循环
8. Bisection harness
9. Differential loop
10. HITL bash 脚本（最后手段）

### 4. `code-review` — 双轴审查

两个子 agent **并行**跑：

| 轴 | 问题 | 基准 |
|----|------|------|
| **Standards** | 代码符合项目的编码标准吗？ | 项目标准 + Fowler 代码气味基线 |
| **Spec** | 代码实现了 spec 要求的东西吗？ | issue/PRD 原文 |

为什么不合并：代码可以 Standards pass + Spec fail（写得很干净但做错了东西），或 Spec pass + Standards fail（做了对的事但破坏了约定）。合在一起会互相掩盖。

Standards 轴内置的 Fowler 代码气味基线（即使项目没有编码标准也适用）：
- Mysterious Name、Duplicated Code、Feature Envy、Data Clumps
- Primitive Obsession、Repeated Switches、Shotgun Surgery
- Divergent Change、Speculative Generality、Message Chains
- Middle Man、Refused Bequest

### 5. `wayfinder` — 迷雾地图

解决**超过一个 agent session 能装下的大任务**。核心概念：

- **Destination**：终点是什么（spec/决策/变更）
- **Map**：issue tracker 上的一个 map issue
- **Tickets**：map 的子 issue，每个是一个决策
- **Frontier**：已知的边界——open + unblocked + unclaimed 的 tickets
- **Fog of war**：能看到但还不能精确定义的决策
- **Out of scope**：明确排除的

规则：**每个 session 只 resolve 一个 ticket。** 做完一个，fog 退一步，新的 tickets 毕业。

Ticket 类型：
- **Research**（AFK）：读文档、调研 API
- **Prototype**（HITL）：做粗糙原型回答设计问题
- **Grilling**（HITL）：逐个拷问决策
- **Task**（HITL/AFK）：必须做完才能决策的手工活

### 6. `tdd` — 测试驱动开发

核心纪律：
- **Red before green**：先写失败测试，再写最小实现
- **One slice at a time**：一个 seam，一个测试，一个最小实现
- **Refactoring 不在循环内**：属于 review 阶段
- **测试只验证行为**：通过公共接口测试，不测实现细节
- **先确认 seam**：写测试前先和用户确认 seam 位置

反模式：
- Implementation-coupled：mock 内部协作者、测私有方法
- Tautological：assertion 用和代码相同方式计算期望值
- Horizontal slicing：先写所有测试再写所有实现

### 7. `domain-modeling` — 领域建模

主动构建和锐化项目的领域模型：
- **挑战术语冲突**：用户说的和 CONTEXT.md 定义不一致时立即指出
- **锐化模糊语言**：提出精确的规范术语
- **具体场景压力测试**：用边缘案例测试领域关系
- **交叉验证代码**：用户说的和代码实际行为是否一致
- **即时更新 CONTEXT.md**：术语解决时就更新，不批量

ADR（Architecture Decision Record）的三个触发条件（全部满足才写）：
1. Hard to reverse — 后面改的成本高
2. Surprising without context — 未来读者会问"为什么这样做"
3. Result of real trade-off — 有真正的备选方案

### 8. `to-spec` — 对话转 spec

不做新访谈，只综合已有对话。模板：
- Problem Statement
- Solution
- User Stories（**极长列表**）
- Implementation Decisions
- Testing Decisions（seam 确认）
- Out of Scope

### 9. `to-tickets` — spec 拆分 tickets

把 spec 拆成 tracer-bullet tickets，每个声明 blocking edges。支持本地文本或 issue tracker 原生 blocking 链接。

### 10. `handoff` — 会话交接

生成上下文压缩文档给下一个 agent session：
- 做了什么、当前状态、下一步
- 推荐 skills
- 引用已有 artifacts（不重复内容）
- 脱敏处理

---

## CONTEXT.md — 领域语言文件

项目根目录的 `CONTEXT.md` 是**领域词汇表**。所有 skill 共享这个语言。

作用：消除 AI 的啰嗦。当 AI 和人都用"Order"而不是"purchase request"或"shopping cart submission"，沟通成本降到零。

skill 不只是读 CONTEXT.md——`domain-modeling` 和 `grill-with-docs` 会**主动更新**它。

---

## 日常组合用法

### 场景 1：新功能开发

```
用户: "我需要给 API 加 rate limiting"

/grill-me
  ↓ AI 逐个拷问：
  - "rate limit 按 IP 还是按 user？推荐 user。"
  - "超限返回 429 还是排队？推荐 429。"
  - "用 Redis 还是内存？推荐 Redis 因为多实例。"
  - ... 直到共识达成

/domain-modeling
  ↓ 拷问过程中发现：
  - "RateLimit" 加入 CONTEXT.md
  - "Throttle" vs "RateLimit" 歧义解决
  - 更新 ADR: "选用 sliding window 而非 fixed window"

/to-spec
  ↓ 对话 → spec 文档，发布到 issue tracker
  - Problem Statement
  - User Stories（长列表）
  - Implementation Decisions
  - Testing Decisions（seam 确认）
  - Out of Scope

/to-tickets
  ↓ spec → 拆分 tickets + 依赖边
  - ticket 1: RateLimiter module（无阻塞）
  - ticket 2: Middleware 集成（blocked by #1）
  - ticket 3: 集成测试（blocked by #2）
  - ticket 4: 文档更新（无阻塞）

/implement（逐个 ticket）
  ↓ 每个 ticket:
  /tdd
    Phase 1: 写失败测试（红）
    Phase 2: 最小实现通过（绿）
    一个 vertical slice → 下一个
  ↓
  /code-review（做完后审查）
    并行子 agent:
    - Standards 轴：符合编码标准？
    - Spec 轴：实现了 spec 要求？
```

### 场景 2：修 bug

```
用户: "checkout 流程偶发超时，帮我 debug"

/diagnosing-bugs
  ↓
  Phase 1: 建反馈循环（核心！）
    - 先尝试写 failing test → 不行，偶发的
    - 试 curl 脚本重放 → 10% 复现率
    - 加 stress + parallel → 60% 复现率
    - 现在有了紧致信号 ✓

  Phase 2: 复现 + 最小化
    - 砍掉不相关的 middleware → 还复现
    - 砍掉 payment step → 不复现了
    - 最小 repro: payment step + 并发 > 5

  Phase 3: 假设（3-5 个，先列再测）
    1. DB connection pool 耗尽
    2. payment gateway timeout 未设上限
    3. 事务隔离级别导致锁等待
    4. Redis 连接泄漏

  Phase 4: 针对性埋点
    - 加 [DEBUG-a4f2] 在 connection pool → 确认假设 1

  Phase 5: 修复 + 回归测试
    - 先写测试（在正确 seam）
    - 修 → 测绿

  Phase 6: 清理
    - 删所有 [DEBUG-*] 日志
    - commit message 写根因
    - 发现 seam 不好测 → 交给 ↓

/improve-codebase-architecture
  ↓ 扫描 → HTML 报告
  - "PaymentGateway 是 shallow module，interface 和实现一样复杂"
  - 推荐 deepening: 把 connection pooling 藏在 seam 后面
```

### 场景 3：架构重构

```
用户: "这块代码越来越难维护了"

/improve-codebase-architecture
  ↓
  1. 读 CONTEXT.md + ADRs
  2. Explore agent 扫描代码库
  3. 生成 HTML 报告：
     ┌──────────────────────────────────┐
     │ Card 1: OrderProcessor shallow   │
     │ Before: 5 files, 3 seams         │
     │ After: 1 deep module, 1 seam     │
     │ Strength: Strong                 │
     ├──────────────────────────────────┤
     │ Card 2: PaymentGateway 无 seam   │
     │ Before: 直接 new StripeClient    │
     │ After: 注入 adapter              │
     │ Strength: Worth exploring        │
     └──────────────────────────────────┘
  ↓
  用户: "Card 1 怎么做？"

/grilling
  ↓ 拷问设计决策：
  - "OrderProcessor 的 interface 应该暴露几个方法？"
  - "Order 状态机放模块内还是外？"
  - ...

/codebase-design
  ↓ 用精确词汇设计：
  - Module: OrderIntake
  - Interface: 3 个方法
  - Seam: OrderIntake 和 OrderRepository 之间
  - Depth: 高（复杂状态机藏在 3 个方法后面）

  /design-it-twice（子模式）
  ↓ 并行子 agent 设计两种 interface：
  - 方案 A: command pattern
  - 方案 B: state machine
  - 对比 depth / locality / seam 放置

/domain-modeling
  ↓ 设计过程中：
  - "OrderIntake" 加入 CONTEXT.md
  - 和已有 "OrderFulfillment" 的关系明确

/tdd → /implement → /code-review
  ↓ 标准开发循环
```

### 场景 4：超大任务（跨多个 session）

```
用户: "我们要把单体应用拆成微服务"

/wayfinder
  ↓
  Session 1: 画地图
  ┌─────────────────────────────────┐
  │ Destination:                    │
  │ 拆分为 ordering + billing +     │
  │ notification 三个服务           │
  │                                 │
  │ Tickets:                        │
  │ □ [research] 现有数据耦合分析   │
  │ □ [grilling] 拆分边界决策       │
  │ □ [research] 通信机制选型       │
  │ □ [prototype] API gateway POC  │
  │ □ [grilling] 数据迁移策略       │
  │                                 │
  │ Fog of war:                     │
  │ - 共享 auth 怎么处理？          │
  │ - 分布式事务？saga 还是 2PC？  │
  │                                 │
  │ Out of scope:                   │
  │ - 前端不需要改                  │
  └─────────────────────────────────┘

  Session 2: resolve ticket #1 (research)
  ↓ 后台 agent 分析数据耦合 → 写报告

  Session 3: resolve ticket #2 (grilling)
  ↓ 拷问拆分边界 → domain-modeling 更新 CONTEXT.md
  ↓ 解决过程中 fog 清晰了 → 创建新 ticket #6

  Session N: ...
  ↓ 每个 session 只 resolve 一个 ticket
  ↓ frontier 不断推进，fog 不断退散
```

### 场景 5：会话交接

```
用户: "今天到这里，明天继续"

/handoff
  ↓ 生成交接文档：
  - 做了什么
  - 当前状态
  - 下一步
  - 推荐 skills
  - 引用已有 artifacts（不重复内容）
  - 脱敏（API keys 等）

  下一个 session:
  新 agent 读交接文档 → 继续
```

---

## 组合模式总结

```
日常开发的核心链路：

1. 需求对齐链:
   grill-me → domain-modeling → to-spec → to-tickets

2. 实现链:
   implement → tdd → code-review

3. 质量修复链:
   diagnosing-bugs → improve-codebase-architecture → grilling → tdd

4. 大任务链:
   wayfinder(画地图) → [grilling|research|prototype](逐个 ticket) → wayfinder(更新地图)

5. 跨 session 链:
   任意链路 → handoff → 新 session 读交接文档 → 继续
```

---

## 和 Octopus skills 的对比

| 维度 | mattpocock/skills | Octopus skills |
|------|------------------|----------------|
| 数量 | ~20 个 | 200+ 个 |
| 风格 | 每个 skill 是精炼的纪律文档 | 每个 skill 是流程步骤 |
| 哲学 | 约束 AI 的坏行为 | 扩展 AI 的能力 |
| 核心 skill | grilling（对齐）| octo-skill-creator（生产） |
| 领域模型 | CONTEXT.md 共享词汇 | 无对应 |
| 调用控制 | user/model invoked 层级 | 无层级 |
| 质量标准 | 深模块、删除测试、seam 纪律 | 功能覆盖 |
| 编排方式 | 人手动触发 slash command 链 | YAML workflow 引擎自动 |
| 适用场景 | 单人 + 单 agent 交互开发 | 自动化流水线、无人值守 |

---

## 值得 Octopus 借鉴的点

1. **grilling 模式** — 做任何创造性工作前先强制对齐需求。Octopus 的 brainstorming skill 类似但不够 relentless
2. **CONTEXT.md 共享词汇** — 所有 skill 读同一个领域模型，消除歧义
3. **双轴 code review** — Standards + Spec 分离，并行子 agent
4. **wayfinder 迷雾地图** — 超大任务的分治策略，fog of war 概念可以直接用
5. **diagnosing-bugs Phase 1** — "建反馈循环"比"分析代码"优先。debugging skill 应该强调这个
6. **调用层级** — user-invoked vs model-invoked 防止 AI 自己启动编排 skill
7. **删除测试** — 评估模块价值的思维工具，想象删掉模块看复杂度去哪了
8. **design-it-twice** — 并行子 agent 设计多种 interface 方案再比较
