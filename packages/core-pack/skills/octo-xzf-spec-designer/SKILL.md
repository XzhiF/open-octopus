---
name: octo-xzf-spec-designer
description: "Spec + Tracer Bullet 设计规范 — 目标驱动、垂直切片、验证优先"
category: coding-assistant
tags: [xzf-dev]
version: 2.2.0
---

# Spec + Tracer Bullet 设计规范

## 触发条件
Stage 4 agent 节点，读取 brief.md，一次生成所有 spec 和 tracer bullet tasks。

## 核心原则

1. **目标驱动** — 每个 spec/task 只写"做什么"和"怎么验证"，不写"怎么实现"
2. **垂直切片** — 每个 task 是一个 tracer bullet：横穿 DB→API→UI→测试的完整路径
3. **用户视角** — task 描述"用户能做什么"，不写"改什么文件"
4. **不写文件路径** — agent 自行决定实现方式，路径会过时
5. **验证优先** — 每个 spec 和 task 都必须有明确的验证方法

## 拆分原则

1. 简单需求 → 1 个 spec，不强制拆分
2. 每个 spec = 一条完整用户故事线（可独立交付）
3. 从简单到复杂排列（spec-001 最基础）
4. spec 之间有依赖但尽量松耦合
5. 每个 spec 拆为 2-5 个 tracer bullet tasks
6. **不足 2 个 tracer 不单独成 spec** — 合并到它依赖的上游 spec 中（加一个 tracer 即可）
7. **功能延伸不单独成 spec** — 如果 spec B 只是"在 spec A 的基础上接一下"（集成、适配、接入），应作为 spec A 的一个 tracer

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

{ASCII 框线图，从 brief.md 的已确认 wireframe 提取}

```
┌─────────────────────────────────┐
│  ...                            │
└─────────────────────────────────┘
```

### 交互说明
- {交互点}: {行为描述}

> 无 UI 变更的 spec 省略此节。

## Tracer Bullets
| # | 标题 | 用户可验证结果 | 依赖 |
|---|------|--------------|------|
| T1 | {标题} | {完成后用户能看到/做什么} | — |
| T2 | {标题} | {完成后用户能看到/做什么} | T1 |

## 单测要点

> 只列核心逻辑的测试方向，implementer 据此写关键单测。不追求覆盖率。

| 模块 | 测什么 | 命令 |
|------|--------|------|
| {模块} | {核心逻辑路径} | `{pnpm test -- --filter xxx}` |

## E2E 验证场景

> 详细验证在 E2E 阶段统一执行。此处只列关键场景供 e2e-test-plan 引用。

| 场景 | 操作 | 预期结果 |
|------|------|---------|
| S1 | {用户操作} | {可观测结果} |

## 约束
- {不能做什么 / 技术边界 / 性能要求}
```

### 章节裁剪

- 无服务链 → 删除「服务链」
- 无 UI 变更 → 删除「Wireframe」
- 无明确单测方向 → 删除「单测要点」
- 无 E2E 场景 → 删除「E2E 验证场景」
- 无特殊约束 → 写「无特殊约束」或删除章节

## Task 格式（Tracer Bullet）

每个 tracer bullet 写入独立文件，放在 spec 子目录下：
`03-specs/spec-NNN-{name}/T-N-{name}.md`

⚠️ 所有 spec 必须建子目录（即使只有 1 个 task），下游执行循环靠子目录中的 T-N 文件发现任务。

```markdown
# T-N: {标题}

## 目标
[1-2 句话，用户视角：完成后用户能做什么]

## 验收标准
- [ ] {具体可验证条件}
- [ ] {具体可验证条件}

## 依赖
- {前置 task，或 "无"}
```

### Tracer Bullet 设计规则

1. **每个 task 是完整路径** — 不做"前端 task"或"后端 task"水平切片
2. **每个 task 独立可验证** — 完成后能 demo 或跑验证
3. **每个 task 装进一个 context window** — 不要太细碎也不要太庞大
4. **不写文件路径** — 只写用户行为和验证方式
5. **依赖关系最小化** — 尽量线性，少交叉依赖

## Spec 索引文件

生成所有 spec 后，写入 `03-specs/spec-index.md`：

```markdown
# Spec 索引

> 生成时间: {timestamp}
> 总数: {N}

| # | 文件名 | 标题 | Tracer Bullets | Depends |
|---|--------|------|---------------|---------|
| 1 | spec-001-user-login.md | 用户登录 | 3 | none |
| 2 | spec-002-dashboard.md | 仪表盘 | 4 | spec-001 |
```

execution-loop 读取此文件，通过 `#` 列定位第 `$iteration` 个 spec。

## E2E 测试计划

生成所有 spec 后，综合所有 spec 的 E2E 验证方法，写入 `03-specs/e2e-test-plan.md`：

```markdown
# E2E 测试计划

> 生成时间: {timestamp}
> 覆盖 spec: {spec 列表}

## 前置条件
- [ ] {如：后端服务已启动}
- [ ] {如：测试用户已创建}

## 全局配置
- 验证环境: {UAT / 本地 / ...}
- 测试用户: {账号信息}
- 测试数据前缀: {如 "E2E_TEST_"}

## 测试步骤

### Step 1: {步骤名} (spec-NNN)
- 页面: {URL}
- 操作: {具体操作}
- 断言: {预期结果}
- Wireframe 对比: {如有 wireframe，截图对比布局/元素位置}
- 反假跑: {真通过条件}

### Step 2: {步骤名} (spec-NNN)
- 页面: {URL}
- 操作: {具体操作}
- 断言: {预期结果}
- Wireframe 对比: {如有 wireframe，截图对比布局/元素位置}
- 反假跑: {真通过条件}

...
```

e2e-runner 直接读取此文件执行，不需要遍历各 spec 文件。

### E2E 测试计划编制规则

1. 按 spec 依赖顺序编排步骤（基础功能先测）
2. 每个步骤标注来源 spec 编号，方便定位失败
3. 合并可复用的前置操作（如登录一次后跑多个步骤）
4. 无 E2E 验证方法的 spec 不出现在计划中
5. 反假跑条件从 spec 的反假跑标准章节提取

## 质量检查

生成后自查:
1. 每个 spec 目标是否清晰（用户视角）？
2. 每个 tracer bullet 是否横穿全栈（垂直切片）？
3. 每个 task 验收标准是否具体可验证？
4. E2E 验证场景是否与 brief.md 验证策略对齐？
5. e2e-test-plan.md 是否覆盖所有有 E2E 场景的 spec？
6. 涉及 UI 的 spec 是否有 Wireframe？
7. 是否避免了文件路径和实现细节？
8. spec-index.md 是否完整？
9. 是否有只有 1 个 tracer 的 spec？如有，应合并到上游 spec
10. 是否有"集成/适配"型 spec？如有，应作为上游 spec 的 tracer

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
