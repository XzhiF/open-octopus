---
name: octo-dev-copilot
description: octopus 微服务生态编码助手，管理多仓库工作空间、跨项目模式搜索、接口发现、代码模板生成和影响分析
category: coding-assistant
tags: [octopus, 微服务, 多仓库, 编码助手, 模式搜索, 接口发现, 模板生成, 影响分析]
---

# octopus 微服务编码助手

## Overview

octopus 微服务生态编码助手，整合 6 大能力辅助日常开发：
1. **多仓库工作空间管理** — 通过 git worktree 管理多个 repos，开发操作不影响主仓库
2. **跨项目模式搜索** — 在所有 repos 中搜索可复用的代码实现
3. **API 接口契约发现** — 定位服务接口定义、端点与消费方
4. **代码模板生成** — 按项目分层约定生成骨架代码
5. **跨服务影响分析** — 追踪共享库/接口变更的下游影响
6. **上下文感知建议** — 自动推荐相关 repos、工具类、依赖

---

## 目录 — 项目架构速查

### octopus 主仓库（TypeScript monorepo）

```
octopus/
├── packages/
│   ├── shared/          ← @octopus/shared (Zod schemas + VarPool + config + manifest + repo-ops)
│   ├── providers/       ← @octopus/providers (AI Provider 抽象层，Claude SDK 集成)
│   ├── cli/             ← octopus (Commander.js CLI — init/setup/upgrade/repos/workflow)
│   ├── engine/          ← @octopus/engine (6 executors + harness + WorkflowEngine + SQLite + JSONL)
│   ├── server/          ← @octopus/server (Hono REST API + SSE + WebSocket)
│   ├── web-app/         ← @octopus/web-app (Next.js 前端 + API client)
│   └── core-pack/       ← @octopus/core-pack (skills/agents/scripts/templates/presets/config)
├── scripts/             ← 开发工具 (dev.mjs, prod.mjs, branch-port.mjs, kill-port.mjs)
├── pnpm-workspace.yaml
└── package.json         ← root monorepo config + version
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

### core-pack 数据资源结构

```
core-pack/
├── skills/              ← 核心 Skill 定义 (octo-dev-copilot, octo-workflow-dev, ...)
│   └── {skill-name}/
│       ├── SKILL.md     ← 主文件
│       └── scripts/     ← 辅助脚本
├── agents/              ← 核心 Agent 角色 (devil-advocate, vision-analyzer, ...)
├── presets/
│   └── workflows/       ← 预设工作流 YAML + schema 定义
├── templates/           ← 代码/配置模板
├── scripts/             ← 工具脚本 (octopus-mcp-cli 等)
└── config/              ← 默认配置
```

---

## 接口 — 共享抽象与核心模式

### 1. Zod Schema 验证体系（shared）

所有跨包共享的数据结构使用 Zod 定义 schema，确保类型安全 + 运行时验证：
- Workflow YAML schema — 工作流定义验证
- VarPool schema — 变量池类型约束
- Config schema — 配置验证
- Manifest schema — 技能/代理清单验证

### 2. VarPool 变量池（shared → engine）

全局变量池，支持工作流节点间数据传递：
- `$vars.xxx` — 全局变量
- `$node-id.output.xxx` — 前序节点输出
- `$last_output` — 当前节点输出
- `$iteration` — loop 当前迭代 (1-based)

### 3. AI Provider 抽象层（providers）

统一的 AI 服务接口，当前集成 Claude SDK：
- Provider interface — 统一调用契约
- 模型选择策略 — Haiku 4.5 / Sonnet 4.6 / Opus 4.5
- Streaming + tool use 支持

### 4. Workflow Engine 6 执行器（engine）

| 执行器 | 职责 | 关键特性 |
|--------|------|---------|
| BashExecutor | Shell 命令执行 | stdout 捕获、超时、退出码 |
| PythonExecutor | Python 脚本执行 | 独立进程、输出解析 |
| AgentExecutor | AI Agent 编排 | sub-agents、skills 加载、Auto Answers |
| ConditionExecutor | 条件分支 | 表达式求值、多 case 路由 |
| ApprovalExecutor | 人工审批 | 暂停等待、超时策略 |
| LoopExecutor | 循环执行 | 迭代变量、break_when 条件 |

### 5. MCP YAML 注册表（shared + cli）

MCP 服务信息存储在 `~/.octopus/{org}/mcp/mcp_{env}.yaml`，通过 `octopus-mcp-cli` 直连调用：
```bash
octopus-mcp-cli {server名} {tool名} '{params}' --env {env} --org {org}
```

### 6. 多实例隔离（dev.mjs）

主仓库 / worktree / prod 三种模式自动隔离：
- 端口隔离 — 主仓库 3001/3000，worktree hash 端口，prod 3099/3098
- 数据库隔离 — `octopus.db` / `octopus-{branch}.db` / `octopus-prod.db`
- 进程隔离 — 各模式独立进程，互不干扰

---

## 平台参考

平台参考文件存放开发平台特定的模式、约定和检测规则（搜索关键词、分层结构、依赖检测模式等），由各 org 或项目自行维护。

**查找优先级**（高到低）:
1. **项目级**: `{project}/.octopus/code-dev-copilot-rules/*.md`
2. **用户/Org 级**: `~/.octopus/{org}/code-dev-copilot-rules/*.md`

**使用方式**:
- 执行 2-6 节能力时，先检查上述两个目录是否存在 `*.md` 文件
- 存在 → 读取所有 `.md` 文件，根据文件名/内容匹配当前平台（如 `typescript.md`、`java.md`、`go.md`）
- 不存在 → 使用通用代码搜索方法，不做平台特定推断
- 项目级和 org 级同时存在时，项目级优先；冲突的规则以项目级为准

**文件命名约定**: `{platform}.md`（如 `typescript.md`、`java.md`、`go.md`），文件名用于平台匹配。

## 知识参考

Repos 索引: `~/.octopus/{org}/repos/index.md` (org 级)
不可达 → `octopus repos clone {group}/{name} --org {org}`

## Constraints

- 所有代码搜索基于 `~/.octopus/{org}/repos/index.md` 中已克隆的项目
- repowiki 信息仅部分项目可用，无 repowiki 时通过代码搜索替代
- 工作空间操作使用 `node ./scripts/workspace.js --org <org>` 脚本
- 执行 2-6 节能力时，先检查 `.octopus/code-dev-copilot-rules/*.md`（项目级）和 `~/.octopus/{org}/code-dev-copilot-rules/*.md`（org 级）获取平台特定模式，项目级优先
- 影响分析仅覆盖 index.md 中已克隆的项目，未克隆的项目不在分析范围内
- 如平台参考文件不存在，使用通用的代码搜索方法，不做平台特定推断

---

## Output Format

### 1. 多仓库工作空间管理 (git worktree)

用户触发词: "初始化工作空间" / "workspace init" / "创建开发空间"

工作空间通过 git worktree 管理：每个 repo 在 workspace 目录内创建独立 worktree，主仓库保持干净，所有开发操作仅在 worktree 上进行。

**worktree 目录命名规则**: `{group}-{repo}`，如 `xzf-octopus-demo-api-admin`、`xzf-octopus-demo-service-admin`

#### 初始化工作空间

```bash
bash .claude/skills/octo-dev-copilot/scripts/workspace.js init <workspace-name> <repo1> <repo2> ... --org <org>
# 示例: bash .claude/skills/octo-dev-copilot/scripts/workspace.js init feat-ux-enhance xzf/octopus-demo-api-admin xzf/octopus-demo-service-admin --org xzf
```

创建工作空间目录 `~/.octopus/{org}/workspaces/<name>/`，并为每个 repo 创建 git worktree（`--detach` 状态），目录结构:
```
~/.octopus/{org}/workspaces/feat-ux-enhance/
  ├── config.json          # 工作空间配置
  ├── CLAUDE.md            # 工作空间说明
  └── projects/
      ├── xzf-octopus-demo-api-admin/      # git worktree
      ├── xzf-octopus-demo-service-admin/  # git worktree
      └── xzf-octopus-demo-web-admin/      # git worktree
```

#### 添加 repo

```bash
bash .claude/skills/octo-dev-copilot/scripts/workspace.js add <workspace-name> <repo> --org <org>
```

#### 移除 repo

```bash
bash .claude/skills/octo-dev-copilot/scripts/workspace.js remove <workspace-name> <repo> --org <org>
```

#### 销毁工作空间

```bash
bash .claude/skills/octo-dev-copilot/scripts/workspace.js destroy <workspace-name> --org <org>
```

#### 创建/切换分支

```bash
bash .claude/skills/octo-dev-copilot/scripts/workspace.js branch <workspace-name> <branch-name> --org <org>
```

在工作空间内所有 **worktree** 上创建/切换同名分支（不影响主仓库分支）。

#### 查询状态

```bash
bash .claude/skills/octo-dev-copilot/scripts/workspace.js status <workspace-name> --org <org>
```

#### 查看变更摘要

```bash
bash .claude/skills/octo-dev-copilot/scripts/workspace.js diff <workspace-name> --org <org>
```

#### 列出所有工作空间

```bash
bash .claude/skills/octo-dev-copilot/scripts/workspace.js list --org <org>
```

#### 工作空间内编码

初始化后，coding agent 的工作上下文包含:
- `~/.octopus/{org}/workspaces/<name>/CLAUDE.md` — 工作空间说明
- 各 worktree 目录 — 直接在 worktree 中修改代码

agent 在修改代码时直接操作各 **worktree 目录**，主仓库不受影响。

### 2. 跨项目模式搜索

用户触发词: "搜索模式" / "其他项目怎么实现" / "参考实现" / "pattern search"

**通用方法**:
1. 从 `~/.octopus/{org}/repos/index.md` 获取所有已克隆项目路径
2. 加载平台参考文件，获取该平台的核心框架注解、库签名、编码模式关键词
3. 用 Grep 在多个项目目录中搜索关键模式
4. 汇总搜索结果，标注来源项目与文件路径
5. 基于搜索结果给出最佳实践建议

### 3. API 接口契约发现

用户触发词: "查找接口" / "接口定义" / "API discover"

**通用方法**:
1. 确定目标: 用户指定项目名或接口关键词
2. 加载平台参考文件，获取该平台的接口定义与模块约定
3. 在接口定义模块中搜索服务契约（interface / proto / openapi 等）
4. 在服务实现模块中搜索对外暴露的端点
5. 在其他项目中搜索此接口的消费方/调用方
6. 输出接口契约 + 调用关系图

### 4. 代码模板生成

用户触发词: "生成代码" / "新建接口" / "模板" / "scaffold" / "骨架代码"

**通用方法**:
1. 确定目标项目与模块
2. 加载平台参考文件，获取该平台的分层约定与对象模型
3. 在目标项目中搜索现有代码风格（响应包装、异常处理、分页方式等）
4. 按分层约定生成骨架代码，包含每层对象转换
5. 自动生成配套的配置文件（ORM 映射 / 路由注册 / 依赖声明等）
6. 所有方法返回值统一用项目约定的响应包装

### 5. 跨服务影响分析

用户触发词: "影响分析" / "改了这个谁受影响" / "impact" / "依赖追踪"

**通用方法**:
1. 确定变更源: 用户指定修改的类/接口/方法（通常在共享库/公共模块中）
2. 在 `~/.octopus/{org}/repos/index.md` 中获取所有项目路径
3. 加载平台参考文件，获取该平台的依赖检测关键词（import 模式、注解引用、构建文件依赖声明等）
4. 用 Grep 多维度搜索变更类的引用
5. 汇总下游影响，按影响程度分级

**分级标准**（通用）:
| 级别 | 含义 | 典型场景 |
|------|------|---------|
| HIGH | 直接引用，编译会失败 | import / extends / 接口引用 |
| MEDIUM | 间接或配置引用，需确认兼容 | DI 注入 / 构建文件依赖 |
| LOW | 通过中间层传递，大概率不受影响 | 传递依赖 |

### 6. 上下文感知建议

用户触发词: "推荐" / "建议" / "上下文" / "context suggest"

**通用方法**:
1. 从当前工作目录或用户指定推断当前项目
2. 从 `~/.octopus/{org}/repos/index.md` 定位项目信息
3. 加载平台参考文件，获取该平台的基础设施组件清单与检测方式
4. 搜索项目已有的基础设施依赖
5. 搜索项目中的服务调用关系
6. 搜索项目中可复用的工具类/公共库
7. 输出建议清单（已有 / 推荐使用 / 未引入但可能需要）
