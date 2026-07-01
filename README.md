# Open Octopus -(之所以 Open 是因为觉得加了B格高)

[English](README_EN.md) | **中文**

> AI 工作流编排 + 多项目隔离 + 角色/技能资产库

> ⚠️ **开发阶段**：Octopus 目前仍处于积极开发中，许多功能正在完善和通用化。API 和工作流格式可能会变化。欢迎试用和反馈，但暂不建议用于生产环境。

> 💬 这是一个相貌平平、资质一般的老程序员，认认真真做的第一个开源项目。整个项目诞生于 vibe coding —— 从工作中遇到的一个个痛点出发，借助 AI 编程想办法解决，然后借鉴前辈的思路，按自己的理解一步步搭建出来。设计不够精巧，核心功能都是真实场景里逼出来的。希望能帮到同样在这条路上摸索的朋友。

---

## 演变过程

从一个痛点出发，一步步长出来的平台：

```
SKILL Helper
  └→ 目标：创建企业级 SKILL

Dev Workspace
  └→ 聚合多项目 Git Worktree 并行开发

Workflow
  └→ 长任务无人值守，多节点分工（Agent / SubAgent / Skills）

Agent Swarm
  └→ 专家团并行协作，效率倍增

Remote: Notify & Watch & Exec
  └→ 借助 Hermes + Telegram 实现通知、监控、远程执行

Scheduler
  └→ 自循环初步（bug-hunter / research-2-pr / idea-2-pr）

Orchestrator Agent
  └→ 全局 Agent + SKILL + 知识库 + 分身 + 记忆

Memory
  └→ Workspace 归档，工作流执行知识注入，Orchestrator Agent 自动 SKILL 提升
```

**… 规划 ↓**

```
Agent Refine
  └→ 分身提炼：针对特定领域，炼化日积月累的资产生产分身，
     或直接生产新分身并令其修炼功法

Agent Workflow
  └→ Orchestrator Agent / 分身 → 领域级 Agent（自身 SKILL + 记忆），
     增强节点类型，融入工作流修炼

Octopus Repository
  └→ Workflow / SKILL / 分身的共享仓库，上传、下载、分享
```

**… 未来考虑 ↓**

```
Sandbox
  └→ 隔离环境，重点优化 E2E 测试，打通全链路

Hub-and-Spoke
  └→ 架构演变：配置集中管理，统筹调度，不再局限于单机
```

---

## 简介

Octopus 的目标是一个 **Loop Engineering** 开发平台，让 AI Agent 在隔离的多项目环境中，通过可编排的工作流持续迭代。

核心理念：**AI 不是一次性工具，而是一个可以持续循环运转的工程系统。**

- **Scheduler** — 工作流按 cron 调度或手动触发，24/7 运行
- **Orchestrator** — YAML 定义工作流，7 种执行器编排复杂任务
- **Workflow Engine** — 支持 Chain 链式调用、DAG 并行调度、Swarm 多智能体协作、Dynamic 动态路由
- **Agent 角色生态** — 集成 agency-agents-zh 266 个预置角色，支持自定义角色，Swarm Router 动态选择专家
- **Workspace Isolation** — 多项目 git worktree 隔离，并行不干扰

---

## 前置依赖

| 工具 | 用途 | 安装 |
|------|------|------|
| **Node.js** ≥ 20 | 运行时 | https://nodejs.org |
| **pnpm** ≥ 9 | 包管理 | `npm install -g pnpm` |
| **GitHub CLI** (`gh`) | 仓库操作、PR 管理 | https://cli.github.com |
| **Claude Code** | AI 执行引擎 | https://docs.anthropic.com/en/docs/claude-code |
| **Hermes Agent** | 通知推送（Telegram/Slack/Webhook） | — |
| **Git** | 版本控制 + worktree | https://git-scm.com |

---

## 安装

```bash
# 1. 克隆仓库
git clone git@github.com:XzhiF/octopus.git
cd octopus

# 2. 安装依赖 + 构建
pnpm install
pnpm build

# 3. 注册全局命令（软链接，推荐开发时使用）

# Linux / macOS
ln -sf $(pwd)/packages/cli/dist/index.js /usr/local/bin/octopus

# Windows (管理员 PowerShell)
New-Item -ItemType SymbolicLink -Path "$env:USERPROFILE\AppData\Local\Microsoft\WindowsApps\octopus" -Target "$PWD\packages\cli\dist\index.js"

# 4. 验证
octopus version              # 预期输出: octopus v1.0.0
```

---

## 快速开始

### 1. 初始化组织

```bash
octopus setup --org xzf
```

这会在 `~/.octopus/orgs/xzf/` 下创建：

```
~/.octopus/orgs/xzf/
├── repos/
│   ├── manifest.md      ← 项目清单（你编辑这个）
│   └── index.md         ← 自动生成（勿手动编辑）
├── mcp/
│   └── mcp_prod.yaml    ← MCP 服务注册表
├── agents/              ← 组织级 Agent 定义
├── skills/              ← 组织级 Skill
└── workflows/           ← 组织级工作流
```

### 2. 编辑项目清单

编辑 `~/.octopus/orgs/xzf/repos/manifest.md`，添加你的项目：

```markdown
## my-team

- backend-api git@github.com:my-team/backend-api.git [main] {java, spring-boot}
- web-frontend git@github.com:my-team/web-frontend.git [main] {vue3, nuxt}
- shared-lib git@github.com:my-team/shared-lib.git [main] {typescript}
```

格式：`- 项目名 git地址 [分支] {标签1, 标签2}`

### 3. 同步项目

```bash
octopus repos sync --org xzf
```

这会：
1. 克隆 manifest 中所有缺失的项目到 `~/.octopus/orgs/xzf/repos/projects/`
2. 拉取所有项目的最新代码
3. 重建 `index.md`（项目索引，供 Agent 搜索）

### 4. 同步工作流

```bash
octopus workflow sync --org xzf
```

将内置工作流模板同步到 `~/.octopus/orgs/xzf/workflows/`。

### 5. 启动服务

```bash
pnpm dev
```

启动后访问：
- **Web UI**: http://localhost:3000
- **Server API**: http://localhost:3001

### 6. 在 Web UI 中操作

打开 http://localhost:3000，你可以：

1. **创建工作空间** — 在左侧导航进入 Workspace，点击 "新建"，输入名称
2. **选择工作流** — 在工作空间中选择要执行的工作流 YAML
3. **执行工作流** — 点击 "运行"，实时查看节点执行状态、专家讨论、日志输出
4. **查看结果** — 执行完成后查看 synthesis 输出、共识分数、执行树

---

## 项目架构

```
octopus/
├── packages/
│   ├── shared/          ← @octopus/shared (Zod schemas + VarPool + config)
│   ├── providers/       ← @octopus/providers (Claude SDK 封装 + Token 追踪)
│   ├── cli/             ← octopus (Commander.js CLI)
│   ├── engine/          ← @octopus/engine (7 执行器 + WorkflowEngine)
│   ├── server/          ← @octopus/server (Hono REST API + SSE)
│   ├── web-app/         ← @octopus/web-app (Next.js 前端)
│   └── core-pack/       ← @octopus/core-pack (skills/agents/templates)
├── scripts/             ← 开发工具 (dev.mjs, prod.mjs)
├── pnpm-workspace.yaml
└── CLAUDE.md
```

```
包依赖：
shared ← providers ← engine ← cli/server
                shared ← cli/server/web-app
                core-pack ← cli/server
```

---

## 特色功能

### Workflow Engine — 7 种执行器

| 执行器 | 说明 |
|--------|------|
| **BashExecutor** | 执行 shell 命令 |
| **PythonExecutor** | 执行 Python 脚本 |
| **AgentExecutor** | 调用 AI agent，支持子代理委派 |
| **ConditionExecutor** | 条件分支 |
| **ApprovalExecutor** | 人工审批（支持 Auto Answers 无人值守） |
| **LoopExecutor** | 循环迭代 |
| **SwarmExecutor** | 多智能体协作（review/debate/dispatch/dynamic） |

### Swarm — 多智能体协作

一个 YAML 节点即可编排多个 AI 专家协作：

| 模式 | 说明 | 适用场景 |
|------|------|---------|
| **review** | 各专家并行一次，Host 综合 | 代码审查、安全审计 |
| **debate** | 多轮讨论 + 共识检测，达标提前终止 | 技术决策、方案比选 |
| **dispatch** | DAG 依赖调度，层级内并行 | 功能实现、多步协作 |
| **swarm** | LLM 自动选择模式和专家 | 智能路由、开放话题 |

```yaml
# 示例：3 专家辩论技术选型
- id: decision
  type: swarm
  topic: "TypeScript vs Go，15 人团队后端 API 服务选型"
  mode: debate
  rounds: 3
  consensus_threshold: 0.7
  experts:
    - role: typescript-advocate
      prompt: "论证 TypeScript/Node.js 的优势"
    - role: go-advocate
      prompt: "论证 Go 的优势"
    - role: platform-engineer
      prompt: "从中立角度评估工程实际影响"
```

### Workspace 多项目隔离

三种完全隔离的开发模式，可同时运行：

| 模式 | 命令 | Server | Web | 数据库 | 场景 |
|------|------|--------|-----|--------|------|
| **dev (主仓库)** | `pnpm dev` | 3001 | 3000 | `octopus.db` | 日常开发 |
| **dev (worktree)** | `pnpm dev` | hash | +1 | `octopus-{branch}.db` | 并行分支 |
| **prod** | `pnpm prod` | 3099 | 3098 | `octopus-prod.db` | 用 Octopus 迭代自身 |

每个 worktree 自动分配独立端口和数据库，互不干扰。

### 无人值守运行

- **Auto Answers** — 全局 + 节点级预设答案，AI 遇到确认时自动回答
- **Notify 子系统** — 工作流生命周期事件推送（Telegram/Slack/Webhook）
- **Hooks** — `on_workflow_failure` / `on_complete` / `on_node_success` 等生命周期钩子
- **Checkpoint** — Swarm 每轮保存状态，中断后可恢复

---

## CLI 命令速查

> 工作空间创建、工作流执行等操作主要通过 **Web UI**（`pnpm dev` → http://localhost:3000）完成。
> CLI 命令用于环境配置和项目同步。

```bash
# 初始化与配置
octopus setup --org xzf                  # 初始化/更新 ~/.octopus/orgs/xzf/
octopus upgrade --org xzf                # 升级（检查版本并触发 setup）

# 项目管理
octopus repos sync --org xzf             # 一键同步：克隆 + 拉取 + 重建索引
octopus repos update --org xzf           # 扫描 manifest 更新 index.md
octopus repos clone my-project --org xzf # 克隆指定项目
octopus repos pull --org xzf             # 拉取所有项目最新代码

# 工作流
octopus workflow sync --org xzf          # 同步内置工作流模板
octopus workflow run <yaml> --org xzf    # 执行工作流
octopus workflow validate <yaml>         # 验证 YAML 格式
octopus workflow list --org xzf          # 列出可用工作流

# 其他
octopus version                          # 版本信息
octopus init . --org xzf                 # 初始化当前目录
```

---

## 开发

```bash
pnpm install                # 安装依赖
pnpm build                  # 构建所有包
pnpm dev                    # 启动开发环境
pnpm prod                   # 生产模式（完全隔离）
pnpm port                   # 查看端口分配
pnpm test                   # 运行测试 (Vitest)
```

---

## 致谢

Octopus 借鉴了以下优秀项目的思路和实现：

- **[Archon](https://github.com/coleam00/Archon)** — 工作流编排的核心理念和部分基础实现。特别感谢作者 Cole Medin 的开源贡献。
- **[superpowers-zh](https://github.com/jnMetaCode/superpowers-zh)** — 中文增强技能框架，为 Octopus 提供了 20+ 开箱即用的 Skill。
- **[agency-agents-zh](https://github.com/jnMetaCode/agency-agents-zh)** — 中文 Agent 角色库，30+ 预置角色供 Swarm Router 动态选择。

感谢这些作者提供了这么好的开源项目。

---

## 许可证

MIT License — 详见 [LICENSE](LICENSE) 文件。
