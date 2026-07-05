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

## 1.2 PR #12 做了什么

PR #12 (Unified Resource Management) 尝试解决上述问题，提供了：

- 12 个 CLI 子命令（`octopus repo init/register/install/uninstall/search/list/info/deps/gc/sync/doctor/audit`）
- 4 种 Source Provider（npm/git/local/builtin）
- 依赖解析引擎（DFS + 环检测 + 拓扑排序）
- 安全体系（TrustStore TOFU + SecurityContext + 路径遍历防护）
- 6 个 Zod Schema（ResourceManifest / Registry / LockFile / Audit / TrustedSources / WorkspaceConfig）

### PR #12 的优点（要吸纳）

| 模块 | 评价 | 吸纳策略 |
|------|------|---------|
| `SecurityContext` + `TrustStore` | TOFU 模式正确，caller gating 好 | ✅ 直接复用 |
| `AtomicJsonStore` | 原子写入 + .bak 回退 | ✅ 直接复用 |
| `DependencyResolver` | DFS + 环检测 + depth guard | ✅ 直接复用 |
| `SourceProvider` 接口 + 4 实现 | 抽象干净 | ✅ 直接复用 |
| `RepoError` 错误体系 | 20 种错误码 + 退出码 + 修复建议 | ✅ 直接复用 |
| `AuditLogger` | JSONL 追加，caller 区分 | ✅ 直接复用 |
| `OutputFormatter` | rich/json/quiet 三模式 | ✅ 直接复用 |
| `content-hash.ts` | SHA-256 内容寻址 | ✅ 直接复用 |

### PR #12 的问题（要重构）

| 问题 | 严重性 | 处理方式 |
|------|--------|---------|
| `repository/` vs `resource/` 双轨 | CRITICAL | 🔧 合并为一个 `resource/` 模块 |
| 只有 CLI，无 Server API | CRITICAL | 🔧 新增 server 层 |
| 无 Web UI | HIGH | 🔧 新增 web-app 层 |
| 命令名 `repo` 与 `repos` 混淆 | HIGH | 🔧 改名为 `resource` |
| `@ts-expect-error` 绕过类型 | MEDIUM | 🔧 修正类型 |
| `models.yaml` 已存在但没接通 | MEDIUM | 🔧 接通 SkillLoader |

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
