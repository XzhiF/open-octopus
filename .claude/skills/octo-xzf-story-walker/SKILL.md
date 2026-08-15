---
name: octo-xzf-story-walker
description: "Story Walk-Through 故事穿线分析 — trace 核心故事找断路/缺口/偏离，3 模式：requirement/spec/impl"
category: coding-assistant
tags: [xzf-dev, verification, walkthrough]
version: 1.0.0
---

# Story Walk-Through 故事穿线分析

> 方法论适配自 `matt-verified-requirement/references/story-walkthrough.md`，xzf 原生化。

## 触发条件

被三处加载：
- **requirements-clarify**（inline）— requirement 模式，找决策缺口 → 追问。
- **spec-audit** 节点 sub-agent — spec 模式，找 plan 断路 → 补充 spec。
- **impl-walkthrough-fix** 节点 sub-agent — impl 模式，找实现缺口/偏离 → 修复。

## 核心理念

**逐决策没问题 ≠ 端到端闭环。** 每个 schema/API/AC 单独看都对，但故事可能在某步断：UI 组件不存在、数据字段无 writer、跨包不可达、事件未连通。穿线 = 把故事从头走到尾，在每步查「这步真的通吗」。

## 核心方法

### Step 1: 选核心故事（1-3 个）

- 不同 persona（开发者 / 管理员 / 终端用户）
- 横穿全栈（UI → API → data → backend exec）
- 含至少一个 happy path + 一个 intervention path（错误恢复 / 回滚 / 人工介入）

### Step 2: 逐步 trace，标注触点

每个故事按顺序走，每步标注：

```
[UI]    用户看到/交互什么
[API]   调哪个端点，参数/响应
[Data]  读写哪张表/字段
[Exec]  跑哪段后端逻辑，属哪个包
[Event] 触发什么 SSE/WebSocket/cron 事件
```

格式（垂直流）：

```markdown
用户打开页面
  │
  ├─[UI]  Dashboard 渲染 → 需 GET /api/feature/dashboard
  ├─[API] GET /api/feature/dashboard → 返回 DashboardData
  ├─[Data] 查 feature_table WHERE ...
  └─[Exec] Engine 调 Service.method() ← 哪个包？
```

### Step 3: 每步查 checkpoint，标断点

| Check | 问题 |
|-------|------|
| **UI 在?** | 该 UI 组件/页面存在吗，还是要新建？ |
| **API 在?** | 端点已实现还是新建？新建的话响应类型定义了吗？ |
| **数据可达?** | 这步代码真能访问它需要的数据吗？跨包？跨服务？ |
| **事件连通?** | 这步依赖异步事件的话，事件定义了、handler 实现了吗？ |
| **反馈闭环?** | 这步产出的数据喂给后续步骤时，格式一致吗？ |
| **错误路径?** | 这步失败会怎样？错误传到用户了吗？ |

标断点：

```markdown
├─[Exec] Engine 调 VersionResolver
│         ← [断点A] VersionResolver 在 server 包，engine 访问不到
```

### Step 4: 分级 + fix 建议

| Severity | 含义 | 动作 |
|----------|------|------|
| **CRITICAL** | 故事走不下去 — 执行阻塞 | 必须修 |
| **HIGH** | 故事能走但结果错/不全 | 必须修 |
| **MEDIUM** | 故事走通但 UX 降级（缺反馈/无 loading） | 记录，实现时修 |
| **LOW** | 外观/便利 | 记录到风险 |

每个 CRITICAL/HIGH 给具体 fix（新类型 / 新字段 / 新回调 / 新组件 / 新 AC）。

### Step 5: re-trace

修后重走故事，确认断点都消了。修出新断点则迭代直到干净。

## 6 个反模式（必查）

1. **魔术桥** — 两包要共享数据但无接口连接。任何跨包边界处都要查。
2. **孤儿字段** — 某表列/类型字段被引用但无任何前置步骤写入它。每个字段追溯到它的 writer。
3. **静默失败** — 某步会失败但无错误事件、无通知、无重试。每个失败路径都要有去处。
4. **缺触发器** — 自动流程（自动提升/回滚/清理）没人调它。找出调度器/cron/事件。
5. **无版本状态** — 数据被覆盖无版本跟踪。演化的产物需要版本链。
6. **断反馈** — A 步产出喂 B 步，但格式/通道不匹配。验证完整信号链。

## 三模式

按调用方传入的目标，读不同产物、找不同断点：

### requirement 模式（clarify，inline）

- **读**：`.scratch/{feature}/02-clarification/questions.md`（已确认决策）+ research-brief
- **trace 穿过**：**已决策的**接口/存储/UI（非代码，是决策）
- **找**：**决策缺口** — 某步数据字段无 writer 决策、跨模块无接口决策、错误路径未决、缺触发器未决
- **产出**：缺口转 **待澄清问题**（追加 questions.md「待澄清」，刨根问底）
- 保证存储/接口/UI-UX/设计/决策全闭环、故事完整

### spec 模式（spec-audit，sub-agent）

- **读**：`.scratch/{feature}/03-specs/spec-index.md` + 各 spec-NNN.md + T-N task + brief.md + verification.md
- **trace 穿过**：**specs + 当前 codebase**（执行前）
- **找**：**plan 断路/阻塞/未实现** — UI 组件不存在、API 未定义、跨包数据不可达、事件未连通、反馈未闭环
- **产出**：结构化断点（severity + fix 建议 + 涉及 spec/task），**不改 spec**（父 agent 决定采纳）

### impl 模式（impl-walkthrough-fix，sub-agent）

- **读**：`.scratch/{feature}/02-clarification/verification.md`（测试方法+反假跑）+ spec-index + specs
- **trace 穿过**：**已实现代码**
- **找**：**缺口/偏离** — stub、断路、与 spec 验收标准不符
- **产出**：结构化断点（severity + 修复建议，对齐 spec），**不改 spec**（父 agent 决定修）

## 输出格式（返回给父 agent）

结构化报告：

```markdown
## Story Walk-Through — {模式}

### 核心故事
1. {故事名} — {persona}，happy path
2. {故事名} — {intervention path}

### 故事 trace
{Step 2 的垂直流，含断点标注}

### 断点
| # | Severity | 位置 | 描述 | fix 建议 | 涉及 spec/task |
|---|----------|------|------|---------|----------------|
| A | CRITICAL | [Exec] ... | ... | 新增 X 类型 | spec-002/T-3 |

### 反模式命中
- 魔术桥: {位置} — {说明}

### 建议 fix 汇总
- {fix 1}
- {fix 2}
```

## 原则

- **子代理只返回发现，不改 spec/code**。父 agent（clarify 交互 agent / spec-audit / impl-walkthrough-fix）决定如何采纳。
- **spec 模式只补充不改路径**：采纳的 fix 追加新 T-N task / AC，不改已有。
- **impl 模式对齐 spec**：修复让实现符合 spec 设计预期，不偏离。
- 发言聚焦结论与断点，不写冗长分析。trace 够定位断点即可。
