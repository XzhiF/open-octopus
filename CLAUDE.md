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
│   └── core-pack/       ← @octopus/core-pack (skills/agents/workflows/scripts/templates/config)
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
| **moa** | Fan-out + Aggregator | 0-5 轮 | Mixture of Agents — 多专家并行 + 聚合器综合输出 |

**关键组件：**
- **Host Agent** — 综合专家输出，退化链 opus→sonnet→拼接
- **共识检测** — debate 模式下每轮评估 consensus_score，≥ threshold 提前退出
- **DAG 调度** — dispatch 模式下 Kahn 拓扑排序 + 环检测，层级内并行
- **动态路由** — SwarmRouter 从角色库自动选 2-5 专家 + 决定编排模式
- **上下文管理** — 滑动窗口 + 渐进压缩 + Token 预算安全阀
- **Checkpoint** — 每轮保存状态，中断后可恢复
- **Per-Expert Engine** — 每个专家可设 `engine: claude|pi`，实现跨 provider MOA

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

---

---

## 可用资源 (Octopus 资源库)
<!-- octopus-resources -->

### Skills
- test-skill (built-in)

### 使用方式
- 搜索更多: 使用 octo-resource-manager skill
- 浏览全部: octopus resource list

<!-- /octopus-resources -->

## Agent skills

### Issue tracker

Local markdown — issues live as files under `.scratch/<feature>/` in this repo. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary: needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix. See `docs/agents/triage-labels.md`.

### Domain docs

Multi-context — root `CONTEXT-MAP.md` pointing to per-package `CONTEXT.md` files. See `docs/agents/domain.md`.
