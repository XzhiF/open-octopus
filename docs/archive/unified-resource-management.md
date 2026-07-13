# 统一资源管理架构文档

> Octopus 统一资源管理系统提供 skill/agent/workflow 的安装、卸载、来源管理和工作流前置检查。
> 覆盖 builtin（core-pack）、local（本地路径）、git（第三方仓库）三种资源来源，
> 通过 Agent 委托 + 静态扫描双层策略，适配千差万别的第三方仓库结构。

---

## 1. 整体架构

```
                      ┌──────────────────────────────────────┐
                      │           调用方（三入口）              │
                      │  CLI (octopus resource ...)          │
                      │  Web-app (REST API client)           │
                      │  Workspace (工作流前置检查)            │
                      └─────────────┬────────────────────────┘
                                    │ HTTP /api/resources/*
                      ┌─────────────▼────────────────────────┐
                      │     Server: routes/resource/index.ts │
                      │     Hono 路由 + 中间件链              │
                      │     requireJsonContentType            │
                      │     → validateTypeParam/NameParam    │
                      │     → withResourceLock（并发锁）       │
                      │     → withErrorCatch                 │
                      └─────────────┬────────────────────────┘
                                    │
        ┌───────────────────────────┼───────────────────────────┐
        │                           │                           │
        ▼                           ▼                           ▼
  ResourceManager         SourceManager             ResourceAgentService
  (核心编排)              (git 来源生命周期)          (Agent 委托层)
        │                           │                           │
        │                           │                           │
        ▼                           ▼                           ▼
   ┌────┴────┐              ┌───────┴───────┐           ┌───────┴───────┐
   │Provider │              │ GitProvider   │           │Orchestrator   │
   │Builtin  │              │ SourceDiscovery│          │AgentService   │
   │Local    │              │ TrustManager   │          │               │
   │         │              │ SourcesStore   │          │  octo-resource│
   └────┬────┘              └───────┬───────┘           │  -manager     │
        │                           │                    │  octo-source  │
        ▼                           ▼                    │  -analyzer    │
   ~/.octopus/resources/        ~/.octopus/              └───────┬───────┘
   ├── installed/{type}/        config.yaml                       │
   ├── registry.json            (trust allowlist)                ▼
   ├── resources.lock                                     Agent 自主执行
   ├── audit.jsonl                                         安装/同步逻辑
   └── sources/{name}/
```

---

## 2. 存储布局

```
~/.octopus/
├── config.yaml                               ← TrustManager: resource_sources.trusted[]
├── resources/                                ← ResourceManager.basePath
│   ├── registry.json                         ← RegistryStore: 已安装资源清单
│   ├── registry.json.bak                     ← 原子写入恢复备份
│   ├── resources.lock                        ← LockManager: 资源指纹（hash/文件数/路径）
│   ├── resources.lock.bak
│   ├── sources.json                          ← SourcesStore: git 来源清单
│   ├── sources.json.bak
│   ├── audit.jsonl                           ← AuditWriter: 追加式 JSONL 审计日志
│   ├── installed/                            ← 已安装资源文件
│   │   ├── skills/{group}/{name}/
│   │   ├── agents/{group}/{name}/{name}.md
│   │   └── workflows/{group}/{name}/
│   └── sources/                              ← git 来源缓存
│       └── {sourceName}/                     ← GitProvider shallow clone
├── agent/skills/{name}/                      ← Agent 进化后的本地 skill
└── orgs/{org}/
```

### registry.json 字段

```json
{
  "version": 1,
  "resources": [
    {
      "name": "brainstorming",
      "type": "skill",
      "source": "builtin",
      "ref": "builtin:brainstorming",
      "group": "built-in",
      "installed": true,
      "verified": true,
      "status": "installed",
      "installedAt": "2026-07-13T...",
      "scope": "org",
      "installPath": "/Users/EDY/.octopus/resources/installed/skills/built-in/brainstorming",
      "dependsOn": [],
      "sourceHash": "abc123...",
      "syncedAt": "..."
    }
  ]
}
```

---

## 3. 资源生命周期

### 3.1 安装（Install）

```
ref (builtin:xxx / local:/path / git:source/path)
  │
  ▼
parseRef() → { type, name, provider }
  │
  ▼
检查未安装（ALREADY_INSTALLED）
  │
  ▼
Provider 复制文件 → installed/{type}s/{group}/{name}/
  │
  ▼
RegistryStore.upsert() → registry.json
  │
  ▼
LockManager 记录指纹 → resources.lock
  │
  ▼
AuditWriter 记录审计 → audit.jsonl（写前审计）
  │
  ▼
ResourceManager.verify() → 验证步骤
  │
  ▼
updateClaudeMd() → 更新 CLAUDE.md 可用资源段
  │
  ▼
emit("resource:installed")
```

### 3.2 卸载（Uninstall）

```
name + type
  │
  ▼
findDependents() → 检查反向依赖（有依赖则拒绝）
  │
  ▼
删除 installed/ 下文件
  │
  ▼
RegistryStore.remove() → registry.json
  │
  ▼
AuditWriter 记录
  │
  ▼
verify-clean → 确认彻底删除
  │
  ▼
updateClaudeMd()
```

### 3.3 批量来源安装（Source Install）

```
POST /source/install { sourceName, all: true }
  │
  ▼
SourceManager.getDiscoveredResources()
  → SourceDiscovery.discover(cachePath)
  → 返回 [{type, name, path}, ...]
  │
  ▼
（即使返回空列表也走 agent，不短路）
  │
  ▼
ResourceAgentService.installFromSource()
  │
  ├─ Agent 有资源列表：按列表执行安装
  ├─ Agent 资源列表为空：Agent 自主分析仓库结构 + 安装
  │
  ▼
OrchestratorService.executeTask()
  → 加载 octo-resource-manager skill
  → Agent 执行安装逻辑（检查安装脚本/复制/注册）
  │
  ▼
Agent 失败 → fallbackInstall()
  → 直接调 ResourceManager.installFromSource()
```

---

## 4. 来源管理（Source Management）

### 4.1 Source 生命周期

```
source add <url>
  │
  ▼
TrustManager 检查/提示信任
  │
  ▼
GitProvider.clone() → shallow clone 到 sources/{name}/
  │
  ▼
SourceDiscovery.discover() → 统计资源数
  │
  ▼
SourcesStore.upsert() → sources.json

source sync <name>
  │
  ▼
GitProvider.pull() → --ff-only
  │
  ▼
SourceDiscovery.discover() → 重新扫描
  │
  ▼
ResourceAgentService.syncSource()
  → Agent 对比文件 hash（changed/unchanged/added/orphan）
  → 更新 changed、报告 added/orphan

source remove <name>
  │
  ▼
GitProvider.clean() → 删除缓存
  │
  ▼
TrustManager 移除信任
  │
  ▼
SourcesStore.remove()
```

### 4.2 信任机制（TrustManager）

| 来源 | 信任级别 | 行为 |
|------|---------|------|
| builtin | 始终信任 | 直接使用 |
| local | 始终信任 | 路径在 allowlist 内 |
| git | 显式信任 | 必须加入 `config.yaml` 的 `resource_sources.trusted[]` |

信任是安全边界：未信任的 git URL 在 `source add` 阶段被拒绝。

---

## 5. 资源发现（SourceDiscovery）

双层策略，命中即返回：

### Layer 1: Manifest（`octopus-resource.json`）

```json
{
  "name": "my-skills",
  "resources": [
    { "name": "foo", "type": "skill", "path": "skills/foo" }
  ],
  "skills": ["skills/bar"],
  "agents": ["agents/baz.md"],
  "workflows": ["workflows/wf.yaml"]
}
```

### Layer 2: 约定扫描

| 类型 | 扫描路径 | 识别标记 |
|------|---------|---------|
| skill | `skills/` 递归 | `{name}/SKILL.md` |
| agent | `agents/` 递归 + 根目录分类 | `*.md`（非 README/INDEX 等元文件） |
| workflow | `workflows/` | `*.yaml` / `*.yml` |

递归扫描：`scanSkillCategory` / `scanAgentCategory` 处理嵌套分类目录（如 mattpocock-skills 的 `skills/engineering/code-review/SKILL.md`）。

根目录 fallback：`scanRootCategories` 处理 agents 不在 `agents/` 下而在根目录分类下的仓库（如 agency-agents-zh 的 `engineering/architect.md`）。

名字冲突消歧：`disambiguateNames()` 给重名资源追加父目录后缀（`architect` → `architect-engineering`）。

---

## 6. Agent 委托层（ResourceAgentService）

### 设计原则

除 Engine 执行外，所有资源操作走 Orchestrator Agent，实现统一审计、高容错、可观测。
ResourceManager 仅作为数据层被 Agent 间接调用。

### 委托场景

| 操作 | Agent Skill | 降级策略 |
|------|------------|---------|
| source install | octo-resource-manager | fallbackInstall() 直接调 ResourceManager |
| source sync | octo-source-analyzer + octo-resource-manager | fallbackSync() 直接调 ResourceManager |

### installFromSource 执行策略

```
1. 检查源仓库安装脚本（setup.sh / install.sh / Makefile / package.json scripts）
   └─ 有 → 按仓库自身流程执行
2. 无安装脚本 → 从 sources/ 缓存复制到 installed/
3. 解析 agent frontmatter 的 skills: 字段，递归安装依赖
4. 注册到 registry.json
5. 失败记录错误继续下一个
6. 报告 installed/skipped/errors 数量
```

### 资源列表为空时的 Agent 自主发现

当 `getDiscoveredResources()` 返回空列表，Agent 任务 prompt 切换为自主发现模式：
1. 分析仓库结构，确定资源类型和位置
2. 检查安装脚本
3. 识别所有资源
4. 执行安装 + 注册

### 结果解析

`parseInstallResult()` 从 Agent 日志提取 `installed: N` / `skipped: N` / `errors: N`。
无法解析时保守估计 installed = total。

---

## 7. 验证与前置检查

### 7.1 资源验证（verify）

安装完成后自动执行验证步骤：

| 步骤 | 检查内容 |
|------|---------|
| files_exist | installed/ 路径下文件存在 |
| hash_match | 文件 hash 与 resources.lock 记录一致 |
| frontmatter_valid | agent .md frontmatter 格式正确（name/description/tools） |
| skill_manifest | skill SKILL.md 存在且可读 |

返回 `{ passed, steps[] }`，status 映射为 `installed` 或 `installed_but_unverified`。

### 7.2 工作流前置检查（ResourcePreFlight）

```
workflow YAML
  │
  ▼
ResourcePreFlight.analyze()
  → 提取所有 agent 引用 + skill 引用
  → 检查 workspace .claude/agents/ 和 .claude/skills/
  │
  ▼
{ available: [...], missing: [...] }
```

### 7.3 工作流资源供给（ResourceProvisioner）

```
missing 列表
  │
  ▼
ResourceProvisioner.provision(missing, workspaceDir)
  → 从 ~/.octopus/resources/installed/ 复制到 workspace .claude/agents/ | .claude/skills/
  → 递归复制 agent 的 skills 依赖
```

---

## 8. 并发控制

### 服务器级锁（withResourceLock）

| 特性 | 值 |
|------|---|
| 粒度 | 按 lockKey（资源名 / source:name:install 等） |
| 超时 | 30 秒 |
| 冲突 | 返回 `LOCK_BUSY` (409) |
| 适用 | install/uninstall/source 操作 |

### 文件级原子写入（atomic-json-store）

| 特性 | 值 |
|------|---|
| 写入策略 | 写入临时文件 → rename 覆盖 |
| 恢复 | 主文件损坏时从 `.bak` 恢复 |
| Schema | Zod 验证 + 旧格式自动迁移 |

---

## 9. 错误体系

`ResourceError` 定义 32 个错误码，HTTP 状态映射 + 用户建议：

| 类别 | 典型错误码 | HTTP |
|------|----------|------|
| 资源生命周期 | RESOURCE_NOT_FOUND / ALREADY_INSTALLED / RESOURCE_LOCKED | 404 / 409 / 409 |
| 注册表/锁 | REGISTRY_CORRUPT / LOCK_BUSY | 500 / 409 |
| Git 来源 | SOURCE_NOT_FOUND / SOURCE_CLONE_FAILED / SOURCE_UNTRUSTED | 404 / 502 / 403 |
| 路径安全 | PATH_TRAVERSAL / INVALID_REF / SYMLINK_REJECTED | 400 |
| Provider | PROVIDER_ERROR / COPY_FAILED | 500 |

---

## 10. CLI 命令

```bash
octopus resource install <ref>              # 安装（builtin:xxx / local:/path）
octopus resource uninstall <name> --type    # 卸载
octopus resource list                       # 列表
octopus resource info <name>                # 详情
octopus resource audit                      # 审计日志
octopus resource search <query>             # 搜索 builtin
octopus resource stats                      # 统计

octopus resource source add <url>           # 添加 git 来源
octopus resource source list                # 来源列表
octopus resource source update <name>       # 拉取 + 重新发现
octopus resource source remove <name>       # 移除来源
octopus resource source analyze <url>       # 预览（不持久化）
octopus resource source info <name>         # 来源详情
octopus resource source install <name>      # 批量安装来源资源
octopus resource source sync <name>         # 同步（hash 对比）
```

所有命令通过 `apiRequest()` 调用 `http://localhost:3001/api/resources/*`。

---

## 11. REST API

| Method | Path | 说明 |
|--------|------|------|
| GET | `/api/resources/` | 列表（支持 type/query/installed 过滤） |
| GET | `/api/resources/stats` | 注册表统计 |
| GET | `/api/resources/audit` | 审计日志 |
| GET | `/api/resources/builtin` | 可用 builtin 目录（含 installed 标记） |
| POST | `/api/resources/install` | 按 ref 安装 |
| POST | `/api/resources/uninstall` | 按 name+type 卸载 |
| POST | `/api/resources/source/add` | 添加 git 来源 |
| POST | `/api/resources/source/install` | 批量安装来源资源（Agent 委托） |
| POST | `/api/resources/source/sync` | 同步来源（Agent 委托） |
| GET | `/api/resources/source/list` | 来源列表 |
| POST | `/api/resources/source/update` | 拉取 + 重新发现 |
| POST | `/api/resources/source/analyze` | 预览 URL（不持久化） |
| GET | `/api/resources/source/:name` | 来源详情 |
| DELETE | `/api/resources/source/:name` | 移除来源 |
| GET | `/api/resources/:type/:name` | 资源详情 |
| GET | `/api/resources/:type/:name/verify` | 验证步骤 |
| GET | `/api/resources/:type/:name/files` | 文件列表/内容 |

---

## 12. 数据流总览

```
安装流:
  ref → parseRef → Provider.copy → RegistryStore.upsert → LockManager.set
      → AuditWriter.append → verify → updateClaudeMd → emit event

卸载流:
  name+type → findDependents (check) → rm files → RegistryStore.remove
             → AuditWriter.append → verify-clean → updateClaudeMd

工作流执行流:
  workflow YAML → ResourcePreFlight.analyze → missing list
               → ResourceProvisioner.provision → workspace .claude/
```

---

## 13. 关键设计决策

### 为什么 source install 走 Agent 而不是直接 ResourceManager

1. **仓库结构千差万别** — 静态扫描只能覆盖常见模式；Agent 可以理解安装脚本、处理依赖、识别非标准结构
2. **统一审计** — Agent 执行过程有完整日志，ResourceManager 直接调用只能记录结果
3. **降级兜底** — Agent 失败自动 fallback 到 ResourceManager 直接操作，三层保障
4. **可观测性** — Agent 返回的 `agentLog` 可供用户查看执行过程

### 为什么静态扫描返回空时仍调用 Agent

早期 bug：`resources.length === 0` 直接返回 `{ installed: 0 }`，跳过 Agent。
但静态扫描失败不代表仓库没资源，只是扫描器无法识别。
Agent 拿到 cachePath 后可自主分析仓库结构。

### 为什么 install 路径按 `{type}s/{group}/{name}/` 组织

- group 隔离不同来源的资源（built-in / mattpocock / agency-agents-zh 等）
- 同名资源不同 group 可共存
- 卸载时按 group 定位，避免误删

---

## 14. 相关文件索引

| 文件 | 职责 |
|------|------|
| `packages/shared/src/resource/resource-manager.ts` | 核心编排（829 行） |
| `packages/shared/src/resource/source-manager.ts` | git 来源生命周期 |
| `packages/shared/src/resource/source-discovery.ts` | 资源发现（manifest + 约定扫描） |
| `packages/shared/src/resource/types.ts` | Zod schema + TypeScript 类型 |
| `packages/shared/src/resource/errors.ts` | 错误码 + HTTP 映射 |
| `packages/shared/src/resource/registry-store.ts` | registry.json CRUD |
| `packages/shared/src/resource/lock-manager.ts` | resources.lock 指纹管理 |
| `packages/shared/src/resource/audit-writer.ts` | 审计日志 |
| `packages/shared/src/resource/trust-manager.ts` | git 来源信任管理 |
| `packages/shared/src/resource/sources-store.ts` | sources.json CRUD |
| `packages/shared/src/resource/builtin-provider.ts` | core-pack 资源安装 |
| `packages/shared/src/resource/local-provider.ts` | 本地路径安装 |
| `packages/shared/src/resource/providers/git-provider.ts` | git clone/pull |
| `packages/shared/src/resource/resource-preflight.ts` | 工作流前置检查 |
| `packages/shared/src/resource/resource-provisioner.ts` | 工作流资源供给 |
| `packages/server/src/routes/resource/index.ts` | REST 路由 |
| `packages/server/src/routes/resource/middleware.ts` | 中间件链 |
| `packages/server/src/services/resource-agent-service.ts` | Agent 委托层 |
| `packages/server/src/services/resource-registry.ts` | ResourceManager 全局单例 |
| `packages/cli/src/commands/resource.ts` | CLI 命令 |
| `packages/web-app/lib/resource/api.ts` | Web API 客户端 |
| `packages/core-pack/skills/octo-resource-manager/SKILL.md` | Agent 安装 skill |
| `packages/core-pack/skills/octo-source-analyzer/SKILL.md` | Agent 分析 skill |
