# XZF Development Pipeline — 总体设计

> **版本**: v1.0.0-draft
> **日期**: 2026-07-16
> **状态**: 设计中

## 1. 定位

Octopus 系统专有的端到端开发工作流：从 Idea 到 PR/MR 提交，覆盖需求澄清、故事设计、任务拆解、编码实现、验证测试、交付上线全链路。

通过 **Workflow YAML + Skills 套件 + Agent 角色库** 三件套实现，所有资源使用 `octo-xzf-` 前缀，自包含，不依赖外部 skills。

## 2. 核心理念

### 故事驱动迭代

不做宏观设计再一次性实现。每个 spec 是一个完整用户故事线，从简单到复杂排列，逐个实现。每完成一个 spec 都是可交付版本。

### 验证先行

每个 spec 先设计验证方法（如何证明故事走通），再设计实现步骤。TDD 精神贯穿全流程。

### 专家团头脑风暴

6 位专家（架构师、产品经理、测试架构师、前端专家、后端专家、安全专家）通过 swarm debate 模式进行多轮讨论，确保需求完整性和功能闭环。

## 3. 八大阶段

| 阶段 | 名称 | 核心产出 | Octopus 节点类型 |
|------|------|---------|-----------------|
| 0 | 初始化 | 分支目录结构 | `bash` |
| 1 | Idea 输入 | `01-idea.md` | `approval` (用户输入) |
| 2 | 澄清循环 | `02-clarification/questions.md`（含功能、环境、测试、**调研**类问题） | `loop` → `swarm(debate)` + `approval` |
| 3 | 故事总汇 | `03-stories/summary.md` + `technical-guide.md`（含跨项目服务链） | `loop` → `swarm(review)` + `approval` |
| 4 | Spec 设计 | `04-specs/spec-NNN-{name}.md` | `swarm(debate)` + `approval` |
| 5 | 任务计划 | `05-plans/spec-NNN-{name}/` 下多文件 | `loop` → `swarm(dispatch)` |
| 6 | 任务执行 | `06-execution/spec-NNN-{name}/` + 代码变更 | `loop` → `agent` + verify-fix |
| 7 | Ship 交付 | `08-ship/summary.md` + PR/MR | `agent` + `bash` |

### 阶段间依赖

```
init → idea → clarification-loop → stories-loop → spec-design → task-planning → execution → ship
                                                                        ↑
                                                                  on_failure → notify → human-intervention → resume
```

### 循环退出机制

所有 `loop` + `approval` 节点**不使用 auto_answers**，要求用户深度参与。循环退出由用户显式驱动：

- 用户输入 `"进入下一阶段"` / `"继续讨论"` 等意图信号
- Swarm 节点检测用户意图，输出信号标记（如 `exit_signal: true`）
- Condition 节点检查信号标记，决定是否退出循环

这确保每个阶段的转换都经过用户明确确认，而非预设答案自动跳过。

### 澄清阶段问题分类

Stage 2 的 `questions.md` 按类别组织问题，**调研（research）是问题类别之一**，不单独设阶段：

| 类别 | 说明 |
|------|------|
| 功能 | 核心功能需求、边界条件 |
| 环境 | 运行环境、部署目标 |
| 测试 | 验证方法、测试要求 |
| **调研** | 需探索的代码库区域、技术选型研究、第三方库评估 |

调研类问题的产出直接写入 `questions.md`，与其他类别问题统一管理和回答。

## 4. 资源清单

### Agent 角色（6 个）

安装位置：`packages/core-pack/agents/octo-xzf-*.md`
运行时引用：`.claude/agents/octo-xzf-*.md`（通过 resource 模块安装）

| 角色 | 文件名 | 参考来源 |
|------|--------|---------|
| 资深架构师 | `octo-xzf-architect.md` | agency-agents-zh `engineering-software-architect` |
| 产品经理 | `octo-xzf-product-manager.md` | agency-agents-zh `product-manager` |
| 测试架构师 | `octo-xzf-test-architect.md` | 新创建（agency-agents-zh 无精确对应） |
| 前端专家 | `octo-xzf-frontend-expert.md` | agency-agents-zh `engineering-frontend-developer` |
| 后端专家 | `octo-xzf-backend-expert.md` | agency-agents-zh `engineering-backend-architect` |
| 安全专家 | `octo-xzf-security-expert.md` | agency-agents-zh `security-architect` |

### Skill 套件（6 个）

安装位置：`packages/core-pack/skills/octo-xzf-*/SKILL.md`
运行时引用：通过 swarm 节点的 `skills` 字段或 agent 节点的 `skills` 字段加载

| Skill | 核心职责 | 使用阶段 |
|-------|---------|---------|
| `octo-xzf-clarify` | 头脑风暴 → 问题清单（含调研类）→ 环境/测试要求澄清 | Stage 2 |
| `octo-xzf-story-writer` | 需求 → 完整用户故事地图 + 技术指导文档 | Stage 3 |
| `octo-xzf-spec-designer` | 故事线拆分 → 验证优先 → 操作流程 → UI wireframe | Stage 4 |
| `octo-xzf-task-planner` | consensus + verify + task + spec-test 文档生成 | Stage 5 |
| `octo-xzf-executor` | task 实现 → verify-fix 循环 → E2E 验证 → 失败报告 | Stage 6 |
| `octo-xzf-ship` | 检测 remote 类型 → 生成 PR/MR summary → 提交 | Stage 7 |

### Workspace 资源

| 文件 | 说明 | 生成阶段 |
|------|------|---------|
| `workspace-topology.md` | 多仓库拓扑结构：项目列表、服务依赖、端口映射、通信链路 | Stage 0 (init) |

## 5. 输出目录结构

```
.octopus/xzf/{branch}/
├── workspace-topology.md              # 多仓库拓扑（init 阶段扫描生成）
├── 01-idea.md                         # 原始 idea
├── 02-clarification/
│   └── questions.md                   # 澄清问题清单（功能/环境/测试/调研四类）
├── 03-stories/
│   ├── summary.md                     # 全部故事线总汇
│   └── technical-guide.md             # 技术指导文档（含测试环境）
├── 04-specs/
│   ├── spec-001-user-login.md         # Spec DSL 格式（含 PROJECT 标签）
│   ├── spec-002-dashboard.md
│   └── spec-003-settings.md
├── 05-plans/
│   └── spec-001-user-login/           # 每个 spec 多文件，需要子目录
│       ├── consensus.md               # 总纲领
│       ├── verify-1-1.md              # 验证方法
│       ├── verify-1-2.md
│       ├── task-1-1-backend.md        # 任务分配（按项目 scope）
│       ├── task-1-2-frontend.md
│       └── spec-test.md              # 完整 E2E 验证路线
├── 06-execution/
│   └── spec-001-user-login/
│       ├── verify-results/            # 验证结果 + 截图
│       └── fix-log.md                 # 修复日志
├── 07-reports/
│   └── failure-{timestamp}.md         # 失败报告
└── 08-ship/
    └── summary.md                     # PR/MR body
```

**关键约定**：
- `{branch}` 取当前 git worktree 分支名
- 所有文件 git 跟踪，不修改 `.gitignore`
- Spec 文件扁平化：`04-specs/spec-NNN-{name}.md`
- Plans/Execution 保留子目录：每个 spec 产出多个文件
- `workspace-topology.md` 在 Stage 0 扫描生成，后续阶段只读引用

### 多仓库 Workspace 支持

Octopus workspace 聚合多个 git 项目，不是单一代码库。典型场景：

```
workspace: octopus-fullstack
├── project-web/       (Next.js 前端)
├── project-gateway/   (API 网关)
├── project-auth/      (认证微服务)
└── project-db/        (数据库迁移)
```

**Init 阶段扫描**生成 `workspace-topology.md`：

```markdown
# Workspace Topology

## Projects
| Project | Path | Tech Stack | Port |
|---------|------|------------|------|
| project-web | ./web | Next.js 14 | 3000 |
| project-gateway | ./gateway | Hono | 3001 |
| project-auth | ./auth | Fastify | 3002 |

## Service Chain
project-web → HTTP → project-gateway → gRPC → project-auth
project-auth → TCP → project-db
```

**Story 和 Spec 描述跨项目服务链**：

```yaml
# spec-001-user-login.md
steps:
  - step: 1
    PROJECT: project-web
    action: 用户点击登录按钮，发送 POST /api/login
  - step: 2
    PROJECT: project-gateway
    action: 路由转发到 auth 服务，验证 rate limit
  - step: 3
    PROJECT: project-auth
    action: 验证凭证，生成 JWT，返回 200
```

**Task 按项目 scope 拆分**，但关联到统一 story：

```
task-1-1-frontend.md  → PROJECT: project-web
task-1-2-gateway.md   → PROJECT: project-gateway
task-1-3-auth.md      → PROJECT: project-auth
```

## 6. 代码变更

SwarmExecutor 的 ExpertDef 不支持 `skills` 字段。需要扩展 4 个注入点：

1. `ExpertDefSchema` — 添加 `skills` 字段
2. `collectFromProvider()` — 接受并传递 `skills` 参数
3. `llmCall` 闭包 — 转发 `skills`
4. `SwarmCoordinator.runExpert()` — 从 `expert.skills` 传入

详细设计见 [ExpertDef Skills 扩展](./01-expertdef-skills-extension.md)

## 7. 错误处理与人工干预

### 执行阶段失败流程

```
task 执行 → verify 失败 → fix-loop (max 3) → 仍失败?
  → 生成 failure-{timestamp}.md 报告
  → notify xzf_hermes 群
  → approval 节点等待人工干预
  → 用户输入修复方案或 "skip"
  → 继续或跳过
```

### 通知渠道

通过 Octopus notify 子系统 → hermes CLI → `xzf_hermes` 群

通知内容包含：
- 失败的 spec/task 标识
- 失败原因摘要
- 失败报告文件路径

## 8. Ship 交付

### Remote 检测

```bash
REMOTE_URL=$(git remote get-url origin)
# GitHub: github.com → gh pr create
# GitLab: gitlab.com / 自建 → glab mr create
```

### PR/MR Body 结构

```markdown
## 功能概括
[本次 feature 核心功能一句话]

## 实现内容
### 模块 A
[简要描述]
### 模块 B
[简要描述]

## 用户故事
- 故事 1: [描述]
- 故事 2: [描述]

## DB Schema 变更
[如有]

## 核心实现
[关键设计决策和约定]

## E2E 验证
[验证结果引导，截图/报告路径]
```

## 9. 详细设计索引

| 文档 | 内容 |
|------|------|
| [01-expertdef-skills-extension.md](./01-expertdef-skills-extension.md) | ExpertDef skills 字段扩展代码设计 |
| [02-agents-design.md](./02-agents-design.md) | 6 个 Agent 角色详细设计 |
| [03-skills-design.md](./03-skills-design.md) | 6 个 Skill 详细设计 |
| [04-workflow-yaml.md](./04-workflow-yaml.md) | 完整 Workflow YAML 设计 |
| [05-spec-dsl.md](./05-spec-dsl.md) | Spec DSL 格式规范 |
| [06-output-structure.md](./06-output-structure.md) | 各阶段产出文档模板 |
