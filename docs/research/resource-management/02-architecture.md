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

### 与 SkillLoader 的集成

安装后 SkillLoader 自动发现新 skill（因为它扫描 workspace/.claude/skills/）。
不需要额外接线 — 文件系统就是通信机制。

### 与 Swarm RoleRegistry 的集成

安装 agent 到 `~/.octopus/agents/` 后 RoleRegistry 自动发现（因为它扫描该目录）。
同理，不需要额外接线。
