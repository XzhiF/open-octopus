# Octopus — Loop Engineering 平台

> **定位**: AI 工作流编排 + 多项目隔离 + 角色/技能资产库，实现 Loop Engineering 闭环
> **版本**: v1.0.0
> **源码**: https://github.com/XzhiF/octopus

---

## 项目概述

Octopus 是 TypeScript monorepo 平台，包含 7 个包，围绕 **Loop Engineering** 理念构建——让 AI Agent 在隔离的多项目环境中，通过可编排的工作流持续迭代。

### 五大核心能力

| 能力 | 说明 |
|------|------|
| **Workflow Engine** | 7 种执行器 + 4 种编排模式（chain/DAG/swarm/dynamic），YAML 定义，支持变量池、Auto Answers 无人值守 |
| **Workspace 隔离** | 多项目 git worktree 并行，独立端口/DB/进程，prod 模式完全隔离 |
| **角色库 (Agent Registry)** | agency-agents-zh 30+ 预置角色 + 自定义角色，Swarm Router 动态选择 |
| **Skill 库** | 5步创建流程 + 按需查询 + 验证，MCP YAML 注册表集成 |
| **无人值守** | Auto Answers + Notify 子系统 + Hooks 生命周期，工作流可 24/7 运行 |

---

## 源码结构

```
octopus/
├── packages/
│   ├── shared/          ← @octopus/shared (Zod schemas + VarPool + config + manifest + repo-ops)
│   ├── providers/       ← @octopus/providers (AI Provider 抽象层，Claude SDK 集成)
│   ├── cli/             ← octopus (Commander.js CLI — init/setup/upgrade/version/repos/workflow/workspace)
│   ├── engine/          ← @octopus/engine (7 executors + harness + WorkflowEngine + SQLite + JSONL)
│   ├── server/          ← @octopus/server (Hono REST API + SSE + WebSocket)
│   ├── web-app/         ← @octopus/web-app (Next.js 前端 + API client)
│   └── core-pack/       ← @octopus/core-pack (skills/agents/scripts/templates/presets/config)
├── scripts/             ← 开发工具脚本 (dev.mjs, prod.mjs, branch-port.mjs, kill-port.mjs)
├── pnpm-workspace.yaml
├── package.json         ← root monorepo config + version
├── tsconfig.base.json
├── vitest.workspace.ts
└── CLAUDE.md
```

### 包间依赖关系

```
shared ← (无依赖)
providers ← shared
cli ← shared + engine + core-pack
engine ← shared + providers
server ← shared + engine + core-pack + providers
web-app ← shared (类型引用)
core-pack ← (无依赖，纯数据资源)
```

---

## Workflow Engine

YAML 定义工作流，**7 种节点执行器 + 4 种编排模式**。

### 7 种执行器

| 执行器 | 说明 |
|--------|------|
| **BashExecutor** | 执行 shell 命令 |
| **PythonExecutor** | 执行 Python 脚本 |
| **AgentExecutor** | 调用 AI agent（支持子代理委派） |
| **ConditionExecutor** | 条件分支 |
| **ApprovalExecutor** | 人工审批（支持 Auto Answers） |
| **LoopExecutor** | 循环迭代 |
| **SwarmExecutor** | 多智能体协作（review/debate/dispatch/dynamic） |

### Swarm 模式（多智能体协作）

Swarm 节点将复杂任务分配给多个 AI 专家协作完成：

| 模式 | 策略 | 轮数 | 适用场景 |
|------|------|------|---------|
| **review** | Discussion | 1 轮 | 代码审查、安全审计 — 各专家并行一次，Host 综合 |
| **debate** | Discussion | N 轮 | 技术决策、方案比选 — 多轮讨论 + 共识检测，达标提前终止 |
| **dispatch** | Dispatch | 1 轮 | 功能实现 — DAG 依赖调度，上游完成后下游才执行 |
| **swarm** | 动态路由 | 由 Router 决定 | 智能模式 — LLM 自动选择模式和专家 |

**关键组件：**
- **Host Agent** — 综合专家输出，退化链 opus→sonnet→拼接
- **共识检测** — debate 模式下每轮评估 consensus_score，≥ threshold 提前退出
- **DAG 调度** — dispatch 模式下 Kahn 拓扑排序 + 环检测，层级内并行
- **动态路由** — SwarmRouter 从角色库自动选 2-5 专家 + 决定编排模式
- **上下文管理** — 滑动窗口 + 渐进压缩 + Token 预算安全阀
- **Checkpoint** — 每轮保存状态，中断后可恢复

### 变量引用语法

| 语法 | 含义 |
|------|------|
| `$vars.xxx` | 全局变量池 |
| `$node-id.output.xxx` | 前序节点输出 |
| `$last_output` | 当前节点输出 |
| `$iteration` | loop 当前迭代 (1-based) |

### Auto Answers

全局 + 节点级两层预设答案，编译为 prompt 指令文本，注入到 agent 节点 prompt。

---

## Workspace 多项目隔离

支持在多个 git worktree 中并行开发，每个 worktree 拥有独立的端口、数据库和进程。

### 三种隔离模式

| 模式 | Server 端口 | Web 端口 | 数据库 | dist/ | Web-app |
|------|------------|---------|--------|-------|---------|
| **dev (主仓库)** | 3001 | 3000 | `octopus.db` | 源码 `dist/` | `next dev` 实时编译 |
| **dev (worktree)** | 3100-3598 (hash) | +1 | `octopus-{branch}.db` | worktree `dist/` | `next dev` worktree 目录 |
| **prod** | 3099 | 3098 | `octopus-prod.db` | `~/.octopus/prod/` 稳定副本 | `next start` 预构建产物 |

### 快速开始

```bash
pnpm dev                    # 主仓库日常开发
pnpm prod                   # 生产模式（用 Octopus 迭代自身）
pnpm port                   # 查看端口分配

# Worktree 并行开发
git worktree add .worktrees/feat-xxx octopus-feat-xxx
cd .worktrees/feat-xxx && pnpm install && pnpm build && pnpm dev
```

### 环境变量

| 变量 | 作用 | 默认值 | 设置方 |
|------|------|--------|--------|
| `PORT` | Server HTTP 端口 | 主仓库 3001 / worktree hash | dev.mjs |
| `OCTOPUS_DB_PATH` | SQLite 数据库路径 | `~/.octopus/db/octopus.db` | dev.mjs |
| `NEXT_PUBLIC_SERVER_URL` | Web-app 后端地址 | `http://localhost:3001` | dev.mjs |
| `OCTOPUS_SERVER_URL` | CLI 连接地址 | `http://localhost:3001` | 用户 shell |

### 详细设计

参见 [docs/research/multi-instance-isolation.md](docs/research/multi-instance-isolation.md)

---

## CLI 命令

```bash
octopus init <dir> --org <org>         # 初始化 (安装 Skills + Agents + org 配置)
octopus version                        # 版本信息 (v1.0.0)
octopus setup [--org] [--dry-run] [--force]  # 初始化/更新 ~/.octopus/{org}/
octopus upgrade [--org]                # 升级 (检查版本并触发 setup)
octopus repos update [--org] [--scan-dirs] [--clone-missing] [--ai-desc]
octopus repos pull [PROJECTS...] [--org] [--branch]
octopus repos clone PROJECT [--org] [--branch]
octopus repos rebuild-index [--org] [--ai-desc] [--scan-dirs]
octopus workflow run <yaml-path> [--org] [--model] [--engine]
octopus workflow validate <yaml-path>
octopus workspace list [--org]         # 列出工作空间
octopus workspace create <name> [--org]  # 创建工作空间
octopus workspace get <id>             # 查看工作空间详情
octopus workspace delete <id>          # 删除工作空间
octopus workspace tree <id>            # 显示执行树
```

---

## Skill & Agent

核心 Skill: `octo-skill-creator`(创建)、`octo-skill-evolution`(经验记录)、`octo-swarm-dev`(Swarm 开发助手)、`octo-workflow-dev`(工作流开发)。

Agent 角色库通过 `octopus setup` 安装 30+ 预置角色（engineering/design/testing），Swarm Router 从中动态选择专家。MCP 服务注册表位于 `~/.octopus/{org}/mcp/`。

---

## 版本管理

- **单一版本来源** — root package.json 的 version 字段 ("1.0.0")
- 所有子包版本与 root 一致 (workspace:* 协议)
- shared/src/version.ts 是代码内唯一版本定义点

---

## 命名规范

- Skill 前缀: `"octo-"` | Agent 前缀: 描述性名称
- CLI: `octopus` | 核心 Skill: `octo-skill-creator`
- MCP YAML 注册表: `mcp_{env}.yaml`
- 包名: `@octopus/{name}`; CLI 包名: `octopus`

---

## 开发与测试

```bash
pnpm install                # 安装依赖
pnpm build                  # 构建所有包
pnpm dev                    # 启动开发环境（自动检测主仓库/worktree）
pnpm prod                   # 生产模式（完全隔离）
pnpm port                   # 查看当前端口分配
pnpm test                   # 运行测试 (Vitest)
pnpm test:watch             # 监听模式
octopus version             # CLI 验证 (预期 v1.0.0)
octopus setup --org xzf     # org 级 setup
octopus workflow run ./dev-flow.yaml  # 执行工作流
```

---

<!-- superpowers-zh:begin (do not edit between these markers) -->
# Superpowers-ZH 中文增强版

本项目已安装 superpowers-zh 技能框架（20 个 skills）。

## 核心规则

1. **收到任务时，先检查是否有匹配的 skill** — 哪怕只有 1% 的可能性也要检查
2. **设计先于编码** — 收到功能需求时，先用 brainstorming skill 做需求分析
3. **测试先于实现** — 写代码前先写测试（TDD）
4. **验证先于完成** — 声称完成前必须运行验证命令

## 可用 Skills

Skills 位于 `.claude/skills/` 目录，每个 skill 有独立的 `SKILL.md` 文件。

- **brainstorming**: 在任何创造性工作之前必须使用此技能——创建功能、构建组件、添加功能或修改行为。在实现之前先探索用户意图、需求和设计。
- **chinese-code-review**: 中文代码审查规范——在保持专业严谨的同时，用符合国内团队文化的方式给出有效反馈
- **chinese-commit-conventions**: 中文 Git 提交规范 — 适配国内团队的 commit message 规范和 changelog 自动化
- **chinese-documentation**: 中文技术文档写作规范——排版、术语、结构一步到位，告别机翻味
- **chinese-git-workflow**: 适配国内 Git 平台和团队习惯的工作流规范——Gitee、Coding、极狐 GitLab、CNB 全覆盖
- **dispatching-parallel-agents**: 当面对 2 个以上可以独立进行、无共享状态或顺序依赖的任务时使用
- **executing-plans**: 当你有一份书面实现计划需要在单独的会话中执行，并设有审查检查点时使用
- **finishing-a-development-branch**: 当实现完成、所有测试通过、需要决定如何集成工作时使用——通过提供合并、PR 或清理等结构化选项来引导开发工作的收尾
- **mcp-builder**: MCP 服务器构建方法论 — 系统化构建生产级 MCP 工具，让 AI 助手连接外部能力
- **receiving-code-review**: 收到代码审查反馈后、实施建议之前使用，尤其当反馈不明确或技术上有疑问时——需要技术严谨性和验证，而非敷衍附和或盲目执行
- **requesting-code-review**: 完成任务、实现重要功能或合并前使用，用于验证工作成果是否符合要求
- **subagent-driven-development**: 当在当前会话中执行包含独立任务的实现计划时使用
- **systematic-debugging**: 遇到任何 bug、测试失败或异常行为时使用，在提出修复方案之前执行
- **test-driven-development**: 在实现任何功能或修复 bug 时使用，在编写实现代码之前
- **using-git-worktrees**: 当需要开始与当前工作区隔离的功能开发或执行实现计划之前使用——创建具有智能目录选择和安全验证的隔离 git 工作树
- **using-superpowers**: 在开始任何对话时使用——确立如何查找和使用技能，要求在任何响应（包括澄清性问题）之前调用 Skill 工具
- **verification-before-completion**: 在宣称工作完成、已修复或测试通过之前使用，在提交或创建 PR 之前——必须运行验证命令并确认输出后才能声称成功；始终用证据支撑断言
- **workflow-runner**: 在 Claude Code / OpenClaw / Cursor 中直接运行 agency-orchestrator YAML 工作流——无需 API key，使用当前会话的 LLM 作为执行引擎。当用户提供 .yaml 工作流文件或要求多角色协作完成任务时触发。
- **writing-plans**: 当你有规格说明或需求用于多步骤任务时使用，在动手写代码之前
- **writing-skills**: 当创建新技能、编辑现有技能或在部署前验证技能是否有效时使用

## 如何使用

当任务匹配某个 skill 时，使用 `Skill` 工具加载对应 skill 并严格遵循其流程。绝不要用 Read 工具读取 SKILL.md 文件。

如果你认为哪怕只有 1% 的可能性某个 skill 适用于你正在做的事情，你必须调用该 skill 检查。
<!-- superpowers-zh:end -->
