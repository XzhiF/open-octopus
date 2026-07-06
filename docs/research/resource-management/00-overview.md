# 统一资源管理系统设计

> 状态: 设计探讨阶段
> 日期: 2026-07-05
> 作者: Octopus Architecture

## 章节索引

| 章节 | 文件 | 内容 |
|------|------|------|
| [1. 现状与问题](./01-current-state.md) | `01-current-state.md` | 当前资源散落现状、PR #12 分析、设计目标 |
| [2. 架构设计](./02-architecture.md) | `02-architecture.md` | 瘦 CLI + Server 单一入口、shared 核心、模块划分 |
| [3. 存储层设计](./03-storage.md) | `03-storage.md` | 文件为主 DB 为辅、目录结构、Schema |
| [4. CLI 设计](./04-cli.md) | `04-cli.md` | 瘦 HTTP 客户端、8 个子命令 |
| [5. Server API 设计](./05-server-api.md) | `05-server-api.md` | Server 唯一入口、ResourceManager 单例、10 REST 端点 |
| [6. Web UI 设计](./06-web-ui.md) | `06-web-ui.md` | 页面结构、组件设计、交互流程 |
| [7. 迁移计划](./07-migration.md) | `07-migration.md` | 从 PR #12 吸纳什么、重构什么、丢弃什么 |

## 核心设计原则

1. **Server 是唯一入口** — ResourceManager 单例持有在 Server，CLI 是瘦 HTTP 客户端，避免双轨和并发冲突
2. **核心在 shared** — ResourceManager、RegistryStore、SourceProviders 等业务逻辑在 shared 包，CLI 不持有核心逻辑
3. **文件为主，DB 为辅** — `~/.octopus/orgs/{org}/resources/` 是 source of truth，SQLite 是查询索引
4. **resource 而非 repo** — 避免与现有 `repos` 命令（git 仓库管理）混淆
5. **瘦 CLI** — CLI 只做参数解析 + HTTP 调用 + 输出格式化，与 workspace/agents 等命令模式一致
6. **渐进迁移** — 从 PR #12/PR #13/PR #14 吸纳核心逻辑，不整体合并

## 迭代历史

| PR | 完整度 | 状态 | 吸纳 | 丢弃 |
|----|--------|------|------|------|
| PR #12 | 60% | 已关闭 | SecurityContext, AtomicJsonStore, DependencyResolver, SourceProvider 接口, ResourceError 体系 | 双轨结构 (cli/repository + shared/repository) |
| PR #13 | 52% | 已关闭 | Zod schema 验证, execFileSync 安全修复, 审计日志 | 重 CLI (14 文件), 双 kernel, 819 行路由文件, trust checkbox bug |
| PR #14 | 100% (声称) | 评审中 | **瘦 CLI + Server 单一入口**架构, undo stack 事务, 链式哈希审计, per-org 单例, 模块化 shared 层 | LocalProvider blocklist (改 allowlist), install 回滚一致性, 测试覆盖率 |
