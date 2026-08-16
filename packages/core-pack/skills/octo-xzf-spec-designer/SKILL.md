---
name: octo-xzf-spec-designer
description: "Spec 初稿设计规范 — 目标驱动、验证优先（无 tasks，tasks 由 spec-to-tasks 出）"
category: coding-assistant
tags: [xzf-dev]
version: 3.0.0
---

# Spec 设计规范（初稿，无 tasks）

## 触发条件
Stage 4a `spec-planner` 节点，产 spec 初稿（spec-NNN.md）。**只产 spec，不产 tasks**——tracer bullet tasks 由下游 `spec-to-tasks` 阶段（读已 audit 的 specs）生成。

读上游澄清产物（session 上下文继承）：
- `.scratch/{feature}/01-research/research-brief.md`
- `.scratch/{feature}/02-clarification/questions.md`（已确认决策）
- `.scratch/{feature}/02-clarification/verification.md`（验证策略）

## 核心原则

1. **目标驱动** — spec 只写"做什么"和"怎么验证"，不写"怎么实现"
2. **用户视角** — 描述"用户能做什么"，不写"改什么文件"
3. **不写文件路径** — agent 自行决定实现方式，路径会过时
4. **验证优先** — 每个 spec 必须有验收标准 + E2E 验证场景
5. **自包含** — brief 已去除，spec 须自带验收标准/数据模型/API/验证策略，下游（spec-to-tasks/execution/e2e）只读 spec

## 拆分原则

1. 简单需求 → 1 个 spec，不强制拆分
2. 每个 spec = 一条完整用户故事线（可独立交付）
3. 从简单到复杂排列（spec-001 最基础）
4. spec 之间有依赖但尽量松耦合

## Spec 文件命名
`spec-{NNN}-{name}.md` — 三位数字编号 + 简短英文名称

## Spec 格式

```markdown
# spec-NNN: {标题}

## 目标
[1-3 句话，这个 spec 实现什么，用户视角]

## 服务链
| 项目 | 职责 |
|------|------|
| {project-1} | {做什么} |
| {project-2} | {做什么} |

> 单项目 spec 可省略服务链。

## Wireframe（如有 UI）

{ASCII 框线图，从澄清阶段已确认的 wireframe 提取}

\`\`\`
┌─────────────────────────────────┐
│  ...                            │
└─────────────────────────────────┘
\`\`\`

### 交互说明
- {交互点}: {行为描述}

> 无 UI 变更的 spec 省略此节。

## 验收标准
| # | 用户故事 | 验收条件 | 验证方法 |
|---|---------|---------|---------|
| AC1 | As a [角色], I want [功能] | [可验证条件] | [验证方式] |

## 单测要点

> 只列核心逻辑的测试方向，implementer 据此写关键单测。不追求覆盖率。

| 模块 | 测什么 | 命令 |
|------|--------|------|
| {模块} | {核心逻辑路径} | `{pnpm test -- --filter xxx}` |

## E2E 验证场景

> 详细验证在 e2e-verify 阶段统一执行。此处只列关键场景，供 spec-to-tasks 编排进 e2e-test-plan。

| 场景 | 操作 | 预期结果 | 反假跑 |
|------|------|---------|--------|
| S1 | {用户操作} | {可观测结果} | {真通过条件} |

## 数据模型（如有）
| 表 | 操作 | 字段/说明 |
|----|------|----------|

## API 契约（如有）
| 方法 | 路径 | 端 | 入参 | 出参 | 说明 |
|------|------|----|------|------|------|

## 约束
- {不能做什么 / 技术边界 / 性能要求}
```

### 章节裁剪

- 无服务链 → 删除「服务链」
- 无 UI 变更 → 删除「Wireframe」
- 无单测方向 → 删除「单测要点」
- 无 E2E 场景 → 删除「E2E 验证场景」
- 无数据模型变更 → 删除「数据模型」
- 无 API → 删除「API 契约」
- 无特殊约束 → 写「无特殊约束」或删除章节

## Spec 索引（初稿）

产 `03-specs/spec-index.md`（spec 列表；Tracer Bullets 数 + 执行顺序由 spec-to-tasks 填）：

```markdown
# Spec 索引

> 总数: {N}

| # | 文件名 | 标题 | Tracer Bullets | Depends |
|---|--------|------|---------------|---------|
| 1 | spec-001-user-login.md | 用户登录 | 待 spec-to-tasks | none |
```

## 质量检查

1. 每个 spec 目标是否清晰（用户视角）？
2. 每个 spec 是否有验收标准 + 验证方法？
3. E2E 验证场景是否与 verification.md 对齐？
4. 涉及 UI 的 spec 是否有 Wireframe？
5. 数据模型/API 是否完整（有变更才列）？
6. 是否避免了文件路径和实现细节？
7. **是否误产了 tasks / T-N 文件？**（应无——tasks 由 spec-to-tasks 出）
8. spec-index.md 是否列出所有 spec？

## 领域术语对齐

设计 spec 前读取项目已有领域知识：

```
{project}/CONTEXT.md 或 CONTEXT-MAP.md   ← 领域术语
{project}/docs/adr/                      ← 已有架构决策
```

- Spec 中必须使用 CONTEXT.md 已有的术语，不造新概念
- 如果需要用新概念，标到 spec 的约束节，等 clarify 阶段确认

## 架构决策记录（ADR）

当 spec 涉及满足以下**三个条件**的决策时，写入 ADR：

1. **难逆转** — 后续改动成本高（数据库选型、通信协议、认证方案）
2. **无上下文时会惊讶** — 未来读者会问"为什么这样做"
3. **真实权衡** — 有替代方案但选了当前方案

三个条件缺一个就不写。容易逆转的跳过，不意外的跳过，没有替代方案的跳过。

**ADR 格式（兼容 domain-modeling）：**

```markdown
# {决策标题}

{1-3 句话：上下文、决定、原因。}
```

就这么短。ADR 的价值在于记录**做了什么决定**和**为什么**。

**可选章节**（仅在真正增值时添加）：
- **Considered Options** — 被否决的替代方案值得记住时
- **Consequences** — 非显而易见的下游影响需要指出时

**写入规则：**
- 路径：`{project}/docs/adr/NNNN-slug.md`
- 扫描 docs/adr/ 已有编号，递增 1
- 目录不存在则创建（lazy creation）
- 一次 spec 设计最多写 1-2 个 ADR，不滥用
