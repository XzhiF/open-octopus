# 2. 架构设计

## 2.1 三层架构

```
┌─────────────────────────────────────────────────────────┐
│                    Web UI (web-app)                      │
│  资源浏览器 · 安装管理 · 漂移修复 · 审计日志             │
│  /resources  /resources/[type]/[name]  /resources/audit  │
└────────────────────────┬────────────────────────────────┘
                         │ HTTP REST
┌────────────────────────┴────────────────────────────────┐
│                   Server API (server)                    │
│  /api/resources/* 路由                                   │
│  ResourceManager 单例 (per-org)                          │
│  ← 唯一入口：所有资源操作经过此处                         │
└────────────────────────┬────────────────────────────────┘
                         │ import
┌────────────────────────┴────────────────────────────────┐
│                  Core (shared)                           │
│                                                          │
│  packages/shared/src/resource/    ← 核心逻辑 + 类型     │
│                                                          │
│  ResourceManager · RegistryStore · LockManager           │
│  SourceProvider(builtin/local) · DependencyResolver      │
│  AtomicJsonStore · AuditLogger · InstallTransaction      │
└─────────────────────────────────────────────────────────┘
                         │
┌────────────────────────┴────────────────────────────────┐
│                  CLI (cli) — 瘦客户端                    │
│                                                          │
│  packages/cli/src/commands/resource.ts  ← 纯 HTTP 客户端│
│  8 个子命令 → fetch → Server API → 格式化输出            │
└─────────────────────────────────────────────────────────┘
```

### 为什么核心在 shared 而不是 cli

> **设计原则**：资源管理是 Server 行为，CLI 只是辅助入口。

**反模式（已否决）**：核心逻辑放 CLI 包，Server import CLI 的 ResourceManager。

这样做的问题：
1. **反向依赖** — Server 依赖 CLI 包 = 依赖 Commander.js、chalk 等终端库，Server 不需要这些
2. **双轨风险** — CLI 直接操作文件系统和 Server 直接操作文件系统，两条独立路径可能并发冲突
3. **不一致的消费者** — Web UI 通过 HTTP → Server，CLI 通过进程内调用 → ResourceManager，同一操作两条路

**正确模式**：核心逻辑放 shared 包，Server 持有 ResourceManager 单例，CLI 是 Server 的 HTTP 客户端。

| 层 | 放什么 | 不放什么 |
|---|---|---|
| `shared/src/resource/` | ResourceManager（核心编排）、RegistryStore、LockManager、SourceProviders、所有 fs 操作、Zod Schema、错误类、工具函数 | HTTP 路由、终端 IO |
| `server/src/routes/resource/` | REST 路由（调用 ResourceManager）、中间件（CORS、auth、JSON 校验） | 业务逻辑、fs 操作 |
| `cli/src/commands/resource.ts` | 参数解析、`fetch()` 调用 Server API、`chalk` 格式化输出 | ResourceManager、fs 操作、业务逻辑 |

**与现有命令的一致性**：`workspace-cmd.ts`、`agents` 等现有 CLI 命令已采用"瘦 HTTP 客户端"模式，资源管理不应例外。

## 2.2 模块划分

```
packages/shared/src/resource/
├── types.ts                 # ResourceManifest, RegistryEntry, LockFileEntry 等 Zod Schema
├── errors.ts                # ResourceError (20 error codes + HTTP status + exit code + suggestion)
├── utils.ts                 # isPathWithinBase, computeContentHash, parseRef, formatBytes
├── security.ts              # isTrustedOrigin, requireJsonContentType
├── atomic-store.ts          # AtomicJsonStore<T> (原子写入 + .bak 恢复 + 文件锁)
├── registry.ts              # RegistryStore (内存缓存 + cache invalidation)
├── lock-manager.ts          # LockManager (resources.lock 读写 + 漂移检测)
├── dependency-resolver.ts   # DependencyResolver (DFS + 环检测 + depth guard)
├── installer.ts             # WorkspaceInstaller (workspace 文件安装)
├── uninstaller.ts           # WorkspaceUninstaller
├── install-transaction.ts   # InstallTransaction (undo stack 事务回滚)
├── audit-logger.ts          # AuditLogger (JSONL 追加 + 链式哈希防篡改)
├── gc.ts                    # GarbageCollector (孤立缓存清理)
├── manager.ts               # ResourceManager (核心编排 — install/uninstall/sync/gc/doctor)
├── resource-event.ts        # ResourceEvent 类型定义 (预留扩展)
├── providers/
│   ├── types.ts             # SourceProvider 接口
│   ├── builtin-provider.ts  # core-pack 内置资源 (SAFE_NAME_RE + isPathWithinBase)
│   └── local-provider.ts    # 本地目录复制 (BLOCKED_PREFIXES + SAFE_NAME_RE)
└── index.ts                 # 统一导出

packages/server/src/routes/resource/
├── index.ts                 # createResourceRoutes() — 10 REST 端点
└── middleware.ts             # resourceCors + requireJsonBody

packages/server/src/index.ts (改动)
└── getResourceManager()     # Per-Org 单例工厂

packages/cli/src/commands/
└── resource.ts              # 8 个子命令 (纯 HTTP 客户端)
```

### 为什么 Provider 只有 2 种（Phase 1）

| Provider | 状态 | 理由 |
|----------|------|------|
| `builtin` | ✅ 已实现 | core-pack 内置资源，安全可控 |
| `local` | ✅ 已实现 | 本地目录复制，开发调试用 |
| `npm` | ⏳ Phase 2 | tarball 下载，需要 trust 体系 |
| `git` | ⏳ Phase 2 | shallow clone，需要 trust 体系 |

Phase 1 只支持 builtin + local，攻击面限于本地文件系统 + 打包的 core-pack。Phase 2 引入远程源时，需要同步实现 trust 管理（TOFU 或 allowlist）。

## 2.3 数据流

### 核心原则：Server 是唯一入口

所有资源操作（安装、卸载、同步、GC）都经过 Server 的 ResourceManager 单例。CLI 不直接操作文件系统，Web UI 也不直接操作——它们都是 Server 的客户端。

```
                    octopus resource install builtin:brainstorming
                              │
                              ▼  HTTP POST /api/resources/install
                    ┌──────────────────┐
                    │    Server        │
                    │ ResourceManager  │  ← 单例 (per-org)
                    │  .install()      │
                    └────────┬─────────┘
                             │
              ┌──────────────┼──────────────────┐
              ▼              ▼                   ▼
      ┌─────────────┐ ┌───────────┐    ┌────────────────┐
      │SourceProvider│ │Dependency │    │InstallTransaction│
      │  .resolve() │ │ Resolver  │    │  (undo stack)  │
      │  .fetch()   │ │ .resolve()│    └────────┬───────┘
      └──────┬──────┘ └─────┬─────┘             │
             │              │                   ▼
             ▼              ▼          ┌──────────────┐
      ┌────────────────────────────────┤  AuditLogger  │
      │          ~/.octopus/orgs/{org}/│  (chain hash) │
      │  resources/registry.json       └──────────────┘
      │  resources/resources.lock
      │  resources/audit.jsonl
      │  cache/resources/
      └──────────────────┬───────────────────────────┘
                         │
                         ▼  安装到 workspace
      ┌──────────────────────────────────────────────┐
      │  workspace/.claude/skills/brainstorming/      │
      │  workspace/.claude/agents/code-reviewer.md    │
      │  workspace/workflows/bug-hunter.yaml          │
      └──────────────────────────────────────────────┘
```

### Server 单例工厂

```typescript
// packages/server/src/index.ts

const resourceManagerCache = new Map<string, ResourceManager>()

function getResourceManager(org: string): ResourceManager {
  let mgr = resourceManagerCache.get(org)
  if (!mgr) {
    const orgDir = path.join(os.homedir(), ".octopus", "orgs", org)
    const config: ResourceManagerConfig = {
      workspacePath: path.join(orgDir, "workspaces", "default"),
      cachePath: path.join(orgDir, "cache", "resources"),
      registryPath: path.join(orgDir, "resources", "registry.json"),
      lockPath: path.join(orgDir, "resources", "resources.lock"),
      auditPath: path.join(orgDir, "resources", "audit.jsonl"),
      providers: [new BuiltinProvider(corePackPath), new LocalProvider()],
    }
    mgr = new ResourceManager(config)
    resourceManagerCache.set(org, mgr)
  }
  return mgr
}

app.route("/api/resources", createResourceRoutes(() => {
  return getResourceManager(process.env.OCTOPUS_ORG ?? "default")
}))
```

**为什么用单例**：
- ResourceManager 持有 RegistryStore（内存缓存）和 AuditLogger（文件句柄），多实例会导致缓存不一致
- Per-Org 隔离：不同 org 有独立的 registry、lock、audit
- 避免每次 HTTP 请求都重建整个 manager

## 2.4 与现有模块的关系

### 消费者

| 消费者 | 场景 | 代码位置 |
|--------|------|---------|
| **Octopus Agent** (SkillLoader) | server 端 AI 助手对话时使用 skill | `server/src/services/agent/skill-loader.ts` |
| **AgentExecutor** (engine) | workflow agent 节点执行时使用 skill + agent | `engine/src/executors/agent.ts` |
| **SwarmExecutor** (engine) | workflow swarm 节点动态选择 expert agent | `engine/src/executors/swarm.ts` |

### 接线矩阵

| 资源类型 | 安装位置 | SkillLoader | AgentExecutor | SwarmExecutor |
|---------|---------|-------------|---------------|---------------|
| **skill** | `workspace/.claude/skills/{name}/` | ⚡ Tier 0 | ✅ provider 传 skill 名 | ✅ expert 的 skills 选项 |
| **agent** | `workspace/.claude/agents/{name}.md` | N/A | ✅ resolveAgents() 读 agent_file | ✅ RoleRegistry 扫描 |
| **workflow** | `workspace/workflows/{name}.yaml` | N/A | N/A | N/A（CLI 直接读取） |

### 接线 ① SkillLoader 新增 Tier 0

现有 SkillLoader 三层扫描：
```
Tier 1: ~/.octopus/{org}/agent/skills/   (local evolved, 最高优先级)
Tier 2: core-pack/skills/                (builtin)
Tier 3: prod/core-pack/skills/           (prod copy, 最低优先级)
```

新增 Tier 0（最高优先级）：
```
Tier 0: workspace/.claude/skills/        (resource installed)  ← 新增
Tier 1: ~/.octopus/{org}/agent/skills/   (local evolved)
Tier 2: core-pack/skills/                (builtin)
Tier 3: prod/core-pack/skills/           (prod copy)
```

**理由**：用户通过 `resource install` 显式安装的 skill 应该优先于内置 skill。

**改动范围**：`SkillLoader` 构造函数接受 `workspaceDir` 参数，扫描时加入 Tier 0。

### 需要改动的现有代码

| 文件 | 改动 | 大小 |
|------|------|------|
| `server/src/services/agent/skill-loader.ts` | 加 Tier 0 workspaceDir 扫描 | ~20 行 |
| `server/src/index.ts` | 加 ResourceManager 单例工厂 + 路由注册 | ~35 行 |

总计 ~55 行改动即可闭环。

## 2.5 Source 集合源管理

### 问题

Octopus 依赖多个外部 GitHub 项目作为资源集合：

| 集合 | URL | 内容 | 安装方式 |
|------|-----|------|---------|
| agency-agents-zh | `github.com/jnMetaCode/agency-agents-zh` | 215 个 agents | git clone → `dependencies/` |
| superpowers-zh | `github.com/jnMetaCode/superpowers-zh` | 20+ skills | `npx superpowers-zh@latest --tool claude --force` |
| gstack | `github.com/garrytan/gstack` | skills + prompts | 待分析 |

当前这些集合的安装是 **ad-hoc 的**——硬编码在 `octopus setup` 里，每个集合有自己的安装逻辑。需要一个统一的 Source 管理系统。

### Source 概念

**Source**（集合源）= 一个包含多个资源的 GitHub 仓库。

```
Source: git:https://github.com/jnMetaCode/agency-agents-zh
  └── 包含 215 个 agents → 安装到 ~/.claude/agents/

Source: git:https://github.com/jnMetaCode/superpowers-zh
  └── 包含 20+ skills → 安装到 ~/.claude/skills/

Source: git:https://github.com/garrytan/gstack
  └── 包含 skills + prompts → 安装到 ~/.claude/skills/
```

Source 与单个资源的关系：Source 是资源的**来源容器**，一个 Source 包含 N 个资源。安装 Source = 批量安装其包含的所有资源。

### 三层降级发现机制

安装 Source 时，需要知道它包含哪些资源。三层降级：

```
Layer 1: octopus-resource.json     → 精确声明（repo 作者写的）
         ↓ 不存在
Layer 2: AI README 分析             → 智能推断（octo-source-analyzer skill）
         ↓ LLM 不可用或分析失败
Layer 3: 约定扫描                   → 兜底（目录结构推断）
```

#### Layer 1：`octopus-resource.json`（最优路径）

Repo 根目录的声明文件，告诉系统"我有什么资源、怎么安装"：

```jsonc
{
  "name": "superpowers-zh",
  "version": "1.0.0",
  "description": "中文 Claude Code 技能包",
  // 可选：安装前执行一次（npm 包构建、代码生成等）
  "setup": "npx superpowers-zh@latest --tool claude --force",
  // 声明包含的资源
  "resources": {
    "skills": [
      "skills/brainstorming",
      "skills/chinese-code-review",
      "skills/test-driven-development"
    ],
    "agents": [],
    "workflows": []
  }
}
```

- `setup` — 可选。有些 repo 需要跑命令生成文件（如 superpowers-zh 的 npx）。ResourceManager 负责执行。
- `resources` — 声明每种类型的资源路径列表。系统按声明复制文件到目标目录。
- 系统读这个文件，按声明执行，**不猜**。

#### Layer 2：AI README 分析（智能路径）

没有 manifest 时，调用 **`octo-source-analyzer` skill**，让 agent 读 README + 扫描 repo 结构，生成 manifest：

```
$ octopus resource source add git:https://github.com/garrytan/gstack

[分析中...]
  → 克隆仓库到缓存
  → 未找到 octopus-resource.json
  → 调用 octo-source-analyzer skill 分析 README.md + 目录结构...

[分析结果]
  发现 12 个资源：
    skills (8):
      · gstack-pm        skills/gstack-pm/SKILL.md
      · gstack-eng       skills/gstack-eng/SKILL.md
      · ...
    agents (3):
      · product-manager  agents/product-manager.md
      · ...
    workflows (1):
      · sprint-planning  workflows/sprint-planning.yaml

  ✓ 生成 manifest 并缓存 → cache/sources/gstack/octopus-resource.json

[确认安装?] (Y/n)
```

**`octo-source-analyzer` skill 的职责**：
- 读 README.md 提取安装命令（`npx`、`npm install`、`make` 等）
- 扫描目录结构识别 skill/agent/workflow 资源
- 生成 `octopus-resource.json` 并写入缓存
- 下次安装同一 Source 时直接用缓存的 manifest

#### Layer 3：约定扫描（兜底路径）

AI 分析也不可用时（无 LLM、离线、分析失败），退到纯目录扫描：

```
repo-root/
├── skills/*/SKILL.md     → 每个含 SKILL.md 的子目录 = 1 个 skill
├── agents/*.md           → 每个 .md 文件 = 1 个 agent
├── workflows/*.yaml      → 每个 .yaml 文件 = 1 个 workflow
└── *.md (根目录)         → 如果只含少量 .md，可能是单文件 agents
```

agency-agents-zh 能被这个兜底正确识别（`agents/*.md` → 215 个 agents）。

#### 降级流程

```
source add git:xxx/yyy
  │
  ├─ 1. git clone --depth 1 → cache/sources/{name}/
  │
  ├─ 2. 有 octopus-resource.json？
  │     ├─ YES → 解析 manifest → 跳到步骤 5
  │     └─ NO ↓
  │
  ├─ 3. LLM 可用？
  │     ├─ YES → 调用 octo-source-analyzer skill
  │     │        → 读 README + 扫描目录 → 生成 manifest
  │     │        → 缓存 manifest → 跳到步骤 5
  │     └─ NO ↓
  │
  ├─ 4. 约定扫描
  │     → 扫描 skills/ agents/ workflows/
  │     → 生成 manifest → 缓存
  │
  └─ 5. 展示发现结果 → 用户确认 → 执行安装
```

### Scope 模型（安装范围）

Source 通常安装到**全局**（用户级），因为 skills 和 agents 是跨项目复用的。

| Scope | Skills 安装到 | Agents 安装到 | Workflows 安装到 | 典型场景 |
|-------|-------------|-------------|----------------|---------|
| `user` | `~/.claude/skills/` | `~/.claude/agents/` | `~/.octopus/workflows/` | 个人全局（默认） |
| `org` | `~/.octopus/orgs/{org}/skills/` | `~/.octopus/orgs/{org}/agents/` | `~/.octopus/orgs/{org}/workflows/` | 团队共享 |
| `workspace` | `workspace/.claude/skills/` | `workspace/.claude/agents/` | `workspace/workflows/` | 项目专属 |

默认 scope 为 `user`。

### SkillLoader 扫描层级扩展

```
Tier 0: workspace/.claude/skills/         (workspace 安装的)
Tier 1: ~/.claude/skills/                 (user 全局安装的)      ← 新增
Tier 2: ~/.octopus/{org}/skills/          (org 级安装的)        ← 新增
Tier 3: ~/.octopus/{org}/agent/skills/    (local evolved)
Tier 4: core-pack/skills/                 (builtin)
Tier 5: prod/core-pack/skills/            (prod copy)
```

### Trust 模型（信任管理）

远程源使用 **allowlist**（不是 blocklist）：

```yaml
# ~/.octopus/orgs/{org}/config.yaml
resource_sources:
  trusted:
    - url: https://github.com/jnMetaCode/agency-agents-zh
      added_at: "2026-07-07"
    - url: https://github.com/jnMetaCode/superpowers-zh
      added_at: "2026-07-07"
    - url: https://github.com/garrytan/gstack
      added_at: "2026-07-07"
```

- `source add` 时自动加入 allowlist
- `install` 时校验 URL 是否在 allowlist 中
- `builtin:` 和 `local:` 始终信任（不需要 allowlist）

### setup 命令执行

当 `octopus-resource.json` 声明了 `setup` 命令时，ResourceManager 负责执行：

```typescript
// manager.ts — install 流程中
if (manifest.setup) {
  this.audit.log({ action: "source.setup", resource: manifest.name, ... })
  const result = await this.executeSetup(manifest.setup, sourceDir)
  if (result.exitCode !== 0) {
    throw new ResourceError("SETUP_FAILED",
      `Setup command failed for ${manifest.name}: ${result.stderr}`)
  }
}
```

执行安全：
- 使用 `execFileSync`（不经过 shell，防止注入）
- 超时 120 秒
- cwd 限制在 source 缓存目录
- 审计记录 setup 执行结果

### 数据流

```
octopus resource source add git:https://github.com/jnMetaCode/agency-agents-zh
  │
  ├─ 1. Server: 校验 URL + 检查 allowlist（去重）
  ├─ 2. Server: git clone --depth 1 → cache/sources/agency-agents-zh/
  ├─ 3. Server: 三层降级发现资源
  │     → 约定扫描 → 发现 215 个 agents
  ├─ 4. Server: 注册到 registry.json（source entry + 215 resource entries）
  ├─ 5. Server: 添加到 config.yaml resource_sources.trusted
  └─ 6. AuditLogger.log("source.added", { count: 215 })

octopus resource install git:https://github.com/jnMetaCode/agency-agents-zh --scope user
  │
  ├─ 1. Server: 从 registry 查找 source 的所有资源
  ├─ 2. Server: 检查 allowlist → 已信任
  ├─ 3. Server: 执行 setup（如果有）
  ├─ 4. Server: 对每个 resource: 从 cache 复制到 ~/.claude/agents/{name}.md
  ├─ 5. Server: 更新 registry (installed=true) + lock + audit
  └─ 6. 输出: ✓ Installed 215 agents from agency-agents-zh to ~/.claude/agents/
```

### 配套 Skills

#### `octo-source-analyzer`（AI 分析 skill）

**用途**：分析 GitHub repo 的 README.md + 目录结构，生成 `octopus-resource.json`。

**触发场景**：
- `octopus resource source add` 且无 manifest 时自动调用
- Agent 在对话中被要求"分析这个 repo"时手动调用

**职责**：
- 读 README.md 提取安装命令
- 扫描目录结构识别 skill/agent/workflow
- 生成 manifest JSON
- 写入缓存

#### `octo-resource-manager`（CLI 参考 skill）

**用途**：教 agent 如何使用 `octopus resource` 命令。

**内容覆盖**：
- 所有 `octopus resource` 子命令用法和示例
- Source 管理流程（add → install → update）
- Scope 选择指南
- 常见问题排查（安装失败、漂移修复、审计查询）
- 与 `octo-source-analyzer` 的配合方式

**位置**：`core-pack/skills/octo-resource-manager/SKILL.md`

### 模块划分

```
shared/src/resource/
├── ... (现有模块)
├── source-manager.ts          # SourceManager (add/remove/update/list/analyze)
├── source-discovery.ts        # 三层降级：manifest → AI → 约定扫描
└── providers/
    ├── git-provider.ts        # git clone --depth 1 + 缓存管理
    └── npm-provider.ts        # npm pack + 解压（Phase 2，如有需要）

core-pack/skills/
├── octo-source-analyzer/SKILL.md   # AI 分析 skill
└── octo-resource-manager/SKILL.md  # CLI 参考 skill
```

