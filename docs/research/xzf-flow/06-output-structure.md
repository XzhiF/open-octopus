# 输出目录结构与文档模板

## 1. 目录总览

```
.octopus/xzf/{branch}/
├── workspace-topology.md
├── 01-idea.md
├── 02-research/
│   ├── index.md
│   └── {domain}.md
├── 03-clarification/
│   └── questions.md                   # 含 Research 项类别
├── 04-stories/
│   ├── summary.md
│   ├── technical-guide.md
│   └── test-environment.md
├── 05-specs/
│   ├── spec-001-{name}.md
│   ├── spec-002-{name}.md
│   └── ...
├── 06-plans/
│   └── spec-{NNN}-{name}/
│       ├── consensus.md
│       ├── verify-{X}-{Y}.md
│       ├── task-{X}-{Y}-{project}-{role}.md
│       └── spec-test.md
├── 07-execution/
│   └── spec-{NNN}-{name}/
│       ├── verify-results/
│       │   ├── verify-{X}-{Y}.md
│       │   └── screenshots/
│       └── fix-log.md
├── 08-reports/
│   └── failure-{timestamp}.md
└── 09-ship/
    └── summary.md
```

## 2. 各文件模板

### 2.0 workspace-topology.md

```markdown
# Workspace 拓扑

## 项目列表
| 项目 | 技术栈 | 主要模块 | 端口 |
|------|--------|---------|------|
| project-web | Next.js 14 | 前端页面、API routes | 3000 |
| project-service | Go + gRPC | 业务服务、RPC 接口 | 50051 |
| shared-lib | TypeScript | 类型定义、工具函数 | - |

## 项目间通信
| 源 | 目标 | 方式 | 说明 |
|----|------|------|------|
| project-web | project-service | HTTP REST → gRPC gateway | 前端调用后端 |
| project-service | shared-lib | import | 使用共享类型 |

## 项目约定
### project-web
- 框架: Next.js 14 App Router
- 样式: Tailwind CSS
- 状态管理: Zustand

### project-service
- 框架: Go + gRPC
- 数据库: PostgreSQL
- ORM: GORM
```

### 2.1 01-idea.md

```markdown
# Idea

## 描述
{用户输入的原始 idea 描述}

## 输入时间
{timestamp}

## 分支
{branch name}
```

### 2.2 02-research/

#### index.md

```markdown
# Research 索引

## 研究领域

| 文件 | 领域 | 关键信息 | 与 Idea 的关系 |
|------|------|---------|---------------|
| {domain}.md | {领域名} | {一句话摘要} | {如何关联} |
```

#### {domain}.md（每个领域一个文件）

```markdown
# {领域名}领域研究

## 现有实现
- {现有代码/模块的关键摘要}

## 关键决策点
- {影响本次开发的重要决策信息}

## 对本次 Idea 的影响
- {具体影响和建议}

## 特性参考
- {相关技术特性、最佳实践}
```

### 2.3 03-clarification/questions.md

```markdown
# 澄清问题清单

## Round 1 — {date}

### 核心分解
{专家团将 idea 分解的核心功能模块列表}

### 澄清项

#### Q-1: {问题标题}
- **背景**: {为什么需要澄清}
- **推荐方案**:
  - {描述}
  - 优点: ...
  - 缺点: ...
- **备选方案 1**: {描述}
- **备选方案 2**: {描述}
- **用户回复**: {等待用户填写}

#### Q-2: {问题标题}
...

### 测试环境澄清
#### E-1: 数据库
- 类型: {待澄清}
- 连接: {待澄清}
- 初始数据: {待澄清}

#### E-2: 缓存服务
- 类型: {待澄清}
- 连接: {待澄清}

#### E-3: 项目启动
- 命令: {待澄清}
- 端口: {待澄清}

### 充分性评估
- 功能完整性: {已覆盖/待补充}
- 测试环境: {已明确/待补充}
- 建议: {可以结束/需要继续}

## Research 项（需要专家深入理解的内容）

### R-1: Codebase Research
- **范围**: {哪些模块/文件需要专家重点研究}
- **目的**: {为什么需要理解这部分}
- **用户补充**: {用户可以提供的上下文/文档链接}

### R-2: 技术调研
- **范围**: {需要调研的技术方案/第三方库}
- **目的**: {为什么要调研}

---
## Round 2 — {date}
{追加的澄清问题和用户回复}
```

### 2.4 04-stories/summary.md

```markdown
# 用户故事总汇

## 功能概述
{一段话描述本次 feature 的核心价值}

## 角色定义
| 角色 | 描述 | 关键场景 |
|------|------|---------|

## 完整故事线

### 故事 1: {标题}
- **角色**: {谁}
- **目标**: {要达成什么}
- **服务链**: {project-web (HTTP)} → {project-service (RPC)}
- **路径**: {从头到尾的操作流程概述}
- **完成标准**: {怎么算完成}
- **对应 Spec**: spec-{NNN}

### 故事 2: {标题}
...

## 功能组合矩阵
{哪些故事共享功能模块}

## 功能闭环检查
- [ ] 每个角色的所有场景已覆盖
- [ ] 异常流程已考虑
- [ ] 数据生命周期完整
```

### 2.5 04-stories/technical-guide.md

```markdown
# 技术指导文档

## 技术约束
- {constraint 1}
- {constraint 2}

## 架构决策
- {decision 1}: {reason}
- {decision 2}: {reason}

## 项目间通信约定
| 源项目 | 目标项目 | 协议 | 接口 | 备注 |
|--------|---------|------|------|------|
```

### 2.5b 04-stories/test-environment.md

```markdown
# 测试环境配置

## 数据库
| 项目 | 类型 | 连接串格式 | 种子数据 |
|------|------|-----------|---------|
| {project-auth} | {PostgreSQL 15} | {postgresql://user:pass@host:5432/dbname} | {migration + seed script} |

## 中间件
| 类型 | 连接信息 | 用途 | 清理策略 |
|------|---------|------|---------|
| {Redis} | {redis://localhost:6379} | {session/缓存} | {FLUSHDB per test} |

## 项目启动（per project）
| 项目 | 命令 | 端口 | 健康检查 |
|------|------|------|---------|
| {project-web} | {pnpm dev} | {3000} | {GET /api/health → 200} |
| {project-auth} | {pnpm dev} | {3001} | {GET /health → 200} |

## E2E 测试
- 工具: {browse / playwright / curl}
- 启动方式: {browse daemon start / npx playwright install}
- 截图目录: .octopus/xzf/{branch}/07-execution/.../screenshots/
- 执行模式: {headless / headed}

## 测试数据准备
- 方式: {seed script / API fixture / DB insert}
- 脚本路径: {scripts/seed-test-data.ts}
- 测试账号: {test@example.com / Test123!}

## 环境就绪检查
E2E 执行前必须确认:
- [ ] 数据库已连接
- [ ] 各项目已启动且健康检查通过
- [ ] 测试数据已准备
- [ ] E2E 工具可用
```

### 2.6 05-specs/spec-{NNN}-{name}.md

Refer to 05-spec-dsl.md for the complete DSL format. Just mention the reference here.

### 2.7 06-plans/spec-{NNN}-{name}/consensus.md

```markdown
# Spec-{NNN} 总纲领

## 概述
{一段话描述这个 spec 要实现什么}

## 涉及项目
| 项目 | 职责 | 通信方式 |
|------|------|---------|
| {project-web} | HTTP 层、前端页面 | → project-service via REST |
| {project-service} | 业务逻辑、RPC 接口 | ← project-web |

## DB 变更
| 项目 | 操作 | 表名 | 字段/变更 | 备注 |
|------|------|------|----------|------|

## 文件变更（per project）
### {project-web}
| 操作 | 文件路径 | 描述 |
|------|---------|------|
| 新增 | | |
| 修改 | | |

### {project-service}
| 操作 | 文件路径 | 描述 |
|------|---------|------|
| 新增 | | |
| 修改 | | |

## 共用约定
- 错误码格式: {format}
- API 响应格式: { data, error, meta }
- 认证方式: {method}
- 命名规范: {convention}
- 项目间接口契约: {API/RPC interface definition}

## 并行开发边界
- {project-web}: {独立文件列表}
- {project-service}: {独立文件列表}
- 共用契约: {跨项目接口定义，需先对齐}
```

### 2.8 06-plans/spec-{NNN}-{name}/verify-{X}-{Y}.md

```markdown
# Verify-{X}-{Y}: {标题}

## 验证目标
{验证什么功能/行为}

## 验证方法

### 单元测试

```typescript
// 测试代码示例
test('{描述}', () => {
  // Arrange
  // Act
  // Assert
})
```

### 集成测试

```typescript
test('{描述}', async () => {
  // API 调用测试
})
```

### E2E 测试（如适用）

```bash
# browse 命令序列
```

## 通过标准
- [ ] 单元测试全部通过
- [ ] 集成测试全部通过
- [ ] 覆盖率 ≥ 80%
```

### 2.9 06-plans/spec-{NNN}-{name}/task-{X}-{Y}-{project}-{role}.md

```markdown
# Task-{X}-{Y}-{Project}-{Role}: {标题}

## 项目
{project-name}（工作目录: projects/{project-name}/）

## 任务描述
{简要描述做什么}

## 依赖
- 前置任务: {task reference or "none"}
- 共用文件: consensus.md 中的 {specific items}

## 实现步骤
1. {step 1}
2. {step 2}
3. {step 3}

## 涉及文件
- {file path} ({新增/修改})

## 验证
参照 verify-{X}-{Y}.md

## 并行说明
{X 相同的 task 可以并行开发，不同 project 的 task 天然独立}
```

### 2.10 06-plans/spec-{NNN}-{name}/spec-test.md

```markdown
# Spec-{NNN} E2E 验证路线

## 概述
按步骤执行完整故事线 E2E 验证。

## 前置条件
- 前端: localhost:{port} 已启动
- 后端: localhost:{port} 已启动
- DB: {连接信息}
- 测试数据: {准备方式}

## 执行步骤

### Step 1: {验证标题}
```bash
{命令}
```
**预期**: {expected result}
**截图**: 保存为 step-1.png

### Step 2: {验证标题}
...

## 通过标准
- [ ] 所有 Step 执行成功
- [ ] 截图证据完整
- [ ] DB 数据符合预期
- [ ] 无控制台错误
```

### 2.11 07-execution/spec-{NNN}-{name}/verify-results/verify-{X}-{Y}.md

```markdown
# Verify-{X}-{Y} 执行结果

## 状态: ✅ PASS | ❌ FAIL
## 执行时间: {ISO timestamp}
## 执行次数: {N} / 3

## 证据

### 测试输出
```
{paste test command output}
```

### 截图
![Step N](screenshots/step-{N}.png)

### DB 验证
```sql
{query and result}
```

## 修复记录（如有）
### 修复 1: {timestamp}
- 问题: {what failed}
- 原因: {why}
- 修复: {what changed}
- 结果: {pass/fail after fix}
```

### 2.12 07-execution/spec-{NNN}-{name}/fix-log.md

```markdown
# Fix Log — Spec-{NNN}

## Task-{X}-{Y}

### Fix Attempt 1 — {timestamp}
- **Verify**: verify-{X}-{Y}
- **Failure**: {error description}
- **Root Cause**: {analysis}
- **Fix Applied**: {code change description}
- **Result**: PASS / FAIL

### Fix Attempt 2 — {timestamp}
...
```

### 2.13 08-reports/failure-{timestamp}.md

```markdown
# 失败报告

## 基本信息
- **时间**: {ISO timestamp}
- **Spec**: spec-{NNN}-{name}
- **Task**: task-{X}-{Y}-{project}-{role}
- **Verify**: verify-{X}-{Y}
- **重试次数**: 3/3

## 失败详情
### 错误信息
```
{exact error output}
```

### 失败分析
{detailed root cause analysis}

## 已尝试的修复
1. {fix 1}: {result}
2. {fix 2}: {result}
3. {fix 3}: {result}

## 现场保留
- 代码变更: `git diff` 摘要如下
- 日志路径: {paths}
- 截图路径: {paths}

## 建议的人工干预方案
{suggestions for the user}

## Git Diff 摘要
```
{relevant diff}
```
```

### 2.14 09-ship/summary.md

```markdown
# {Feature 标题}

## 功能概括
{one paragraph}

## 实现内容

### {Module A}
- {description}
- 涉及文件: {files}

### {Module B}
- {description}
- 涉及文件: {files}

## 用户故事
- ✅ {story 1}
- ✅ {story 2}

## DB Schema 变更
| 操作 | 表名 | 变更内容 |
|------|------|---------|

## 核心实现
### 技术决策
- {decision}: {reason}

### 约定
- {convention}

## E2E 验证结果
| Spec | 状态 | 详情路径 |
|------|------|---------|
| spec-001 | ✅ | .octopus/xzf/{branch}/07-execution/spec-001/ |
```

## 3. Git 跟踪约定

- `.octopus/xzf/` 目录下所有文件均纳入 git 跟踪
- 不修改项目 `.gitignore`
- Agent 文件位于 `packages/core-pack/agents/`，通过 resource 模块安装到 workspace
- 每个分支有独立的 `{branch}/` 子目录，互不干扰
