# 统一资源管理系统设计

> 状态: 设计探讨阶段
> 日期: 2026-07-05
> 作者: Octopus Architecture

## 章节索引

| 章节 | 文件 | 内容 |
|------|------|------|
| [1. 现状与问题](./01-current-state.md) | `01-current-state.md` | 当前资源散落现状、PR #12 分析、设计目标 |
| [2. 架构设计](./02-architecture.md) | `02-architecture.md` | 三层架构（shared/core + cli + server）、模块划分 |
| [3. 存储层设计](./03-storage.md) | `03-storage.md` | 文件为主 DB 为辅、目录结构、Schema |
| [4. CLI 设计](./04-cli.md) | `04-cli.md` | `octopus resource` 命令族、与 `repos` 的区分 |
| [5. Server API 设计](./05-server-api.md) | `05-server-api.md` | REST 端点、SSE 推送、权限模型 |
| [6. Web UI 设计](./06-web-ui.md) | `06-web-ui.md` | 页面结构、组件设计、交互流程 |
| [7. 迁移计划](./07-migration.md) | `07-migration.md` | 从 PR #12 吸纳什么、重构什么、丢弃什么 |

## 核心设计原则

1. **文件为主，DB 为辅** — `~/.octopus/resources/` 是 source of truth，SQLite 是查询索引
2. **resource 而非 repo** — 避免与现有 `repos` 命令（git 仓库管理）混淆
3. **三层完整** — CLI + Server API + Web UI 全覆盖
4. **渐进迁移** — 从 PR #12 吸纳核心逻辑，不整体合并
