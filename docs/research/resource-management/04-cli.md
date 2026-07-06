# 4. CLI 设计

## 4.1 设计原则：瘦客户端

CLI 是 Server 的 HTTP 客户端，不承载任何业务逻辑。

```
CLI (resource.ts)  →  HTTP fetch  →  Server API  →  ResourceManager  →  文件系统
     ↑ 参数解析                                    ↑ 唯一入口
     ↑ chalk 格式化
     ↑ 错误输出
```

**与现有命令的一致性**：`workspace-cmd.ts`、`agents` 等命令已采用此模式——`fetch(getServerUrl() + path)` + 格式化输出。资源管理不应例外。

### 为什么不在 CLI 放核心逻辑

| 问题 | 影响 |
|------|------|
| Server 也需要资源管理（Web UI 安装/卸载） | CLI 有核心 → Server 也要有 → 双轨 or 反向依赖 |
| CLI 进程 vs Server 进程并发操作同一文件系统 | Registry/Lock 冲突 |
| CLI 每次命令重建 ResourceManager（kernel + store + providers） | 启动慢，无缓存 |
| Server 持有 ResourceManager 单例 + 内存缓存 | CLI 无法复用这个缓存 |

## 4.2 命名

| 命令 | 职责 |
|------|------|
| `octopus repos` | Git 仓库管理（clone/pull/index，**已有，不改**） |
| `octopus resource` | Octopus 资源管理（skill/agent/workflow 的安装/卸载/查询） |

## 4.3 命令族

```
octopus resource
├── source                      # ── 集合源管理 ──
│   ├── add <url>               # 添加集合源（克隆 + 分析 + 信任）
│   ├── remove <name>           # 移除集合源
│   ├── list                    # 列出已添加的集合源
│   ├── update [name]           # 拉取最新版本并重新分析
│   ├── analyze <url>           # 仅分析不安装（预览资源列表）
│   └── info <name>             # 查看集合源包含哪些资源
│
├── install <ref> [--scope]     # ── 资源操作 ──
├── uninstall <name> --type     #
├── list [--type] [--query]     #
├── info <name> --type          #
│
├── gc [--dry-run]              # ── 维护 ──
├── sync [--fix]                #
├── audit [--last]              #
└── doctor                      #
```

### ref 格式

```
builtin:brainstorming           → core-pack 内置资源
local:/path/to/skill            → 本地路径
git:https://github.com/xxx/yyy  → git 集合源（安装全部资源）
```

### 相比原设计删除的命令

| 删除命令 | 理由 |
|---------|------|
| `init` | 一次性操作，由 `octopus setup` 或首次 API 调用自动初始化 |
| `register` | 安装时自动注册，无需单独步骤（`install = resolve + register + fetch`） |
| `search` | `list --query <q>` 已覆盖搜索功能 |
| `deps` | 详情页 (`info`) 已展示依赖关系，或通过 Server API `/deps` 获取 |

## 4.4 实现结构

**单文件实现**：`packages/cli/src/commands/resource.ts`（~300 行）

```typescript
import { Command } from "commander"
import chalk from "chalk"

// ── 共享基础设施 ────────────────────────────────────────────

const getServerUrl = (): string =>
  process.env.OCTOPUS_SERVER_URL ?? "http://localhost:3001"

const AUTH_TOKEN = process.env.OCTOPUS_AGENT_TOKEN ?? "agent"

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    ...(init?.headers as Record<string, string> ?? {}),
    "Authorization": `Bearer ${AUTH_TOKEN}`,
  }
  const res = await fetch(`${getServerUrl()}${path}`, { ...init, headers })
  const body = await res.json()
  if (!res.ok) {
    const err = body as { error?: { message?: string; hint?: string } }
    const msg = err.error?.message ?? `HTTP ${res.status}`
    const hint = err.error?.hint ? `\n  ${chalk.dim("Hint:")} ${err.error.hint}` : ""
    throw new Error(`${msg}${hint}`)
  }
  return body as T
}

// ── 命令组 ──────────────────────────────────────────────────

export const resourceCmd = new Command("resource")
  .description("Resource management (skills, agents, workflows)")

// install — 支持 variadic refs
resourceCmd
  .command("install <ref...>")
  .action(async (refs: string[]) => {
    for (const ref of refs) {
      const res = await apiFetch("/api/resources/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ref }),
      })
      console.log(chalk.green(`Installed ${res.data.type}/${res.data.name}`))
    }
  })

// uninstall — 需要 --type
resourceCmd
  .command("uninstall <name>")
  .requiredOption("--type <type>", "skill | agent | workflow")
  .action(async (name, opts) => {
    await apiFetch("/api/resources/uninstall", {
      method: "POST",
      body: JSON.stringify({ name, type: opts.type }),
    })
    console.log(chalk.green(`Uninstalled ${opts.type}/${name}`))
  })

// list — 支持 --type, --query, --installed, --tag
resourceCmd
  .command("list")
  .option("--type <type>")
  .option("--query <q>")
  .option("--installed")
  .option("--tag <tag>")
  .action(async (opts) => {
    const params = new URLSearchParams()
    if (opts.type) params.set("type", opts.type)
    if (opts.query) params.set("query", opts.query)
    if (opts.installed) params.set("installed", "true")
    if (opts.tag) params.set("tag", opts.tag)
    const qs = params.toString()
    const res = await apiFetch(`/api/resources${qs ? `?${qs}` : ""}`)
    // ... 格式化表格输出
  })

// info, gc, sync, audit, doctor — 同理，fetch + chalk 格式化
```

## 4.5 各命令详细设计

### `octopus resource source add <url>`

```
用法: octopus resource source add <url>

参数:
  <url>              GitHub 仓库 URL (https://github.com/xxx/yyy)

流程:
  1. POST /api/resources/source/add { url }
  2. Server: git clone --depth 1 → 缓存
  3. Server: 三层降级发现资源
  4. Server: 注册到 registry + 添加到 allowlist
  5. CLI 输出分析结果

输出:
  ✓ Added source: agency-agents-zh
    URL: https://github.com/jnMetaCode/agency-agents-zh
    Resources: 215 agents
    Trust: auto-added to allowlist

错误:
  Source already exists: agency-agents-zh
    Hint: Use 'octopus resource source update agency-agents-zh' to refresh
```

### `octopus resource source list`

```
用法: octopus resource source list

输出:
  Sources (3):
    agency-agents-zh    git:github.com/jnMetaCode/agency-agents-zh    215 agents    trusted
    superpowers-zh      git:github.com/jnMetaCode/superpowers-zh      22 skills     trusted
    gstack              git:github.com/garrytan/gstack                 12 mixed      trusted
```

### `octopus resource source update [name]`

```
用法: octopus resource source update [name]
      (不指定 name 则更新全部)

输出:
  Updated agency-agents-zh:
    + 3 new agents
    ~ 12 modified agents
    - 1 removed agent
    Total: 217 agents (was 215)
```

### `octopus resource source analyze <url>`

```
用法: octopus resource source analyze <url>
      仅分析不安装。预览 repo 包含哪些资源。

输出:
  Analyzing git:github.com/garrytan/gstack...

  Discovered 12 resources:
    skills (8):
      gstack-pm          skills/gstack-pm/SKILL.md
      gstack-eng         skills/gstack-eng/SKILL.md
      ...
    agents (3):
      product-manager    agents/product-manager.md
      ...
    workflows (1):
      sprint-planning    workflows/sprint-planning.yaml

  Run 'octopus resource source add <url>' to install.
```

### `octopus resource source info <name>`

```
用法: octopus resource source info <name>

输出:
  Source: agency-agents-zh
    URL:        https://github.com/jnMetaCode/agency-agents-zh
    Added:      2026-07-07
    Trusted:    yes
    Resources:  215 agents
    Cache:      ~/.octopus/orgs/xzf/cache/sources/agency-agents-zh/
    Manifest:   auto-generated (Layer 3: convention scan)
```

### `octopus resource source remove <name>`

```
用法: octopus resource source remove <name>
      从 allowlist 移除 + 清理缓存（不卸载已安装的资源）

输出:
  ✓ Removed source: agency-agents-zh
    Note: 215 installed agents were NOT uninstalled.
```

### `octopus resource install <ref> [--scope user|org|workspace]`

```
用法: octopus resource install <ref> [options]

参数:
  <ref>              资源引用 (builtin:name | local:path | git:url)
  --scope <scope>    安装范围: user (默认) | org | workspace

示例:
  # 从 core-pack 安装单个 skill 到当前 workspace
  $ octopus resource install builtin:brainstorming --scope workspace

  # 从 git 集合源安装全部资源到用户全局
  $ octopus resource install git:https://github.com/jnMetaCode/agency-agents-zh

  # 从本地路径安装
  $ octopus resource install local:/path/to/my-skill

输出:
  ✓ Installed 215 agents from agency-agents-zh
    → ~/.claude/agents/

  或单个资源:
  ✓ Installed skill/brainstorming (v1.0.0)
    → workspace/.claude/skills/brainstorming/
```

### `octopus resource uninstall <name> --type <type>`

```
用法: octopus resource uninstall <name> --type <type>

流程:
  1. POST /api/resources/uninstall { name, type }
  2. Server 端: 检查反向依赖 → 删除文件 → 更新 registry/lock → audit

输出:
  Uninstalled skill/brainstorming

错误:
  Cannot uninstall: 2 resource(s) depend on 'brainstorming'
    Hint: Dependents: tdd-workflow, octo-dev-copilot. Uninstall dependents first.
```

### `octopus resource list [--type <type>] [--query <q>] [--installed] [--tag <tag>]`

```
输出:
  Resources (3):
    skill/brainstorming     v1.2.0  installed  [design, planning]
    skill/tdd-workflow      v0.5.0  installed
    agent/code-reviewer     v1.0.0  not installed
```

### `octopus resource info <name> --type <type>`

```
输出:
  skill/brainstorming
    Version:      1.2.0
    Installed:    yes
    Path:         /workspace/.claude/skills/brainstorming
    Hash:         a1b2c3d4e5f6
    Dependencies: tdd-workflow
    Source:       builtin
    Updated:      2026-07-06T10:00:00Z
```

### `octopus resource gc [--dry-run]`

```
输出:
  Removed 3 item(s) (freed 4.4 KB):
    - old-skill
    - removed-agent
    - old-flow
```

### `octopus resource sync [--fix] [--targets <names...>]`

```
输出:
  Found 2 drift(s):
    fixed   skill/brainstorming
    MISSING agent/code-reviewer

  Run with --fix to auto-repair drifts.
```

### `octopus resource audit [--last <n>] [--action <action>] [--resource <name>]`

```
输出:
  Audit log (5 of 5 entries):
    2026-07-06T10:00:00Z  install    skill/brainstorming  ok
    2026-07-06T09:55:00Z  uninstall  skill/old-skill      ok
```

### `octopus resource doctor`

```
输出:
  All 4 checks passed
    PASS  registry_integrity    registry.json valid (12 entries)
    PASS  lock_consistency      resources.lock matches workspace
    PASS  stale_locks           No stale lock files
    PASS  cache_references      All cache paths valid
```

## 4.6 Agent 门控

Agent 门控在 **Server 端** 实现，不在 CLI。

CLI 通过 `Authorization: Bearer <token>` 传递身份，Server 根据 token 判断是否允许操作。

| 操作 | 权限 | Server 端检查 |
|------|------|--------------|
| install/uninstall | human + agent | agentAuthMiddleware |
| gc/sync | human only | agentAuthMiddleware + 角色检查 |
| list/info/audit/doctor | 公开 | agentAuthMiddleware |

## 4.7 环境变量

| 变量 | 用途 | 默认值 |
|------|------|--------|
| `OCTOPUS_SERVER_URL` | Server 地址 | `http://localhost:3001` |
| `OCTOPUS_AGENT_TOKEN` | Auth token | `agent`（仅开发用） |
| `OCTOPUS_ORG` | Org 名称 | `default` |
