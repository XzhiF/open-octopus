# Octopus — Loop Engineering 平台

> TypeScript monorepo · AI 工作流编排 + 多项目隔离 + 角色/技能资产库
> v1.0.0 · https://github.com/XzhiF/octopus

## 源码结构

```
octopus/
├── packages/
│   ├── shared/      ← @octopus/shared (Zod schemas + VarPool + config)
│   ├── providers/   ← @octopus/providers (AI Provider 抽象, Claude SDK)
│   ├── cli/         ← octopus (Commander.js CLI)
│   ├── engine/      ← @octopus/engine (7 executors + SQLite + JSONL)
│   ├── server/      ← @octopus/server (Hono REST API + SSE + WebSocket)
│   ├── web-app/     ← @octopus/web-app (Next.js 前端)
│   └── core-pack/   ← @octopus/core-pack (skills/agents/workflows)
├── scripts/         ← dev.mjs, prod.mjs, branch-port.mjs
├── pnpm-workspace.yaml
└── vitest.workspace.ts
```

### 包间依赖

```
shared ← (无依赖)        providers ← shared
cli ← shared+engine+core-pack    engine ← shared+providers
server ← shared+engine+core-pack+providers
web-app ← shared (类型)          core-pack ← (纯数据)
```

## Workflow Engine

YAML 定义工作流。**7 种执行器**: Bash / Python / Agent / Condition / Approval / Loop / Swarm。
**4 种编排模式**: chain / DAG / swarm / dynamic。

Swarm 子模式: review(1轮审查) · debate(N轮讨论+共识检测) · dispatch(DAG调度) · swarm(动态路由) · moa(多专家+聚合器)。

变量: `$vars.xxx` 全局池 · `$node-id.output.xxx` 前序节点 · `$last_output` · `$iteration`。

## Workspace 隔离

| 模式 | Server | Web | DB |
|------|--------|-----|-----|
| dev (主仓库) | 3001 | 3000 | `~/.octopus/db/octopus.db` |
| dev (worktree) | 3100-3598 | +1 | `octopus-{branch}.db` |
| prod | 3099 | 3098 | `octopus-prod.db` |

## 开发与测试

```bash
pnpm install          # 安装依赖
pnpm build            # 构建所有包
pnpm dev              # 主仓库开发 (server:3001 web:3000)
pnpm dev --isolated   # 隔离模式
pnpm prod             # 生产模式 (server:3099 web:3098)
pnpm port             # 查看端口分配
pnpm test             # Vitest 测试
pnpm test:watch       # 监听模式
```

### 环境变量

| 变量 | 默认值 |
|------|--------|
| `PORT` | 3001 (主仓库) / hash (worktree) |
| `OCTOPUS_DB_PATH` | `~/.octopus/db/octopus.db` |
| `NEXT_PUBLIC_SERVER_URL` | `http://localhost:3001` |

### Worktree 并行开发

```bash
git worktree add .worktrees/feat-xxx octopus-feat-xxx
cd .worktrees/feat-xxx && pnpm install && pnpm build && pnpm dev
```

## CLI 常用命令

```bash
octopus init <dir> --org <org>        # 初始化项目
octopus setup [--org]                 # 初始化 ~/.octopus/{org}/
octopus workflow run <yaml>           # 执行工作流
octopus workflow validate <yaml>      # 验证工作流
octopus workspace list/create/get/delete/tree
octopus repos update/pull/clone/rebuild-index
```

## 命名规范

- Skill 前缀 `octo-` · Agent 前缀描述性名称 · 包名 `@octopus/{name}`
- CLI: `octopus` · MCP 注册表: `mcp_{env}.yaml`
- 单一版本来源: root package.json → shared/src/version.ts

## Agent Skills

- Issue tracker: `.scratch/<feature>/` 目录下的 markdown 文件
- Triage labels: needs-triage / needs-info / ready-for-agent / ready-for-human / wontfix
- Domain docs: root `CONTEXT-MAP.md` → per-package `CONTEXT.md`
