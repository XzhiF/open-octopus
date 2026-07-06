# 00 — 需求发现与假设质疑

> 阶段: 需求发现（产品经理视角）
> 日期: 2026-07-06
> 输入: `docs/research/resource-management/`（7 章设计文档）
> 项目类型: hybrid（核心逻辑提升到 shared + Server API + Web UI）

---

## 1. 问题陈述

### 1.1 谁有痛点

| 角色 | 痛点 | 频率 | 当前 Workaround |
|------|------|------|-----------------|
| **Octopus 开发者（内部）** | 安装 community skill 需要手动 git clone → 找目录 → 复制文件 → 祈祷路径对 | 每周 3-5 次 | 手动 `cp`，经常装错位置 |
| **Octopus 开发者（内部）** | 不知道 workspace 装了哪些 skill/agent，config.json 与实际文件经常漂移 | 每天 | 用 `ls` 和 `find` 手动检查 |
| **工作流开发者** | workflow YAML 引用 skill 但无法声明依赖，执行时才发现 skill 缺失 | 每次新工作流 | 手动在 README 里写依赖列表 |
| **AI Agent（工作流节点）** | 需要在执行中安装 skill 但没有编程接口，只能调 CLI | 按需 | 通过 bash 节点 hack |
| **平台运维** | skill 被 evolution 修改后无版本追溯，出了问题无法回滚 | 每月 2-3 次 | 靠 `.bak` 文件手动对比 |

### 1.2 不解决的代价

- **开发效率损耗**: 每次资源安装约 5-10 分钟手动操作，团队每周浪费 1-3 小时
- **工作流脆弱性**: skill 缺失导致的工作流执行失败无法自动恢复，只能人工介入
- **知识孤岛**: 资源分散在 3 个目录、无统一视图，新人上手成本高
- **技术债务累积**: 资源管理无统一方案，每次都是 ad-hoc 处理
- **CLI-Server 断层**: Server 无法管理资源意味着 Web UI 永远缺少资源管理能力，平台不完整

### 1.3 问题频率矩阵

```
         高频              低频
    ┌─────────────┬─────────────┐
高  │ 资源发现/列表 │ 远程安装     │
痛  │ 漂移检测     │ 信任管理     │
    ├─────────────┼─────────────┤
低  │ 版本查看     │ GC 清理      │
痛  │ 依赖树查看   │ 审计导出     │
    └─────────────┴─────────────┘

→ MVP 应聚焦左上象限（高频高痛），其余可以后做但不能留 TODO
```

---

## 2. 问题证据

### 2.1 内部信号

| 证据 | 来源 | 强度 |
|------|------|------|
| 用户明确说"CLI 端实现 resource 有弊端，应该在 server 端" | 用户原始 idea | ⭐⭐⭐⭐⭐ Server-First 方向确认 |
| shared/src/ 已有 136 处 fs 操作（11 个文件） | grep 统计 | ⭐⭐⭐⭐⭐ shared 放 ResourceManager 是模式延续 |
| `~/.octopus/agent/skills/` 里有 `.bak` 文件堆积 | 文件系统 | ⭐⭐⭐⭐ 版本管理缺失的直接证据 |
| SkillLoader 3 层扫描硬编码路径 | `skill-loader.ts` 源码 | ⭐⭐⭐⭐ 当前设计不支持扩展 |
| core-pack/skills/ 持续增长但无安装机制 | core-pack 目录 | ⭐⭐⭐ 内置资源越来越多 |
| PR #12 代码在当前分支 0 匹配 | grep 全仓库 | ⭐⭐⭐⭐⭐ 这是 greenfield 项目 |

### 2.2 竞品分析

| 竞品/类似产品 | 资源管理方式 | Octopus 差距 |
|--------------|-------------|-------------|
| **Cursor** | 内置 skill marketplace，一键安装 | 无 marketplace，手动管理 |
| **Cline** | `.clinerules` 文件 + MCP servers | 更简单但无版本管理 |
| **OpenHands** | Docker 容器 + micro-agents | 有 registry 但无 UI |
| **npm/pip/cargo** | 成熟的包管理器（registry + lock + deps） | PR #12 试图复制但未到位 |
| **VS Code Extensions** | marketplace + 自动更新 + 版本锁定 | 最接近 Octopus 需要的心智模型 |

### 2.3 替代方案分析

| 方案 | 优点 | 缺点 | 是否采纳 |
|------|------|------|---------|
| **A: 维持现状 + 手动管理** | 零成本 | 不可持续，痛点持续 | ❌ |
| **B: 仅 CLI（PR #12 原样合并）** | 快速上线 | Server/UI 断层，命名冲突 | ❌ |
| **C: 用户设计方案（7 章文档）** | 完整、三层、渐进 | 架构有缺陷（见下），范围过大 | ⚠️ 需调整 |
| **D: Core-in-shared + Server API + Web UI** | 架构干净，Server 不依赖 CLI | 需更多 shared 层改动 | ✅ 推荐 |

---

## 3. 目标用户群体

### 3.1 用户画像

**主用户: Octopus 平台开发者（3-5 人）**
- 日常使用 Octopus 工作流编排
- 需要在多个 workspace 间管理 skill/agent
- 技术水平高，CLI 和 Web UI 都会用
- 痛点集中在「安装太麻烦」和「不知道装了什么」

**次用户: AI Agent（工作流节点）**
- 需要在执行过程中编程式安装资源
- 通过 Server API 调用（非 CLI）
- 需要确定性行为（无交互确认）

**未来用户: 社区贡献者**
- 编写并分享 skill/agent
- 期望简单的发布和安装流程
- 目前不在范围内（不做 publish）

### 3.2 规模评估

- 当前: 3-5 人核心团队
- 6 个月内: 10-20 人（如果社区增长）
- 12 个月内: 50-100 人（如果开源）
- 资源管理复杂度随用户数线性增长，**现在是建设的最佳窗口**——用户少，迁移成本低

---

## 4. 机会假设

### 4.1 为什么现在是好时机

1. **Server 已有 Hono + SSE 基础设施** — 新增路由只需遵循现有模式
2. **Web-app 已有 Agent/Settings/Workspaces 页面** — 新增 Resources 页面有参考
3. **SkillLoader 刚完成 3 层重构** — 加 Tier 0 改动可控
4. **shared 已有 fs 操作先例**（136 处，11 文件）— ResourceManager 是模式延续
5. **用户规模小** — 迁移不会造成大面积 breakage

### 4.2 核心差异化

- **与 IDE 插件市场不同**: Octopus 资源管理是「工作流编排平台的资产管理」，不是通用插件市场
- **与 npm/pip 不同**: 资源类型多样（skill/agent/workflow/source），不是单一包格式
- **独特价值**: 资源安装后**自动被工作流引擎和 AI Agent 发现**——闭环集成是杀手特性

---

## 5. 假设质疑与架构问题

> ⚠️ 这是本文档最重要的部分。以下逐条质疑用户设计方案中的每个关键假设。

### 5.1 🔴 CRITICAL: 核心逻辑应在 shared 而非 CLI

**用户设计**: Core 在 `cli/src/resource/`，Server 通过 import CLI 的 ResourceManager 复用。

**问题**:
- 当前包依赖: `server ← shared + engine + core-pack + providers`
- **server 不依赖 cli**。让 server import cli 会引入新依赖，增加耦合
- CLI 有 Commander.js 等 CLI-only 依赖，server 不需要
- 如果 server 和 cli 都 import shared，核心逻辑放 shared 更干净

**推荐方案**:

```
shared/src/resource/
├── types.ts                    # Zod Schema（纯类型）
├── errors.ts                   # ResourceError
├── utils.ts                    # hash/path/format 工具
├── dependency-resolver.ts      # 依赖解析
├── manager.ts                  # ResourceManager（核心编排）← 从 CLI 提升
├── registry.ts                 # RegistryStore               ← 从 CLI 提升
├── installer.ts                # WorkspaceInstaller           ← 从 CLI 提升
├── uninstaller.ts              # WorkspaceUninstaller         ← 从 CLI 提升
├── lock-manager.ts             # LockManager                  ← 从 CLI 提升
├── audit-logger.ts             # AuditLogger                  ← 从 CLI 提升
├── gc.ts                       # 垃圾回收                     ← 从 CLI 提升
├── security.ts                 # SecurityContext + TrustStore  ← 从 CLI 提升
└── providers/                  # SourceProvider 接口 + 4 实现  ← 从 CLI 提升
    ├── types.ts
    ├── npm-provider.ts
    ├── git-provider.ts
    ├── local-provider.ts
    └── builtin-provider.ts

cli/src/resource/
├── commands/
│   └── resource.ts             # octopus resource 命令组（仅 Commander 胶水）
└── output.ts                   # OutputFormatter（CLI 专属的 rich/json/quiet 输出）

server/src/routes/resource/
└── index.ts                    # /api/resources/* 路由（薄路由，直接调 shared 的 ResourceManager）
```

**影响**: shared 包增加 ~15 个文件（纯业务逻辑，无 Commander 依赖），cli 瘦身为命令层，server 零额外依赖。

### 5.2 🟡 HIGH: SQLite 索引层应延后

**用户设计**: SQLite 作为查询加速层，文件写入时双写 DB。

**质疑**:
- 资源数量预计 < 1000，JSON 文件扫描 O(n) 足够快
- 双写引入一致性问题（写文件成功但写 DB 失败 → 不一致）
- 需要 `doctor --rebuild-db` 命令来修复不一致 → 增加维护成本
- FTS5 全文搜索对 < 1000 条记录来说，`string.includes()` 一样快

**推荐**: SQLite 层标记为 Phase 4（可选），先用纯文件实现。当资源数 > 1000 或搜索性能成为瓶颈时再加。**在用户要求 100% 完整功能的前提下，可以先实现一个简化版——只做 DB 同步，不做 FTS5**。

### 5.3 🟡 HIGH: `register` + `install` 应合并

**用户设计**: `register`（注册到全局 registry）和 `install`（安装到 workspace）是两个独立命令。

**质疑**:
- npm/pip/cargo 都没有 `register` 步骤 — `npm install` 自动 fetch + 安装
- 两步操作增加用户认知负担：「我只想装个 skill，为什么要先 register？」
- 如果用户 install 一个未 register 的资源，应该自动 register

**推荐**: `octopus resource install <ref>` 一步完成：
1. 如果 ref 是名字 → 从 registry 查找 → 安装
2. 如果 ref 是来源引用（`npm:xxx`、`builtin:xxx`）→ 自动 register → 安装
3. `register` 保留为高级命令（`octopus resource register --only`），用于预注册但不安装

### 5.4 🟡 HIGH: 信任系统不实现（与用户要求一致，需明确边界）

**用户设计**: TOFU 信任模型 + TrustStore + blocked sources。

**质疑**:
- 用户已说「安全问题可以全部不要」
- TrustStore/SecurityContext 模块不实现，方法签名保留 opts 参数但方法体为空操作
- 信任管理页从 IN-SCOPE 移除（无数据可展示）

**推荐**: 后续生产化时只需：填充 SecurityContext 方法体 + 加 auth middleware + 新增信任管理页。不影响当前代码结构。

### 5.5 🟡 HIGH: Web UI 资源页面导航集成

**用户设计**: 📦 资源作为顶级导航。

**代码现实**: header.tsx 使用顶部 tab 导航，4 个条目：`[Dashboard, 工作空间, 系统调度, Agent]`。无全局 sidebar。

**决策**: 资源页面作为独立路由 `/resources`，入口在 header.tsx 的 navigation 数组中新增第 5 个 tab：
```typescript
{ name: "资源", href: "/resources", icon: Package }
```

理由：资源管理是平台级功能（不绑定特定 workspace/agent），作为顶级 tab 与 Dashboard/工作空间/Agent 同级合理。

### 5.6 🟡 MEDIUM: 12 个 CLI 命令过多

**用户设计**: 12 个子命令（init/register/install/uninstall/list/search/info/deps/gc/sync/audit/doctor）

**优化建议**:

| 命令 | 处理 | 理由 |
|------|------|------|
| `init` | 🔄 改为惰性初始化 | 首次使用任何 resource 命令时自动 init，无需显式 |
| `register` | 🔄 合并入 install | install 时自动 register（见 5.3） |
| `install` | ✅ 保留 | 核心命令 |
| `uninstall` | ✅ 保留 | 核心命令 |
| `list` | ✅ 保留 | 核心命令 |
| `search` | 🔄 合并入 list | `list --query xxx` 等价于 search |
| `info` | ✅ 保留 | 查看详情 |
| `deps` | 🔄 合并入 info | `info --deps` 显示依赖树 |
| `gc` | ✅ 保留 | 缓存清理 |
| `sync` | ✅ 保留 | 漂移检测 |
| `audit` | ✅ 保留 | 审计日志 |
| `doctor` | ✅ 保留 | 自检修复 |

优化后: **8 个命令**（install/uninstall/list/info/gc/sync/audit/doctor），减少 33% 认知负担。

### 5.7 🟡 MEDIUM: Source 类型资源的 VarPool 注入设计风险

**用户设计**: source 资源安装到 `workspace/dependencies/`，通过 VarPool 注入 `$deps.name` 路径。

**质疑**:
- `$deps.*` 是动态变量，VarPool 当前不支持通配符前缀
- 如果 source 名字和现有 `$vars.*` 冲突怎么办？
- Workflow YAML 中 `$deps.octopus-utils` 的解析时机——编译期 vs 运行期？

**推荐**: source 类型作为 Phase 4 延后。当前只支持 skill/agent/workflow 三种资源类型。source 的依赖管理本质上是 git submodule 的变体，需要更多设计思考。

### 5.8 🟢 LOW: SSE 安装进度的替代方案

**用户设计**: POST /api/resources/install 返回 SSE stream 推送安装进度。

**质疑**:
- SSE 用于 POST 请求不太标准（通常 SSE 是 GET）
- 安装操作通常在秒级完成，不需要实时进度
- 如果安装确实很慢（大 source 资源的 git clone），可以用 polling

**推荐**: 改为 POST 返回 `job_id`，前端通过 `GET /api/resources/jobs/:id` polling 状态。更简单，更标准。或者如果安装操作足够快（builtin 资源），直接同步返回结果。

---

## 6. 不做这件事的代价

| 维度 | 不做 | 做（优化后方案） |
|------|------|----------------|
| **开发效率** | 每次安装 skill 5-10 分钟手动操作 | 一条命令 / 一次点击 |
| **工作流可靠性** | skill 缺失只能人工介入 | 自动依赖解析 + 安装 |
| **平台完整性** | Web UI 永远缺资源管理模块 | 三层完整，API + UI + CLI |
| **技术债务** | 资源管理无统一方案 | 统一到 shared，消除 ad-hoc |
| **社区扩展** | 无法分发社区 skill | 基础设施就绪（publish 可以后做） |
| **竞品差距** | 与 Cursor/Cline 的体验差距拉大 | 缩小差距，有独特的闭环集成 |

---

## 7. 推荐方案总结

### 核心调整（相比用户原始设计）

| # | 调整项 | 原设计 | 推荐 | 理由 |
|---|--------|--------|------|------|
| 1 | **核心逻辑位置** | cli/src/resource/ | shared/src/resource/ | 消除 server→cli 反向依赖 |
| 2 | **SQLite 索引层** | Phase 4 必做 | Server 运行时查询引擎（非可选） | JSON 是 source of truth，SQLite 负责查询 |
| 3 | **register + install** | 两个独立命令 | 合并为一个 install | 降低认知负担，对标 npm/pip |
| 4 | **信任系统** | 完整 TOFU | **不实现**，方法签名保留空操作 | 与用户"不要安全"要求一致 |
| 5 | **Web UI 导航** | 顶级「📦 资源」sidebar | Header tab（第 5 个 tab） | 基于实际代码结构，无 sidebar |
| 6 | **CLI 命令数** | 12 个 | 8 个（合并 4 个） | 减少认知负担 |
| 7 | **source 类型** | Phase 1 全支持 | 扩展项延后 | VarPool 注入设计风险 |
| 8 | **SSE 进度推送** | POST 返回 SSE | POST 同步返回 | 更标准，安装通常秒级完成 |

### 实施优先级（保证 100% 完整无 TODO）

```
Phase 1a: shared 层核心逻辑（从零构建）
  → ResourceManager, RegistryStore, SourceProviders (builtin + local)
  → DependencyResolver, LockManager, AuditLogger, Installer/Uninstaller
  → AtomicJsonStore, SecurityContext(空操作)
  
Phase 1b: CLI 命令 + 闭环集成
  → 8 个子命令（install/uninstall/list/info/gc/sync/audit/doctor）
  → SkillLoader Tier 0 扫描（~300 行改动）
  → Pi provider prompt-enhancer 集成
  
Phase 2: Server API + SQLite
  → ResourceService（薄包装 shared ResourceManager）
  → /api/resources/* 路由（9 个端点）
  → SQLite 索引层（Server 启动时从 JSON 重建）
  
Phase 3: Web UI
  → Header 导航集成（第 5 个 tab）
  → 资源列表页 + 搜索过滤
  → 安装对话框 + 卸载确认
  → 资源详情页 + 依赖树
  → 审计日志页
  
测试: 嵌入各 Phase（单元测试 ≥80% + UI 截图验证）
```

### 开发阶段安全策略

TrustStore/SecurityContext 模块**不实现**。方法签名保留 opts 参数（含 caller 字段）但方法体为空操作。后续生产化只需：
1. 填充 SecurityContext 方法体
2. 加 auth middleware
3. 新增信任管理页

```typescript
// 资源管理方法签名示例（安全参数保留但不检查）
class ResourceManager {
  async install(ref: string, opts?: { caller?: string }): Promise<InstallResult> {
    // opts.caller 保留但当前不做权限检查
    // ...安装逻辑
  }
}
```

---

## 8. 范围契约草稿

→ 详见 [02-scope.md](./02-scope.md)
