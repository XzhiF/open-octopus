# 2. 架构设计

## 2.1 三层架构

```
┌─────────────────────────────────────────────────────────┐
│                    Web UI (web-app)                      │
│  资源浏览器 · 安装管理 · 信任管理 · 审计日志             │
│  /resources  /resources/install  /resources/audit        │
└────────────────────────┬────────────────────────────────┘
                         │ HTTP REST + SSE
┌────────────────────────┴────────────────────────────────┐
│                   Server API (server)                    │
│  /api/resources/* 路由                                   │
│  ResourceService ← ResourceManager ← SourceProviders     │
└────────────────────────┬────────────────────────────────┘
                         │ 共享核心
┌────────────────────────┴────────────────────────────────┐
│                  Core (shared + cli)                     │
│                                                          │
│  packages/shared/src/resource/    ← 类型 + 解析 + 工具  │
│  packages/cli/src/resource/       ← CLI 命令 + 操作层   │
│                                                          │
│  ResourceManager · RegistryStore · TrustStore            │
│  SourceProvider(npm/git/local/builtin)                   │
│  DependencyResolver · AtomicJsonStore · AuditLogger      │
└─────────────────────────────────────────────────────────┘
```

### 为什么 core 在 CLI 而不是 shared

PR #12 把核心逻辑分散在 `shared/src/repository/` 和 `cli/src/repository/` 两处，导致双轨问题。

**新设计**：

| 层 | 放什么 | 不放什么 |
|---|---|---|
| `shared/src/resource/` | 纯类型（Zod Schema）、纯工具函数（hash/path/format）、接口定义 | 有状态的 class、fs 操作 |
| `cli/src/resource/` | ResourceManager class、RegistryStore、SourceProviders、所有 fs 操作 | — |
| `server/src/services/resource/` | ResourceService（薄包装）→ 调用 cli 的 ResourceManager | 重复实现 |

Server 通过 **import cli 的 ResourceManager** 复用核心逻辑，而不是自己再实现一遍。

## 2.2 模块划分

```
packages/shared/src/resource/
├── types.ts                 # ResourceManifest, RegistryEntry, LockFile, SourceRef 等 Zod Schema
├── errors.ts                # ResourceError 错误类（从 PR #12 的 RepoError 改名）
├── utils.ts                 # isPathWithinBase, formatBytes, formatSourceRef, computeHash
├── dependency-resolver.ts   # DependencyResolver class（DFS + 环检测）
└── index.ts                 # 统一导出

packages/cli/src/resource/
├── manager.ts               # ResourceManager（核心编排）
├── registry.ts              # RegistryStore（registry.json 读写）
├── installer.ts             # WorkspaceInstaller（安装到 workspace）
├── uninstaller.ts           # WorkspaceUninstaller
├── gc.ts                    # 垃圾回收（扫描未使用缓存）
├── lock-manager.ts          # resources.lock 读写 + 漂移检测
├── audit-logger.ts          # AuditLogger（JSONL 追加）
├── security.ts              # SecurityContext + TrustStore（TOFU）
├── output.ts                # OutputFormatter（rich/json/quiet）
├── providers/
│   ├── types.ts             # SourceProvider 接口
│   ├── npm-provider.ts      # npm tarball 下载
│   ├── git-provider.ts      # git clone --depth 1
│   ├── local-provider.ts    # 本地目录复制
│   └── builtin-provider.ts  # core-pack 内置资源
└── commands/
    └── resource.ts          # octopus resource 命令组（12 子命令）

packages/server/src/services/resource/
├── resource-service.ts      # ResourceService（薄包装 ResourceManager）
└── index.ts

packages/server/src/routes/resource/
├── index.ts                 # /api/resources/* 路由注册
├── list.ts                  # GET /api/resources
├── install.ts               # POST /api/resources/install
├── uninstall.ts             # POST /api/resources/uninstall
├── search.ts                # GET /api/resources/search
├── info.ts                  # GET /api/resources/:type/:name
├── trust.ts                 # POST /api/resources/trust
└── audit.ts                 # GET /api/resources/audit
```

## 2.3 与现有模块的关系

```
                    octopus resource install brainstorming
                              │
                              ▼
                    ┌──────────────────┐
                    │ ResourceManager  │
                    │  .install()      │
                    └────────┬─────────┘
                             │
              ┌──────────────┼──────────────────┐
              ▼              ▼                   ▼
      ┌─────────────┐ ┌───────────┐    ┌──────────────┐
      │SourceProvider│ │Dependency │    │SecurityContext│
      │  .fetch()   │ │ Resolver  │    │  .check()    │
      └──────┬──────┘ │ .resolve()│    └──────┬───────┘
             │        └─────┬─────┘           │
             ▼              ▼                  ▼
      ┌──────────────────────────────────────────────┐
      │          ~/.octopus/resources/                │
      │  cache/  manifests/  registry.json            │
      │  trusted-sources.yaml  audit.jsonl            │
      └──────────────────┬───────────────────────────┘
                         │
                         ▼  安装到 workspace
      ┌──────────────────────────────────────────────┐
      │  workspace/.claude/skills/brainstorming/      │
      │  workspace/.claude/agents/reviewer.md          │
      │  workspace/.octopus/resources.lock             │
      └──────────────────────────────────────────────┘
```

## 2.4 闭环集成设计

资源安装后必须被现有系统自动发现。以下是 4 种资源类型 × 3 个消费者的完整接线。

### 消费者

| 消费者 | 场景 | 代码位置 |
|--------|------|---------|
| **Octopus Agent** (SkillLoader) | server 端 AI 助手对话时使用 skill | `server/src/services/agent/skill-loader.ts` |
| **AgentExecutor** (engine) | workflow agent 节点执行时使用 skill + agent | `engine/src/executors/agent.ts` |
| **SwarmExecutor** (engine) | workflow swarm 节点动态选择 expert agent | `engine/src/executors/swarm.ts` |

### 接线矩阵

| 资源类型 | 安装位置 | SkillLoader | AgentExecutor | SwarmExecutor |
|---------|---------|-------------|---------------|---------------|
| **skill** | `workspace/.claude/skills/{name}/` | ⚡ 新增 Tier 0 | ✅ provider 传 skill 名 | ✅ expert 的 skills 选项 |
| **agent** | `workspace/.claude/agents/{name}.md` | N/A | ✅ resolveAgents() 读 agent_file | ✅ RoleRegistry 扫描 |
| **workflow** | `workspace/.octopus/workflows/{name}.yaml` | N/A | N/A | N/A（CLI 直接读取） |
| **source** | `workspace/dependencies/{name}/` | N/A | ⚡ VarPool 注入 $deps 路径 | N/A |

### 接线 ① SkillLoader 新增 Tier 0

现有 SkillLoader 三层扫描：
```
Tier 1: ~/.octopus/agent/skills/   (local evolved, 最高优先级)
Tier 2: core-pack/skills/          (builtin)
Tier 3: prod/core-pack/skills/     (prod copy, 最低优先级)
```

新增 Tier 0（最高优先级）：
```
Tier 0: workspace/.claude/skills/  (resource installed)  ← 新增
Tier 1: ~/.octopus/agent/skills/   (local evolved)
Tier 2: core-pack/skills/          (builtin)
Tier 3: prod/core-pack/skills/     (prod copy)
```

**理由**：用户通过 `resource install` 显式安装的 skill 应该优先于内置 skill。

**改动范围**：`SkillLoader` 构造函数接受 `workspaceDir` 参数，扫描时加入 Tier 0。

### 接线 ② AgentExecutor skill 解析

Agent 节点通过 `node.skills: string[]` 将 skill 名字传给 provider：

```
AgentExecutor
  → AgentNodeRunner.run({ skills: ["brainstorming"] })
    → provider.sendQuery(prompt, cwd, ..., { skills: ["brainstorming"] })
      → Claude provider: Claude SDK 自动从 cwd/.claude/skills/ 读取 ✅
      → Pi provider: enhancePromptWithSkills() 需要加 cwd 扫描逻辑 ⚡
```

**改动范围**：`PiAgentProvider.sendQuery()` 中的 `enhancePromptWithSkills()` 需要从 `cwd/.claude/skills/` 读取 SKILL.md 内容注入 prompt。

### 接线 ③ source 路径变量注入

Workflow bash 节点引用 source 资源时，通过 VarPool 自动注入路径：

```yaml
# workflow YAML
nodes:
  - id: build
    type: bash
    command: "cd $deps.octopus-utils && npm run build"
```

引擎在创建 agent/bash 节点时，从 `workspace/dependencies/` 扫描已安装的 source，注入变量：

```
VarPool:
  $deps.octopus-utils = /path/to/workspace/dependencies/octopus-utils
  $deps.another-lib   = /path/to/workspace/dependencies/another-lib
```

**改动范围**：`WorkflowEngine` 构造函数接受 `workspaceDir`，启动时扫描 `dependencies/` 注入 `$deps.*` 变量。

### 闭环流程图

```
octopus resource install brainstorming --type skill
  │
  ├─ 1. ResourceManager.install()
  │     → cache/skill/brainstorming@hash/  (全局缓存)
  │     → workspace/.claude/skills/brainstorming/  (安装目标)
  │     → resources.lock 记录
  │
  ├─ 2. SkillLoader Tier 0 扫描  [自动，无需接线]
  │     → 发现 brainstorming/SKILL.md
  │     → Octopus Agent 对话中可调用 /brainstorming
  │
  ├─ 3. AgentExecutor agent 节点  [自动]
  │     → node.skills = ["brainstorming"]
  │     → Claude provider: SDK 从 cwd/.claude/skills/ 读取 ✅
  │     → Pi provider: enhancePromptWithSkills() 注入 ✅
  │
  └─ 4. SwarmExecutor expert  [自动]
        → expert.skills = ["brainstorming"]
        → 同 3 的路径

octopus resource install octopus-utils --type source
  │
  ├─ 1. ResourceManager.install()
  │     → workspace/dependencies/octopus-utils/
  │
  └─ 2. WorkflowEngine VarPool 注入  [⚡ 需要实现]
        → $deps.octopus-utils = /abs/path/to/dependencies/octopus-utils
        → bash 节点 command 引用 $deps.octopus-utils
```

### 需要改动的现有代码

| 文件 | 改动 | 大小 |
|------|------|------|
| `server/src/services/agent/skill-loader.ts` | 加 Tier 0 workspaceDir 扫描 | ~20 行 |
| `providers/src/pi/prompt-enhancer.ts` | enhancePromptWithSkills 加 cwd 扫描 | ~30 行 |
| `engine/src/engine.ts` | 构造时扫描 dependencies/ 注入 $deps.* | ~20 行 |

总计 ~70 行改动即可闭环。

