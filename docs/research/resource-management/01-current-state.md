# 1. 现状与问题

## 1.1 当前资源散落在哪里

Octopus 平台有 4 类资源，各自独立管理，无统一抽象：

| 资源类型 | 当前存储位置 | 加载方式 | 版本管理 |
|----------|-------------|---------|---------|
| **Skills** | `core-pack/skills/` + `~/.octopus/agent/skills/` + `workspace/.claude/skills/` | SkillLoader 三层扫描 | 无 |
| **Agents** | `core-pack/agents/` + `~/.octopus/agents/` + `workspace/.claude/agents/` | RoleRegistry 目录扫描 | 无 |
| **Workflows** | `core-pack/presets/workflows/` → `~/.octopus/workflows/` | setup 时复制 | 无 |
| **Sources** | 不存在 | 手动 git clone / npm install | 无 |

### 问题清单

1. **无统一注册/发现** — 要知道有哪些 skill，需要扫 3 个目录；agent 同理
2. **无版本管理** — skill 被 evolution 修改后只有 `.bak` 备份，无版本号
3. **无依赖解析** — skill A 可能依赖 skill B，但没有声明和自动安装机制
4. **无远程获取** — 想安装社区 skill 只能手动 clone + 复制
5. **无信任链** — 从外部获取的资源没有来源验证和安全审计
6. **无锁文件** — workspace 声明需要哪些资源没有标准化（config.json 是 ad-hoc）
7. **CLI 和 Server 断层** — 资源操作只有 CLI（setup/sync），server 不能管理资源

## 1.2 前序 PR 分析

### PR #12 (Unified Resource Management)

PR #12 尝试解决上述问题，提供了：

- 12 个 CLI 子命令（`octopus repo init/register/install/uninstall/search/list/info/deps/gc/sync/doctor/audit`）
- 4 种 Source Provider（npm/git/local/builtin）
- 依赖解析引擎（DFS + 环检测 + 拓扑排序）
- 安全体系（TrustStore TOFU + SecurityContext + 路径遍历防护）
- 6 个 Zod Schema（ResourceManifest / Registry / LockFile / Audit / TrustedSources / WorkspaceConfig）

**核心问题**：双轨结构（`cli/src/repository/` + `shared/src/repository/`），只有 CLI 无 Server API，无 Web UI。

### PR #13 (PRD-001 Resource Management)

PR #13 在 PR #12 基础上扩展，增加了 Server API + Web UI + CLI 14 个子命令：

- 完整度 52%，110 文件，+9,456 行
- 3 个 CRITICAL 安全漏洞（Server 无 trust 校验、LocalProvider 读任意目录、密码预言机）
- 测试覆盖率 ~11%（576 测试声称，实际 ~11%）
- CLI 过重（14 个命令文件各 100-250 行，每个独立创建 kernel）

**吸纳**：Zod schema 验证、execFileSync 安全修复、审计日志设计。
**丢弃**：重 CLI 双轨架构、819 行路由文件、trust checkbox bug。

### PR #14 (统一资源管理系统 PRD implementation)

PR #14 是 PR #13 的重写，采用了**瘦 CLI + Server 单一入口**架构：

- 声称完整度 100%，56 文件，+6,455 行
- 架构大幅改善：CLI 299 行瘦客户端、Server ResourceManager 单例、18 个模块化 shared 文件
- undo stack 事务回滚、链式哈希审计日志、per-org 单例工厂
- 测试覆盖率 ~35-42%（声称 576 实际 105，存在虚报）
- 仍有 2 个 CRITICAL（agentAuthMiddleware 不验证 token、LocalProvider blocklist 不完整）

**吸纳**：瘦 CLI + Server 单一入口架构（这是本设计文档的核心变更）。
**待修复**：LocalProvider 改 allowlist、install 回滚一致性、测试补充。

### 前序 PR 共有的优点（吸纳）

| 模块 | 评价 | 吸纳策略 |
|------|------|---------|
| `AtomicJsonStore` | 原子写入 + .bak 回退 | ✅ 泛型化为 `AtomicJsonStore<T>` |
| `DependencyResolver` | DFS + 环检测 + depth guard | ✅ 直接复用 |
| `SourceProvider` 接口 | 抽象干净 | ✅ 直接复用（Phase 1 仅 builtin + local） |
| `ResourceError` 错误体系 | 20 种错误码 + HTTP status + exit code + suggestion | ✅ 直接复用 |
| `AuditLogger` | JSONL 追加 + caller 区分 | ✅ 增加链式哈希防篡改 |
| `isPathWithinBase` | 路径遍历检测 | ✅ 直接复用 |
| `computeContentHash` | SHA-256 内容寻址 | ✅ 合并到 utils.ts |

### 前序 PR 共有的问题（本设计已解决）

| 问题 | 严重性 | 本设计的处理方式 |
|------|--------|---------|
| 核心逻辑放 CLI 包 | CRITICAL | 🔧 核心移到 shared，CLI 变瘦客户端 |
| CLI 和 Server 双轨 | CRITICAL | 🔧 Server 是唯一入口，CLI 走 HTTP |
| CLI 太重 (14 文件 ~1800 行) | HIGH | 🔧 1 文件 ~300 行 |
| Server 反向依赖 CLI | HIGH | 🔧 Server import shared，不依赖 CLI |

## 1.3 设计目标

```
用户场景 1：开发者安装社区 skill
  $ octopus resource install brainstorming
  → 从 registry 查找 → 信任确认 → 下载 → 缓存 → 安装到 workspace

用户场景 2：Agent 自动安装依赖
  $ octopus resource install my-workflow
  → 解析依赖图 → 按拓扑序安装 skill-a, skill-b → 生成 lock 文件

用户场景 3：Web UI 浏览资源
  打开 http://localhost:3000/resources
  → 看到已安装资源列表 → 搜索 → 安装/卸载 → 查看审计日志

用户场景 4：Workspace 资源同步
  $ octopus resource sync
  → 对比 config.json vs resources.lock → 报告漂移 → 自动修复
```

### 非目标（不在本设计范围内）

- 不替代 `repos` 命令（git 仓库管理是独立概念）
- 不做 npm publish 式的资源发布（只做消费端）
- 不做资源评级/评论（保持简单）
