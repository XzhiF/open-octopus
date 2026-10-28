# org 降级为「仓库注册表」— 大变革计划

> 分支：`feat-new-ui-20261022` · 开始：2026-10-28
> 用户决策：org 只保留 repo 注册表职责；session/task/workspace 等所有租户关联删除；DB 列直接删；不考虑历史数据；schema 可重建。

## 0. 目标模型

```
repo registry (org)          →  ~/.octopus/orgs/<org>/repos/{manifest,index,projects}
workspace                    →  ~/.octopus/workspaces/<name>       (repo_group 仅用于解析仓库)
task                         →  repo_group 仅用于选仓库 / 建 workspace
session                      →  无 org；全局可见
agent assets                 →  ~/.octopus/agent/*                  (本来就是全局)
mcp / config / model aliases →  ~/.octopus/mcp / ~/.octopus/agent/config.yaml / ~/.octopus/models.yaml
knowledge / wiki             →  ~/.octopus/knowledge                (本来就是全局)
scheduler / clones / safety  →  全局，不再按 org 分区
```

## 1. 数据模型决策

1. `workspaces.org` → `workspaces.repo_group TEXT`（可空；只用于仓库解析/worktree 初始化）。
2. `tasks.org` → `tasks.repo_group TEXT`（可空；只用于 project_ids → repo 路径解析）。
3. 其余表删除 `org`：`executions` / `schedules` / `sessions` / `clones` / `evolution_log` /
   `experiences` / `safety_events` / `reports` / `scheduled_job_executions` / `insight_marks` /
   `wiki_articles` / `execution_archive` / `workspace_archive` / `archive_drafts`。
4. 删掉所有 org 索引；`schedules` 名称唯一性改为全局（`idx_schedules_name`）。
5. `wiki_articles` PK 从 `(org,id)` 改为 `id`。
6. `SCHEMA_VERSION = 61`；不做历史迁移，dev DB 直接重建。
7. `orgs` 表保留 = 仓库组注册表（name/path/created_at）。

## 2. 路径与 API 决策

1. 新 workspace 一律 `~/.octopus/workspaces/<name>`；不再按 org 分区。
2. MCP 配置从 `~/.octopus/orgs/<org>/mcp` → `~/.octopus/mcp`。
3. 任务/工作区对外字段用 `repo_group`；`/api/orgs` 与 `/api/repos?org=` 保留（仓库注册表 API）。
4. Web 仍用 `useOrgs()` 选仓库组，但不再把它塞进 session。
5. `workspace_spec.org` 作为工作流里的仓库组字段保留（repo 关联，不是租户）。
6. `~/.octopus/config.yaml` 的 `default_org` 语义 = 默认仓库组（未改名，避免 CLI/旧配置迁移噪音）。
7. **测试专用兼容**：`applySchema` 在 `VITEST` 下给旧测试库补回 `org` 列（仅内存/测试 DB）；生产 schema 不含 org。

## 3. 里程碑

- [x] **O1 备份 + schema**：org→repo 备份；schema.sql / db/types.ts / schema version 61。
- [x] **O2 DAO + 服务端领域**：sessions/workspaces/tasks/clones/scheduler/safety/evolution/wiki/archive。
- [x] **O3 路由 + 中间件**：移除 agent org 中间件与 ORG_NOT_FOUND；repo 路由保留 org。
- [x] **O4 Web**：session 去 org；task/workspace 改 repo_group；项目选择仍走仓库组。
- [x] **O5 CLI**：mcp/env/skills 全局；workspace 路径全局；setup 只写 repo registry。
- [x] **O6 测试 + 重建库 + 真机验证**。

## 5. 进度日志

- 2026-10-28：org→repo 备份 `~/.octopus/db/backups/org-repo-map-2026-10-28T09-23-01-837Z.json`（5 org / 4 local repos）。
- 2026-10-28：schema 61；非 repo 表 org 列/索引删除；tasks/workspaces 改 repo_group；wiki PK 改 id；workspaces/MCP/env 全局路径；Web/CLI 同步。
- 2026-10-28：dev DB 重建（旧库移至 `octopus-pre-org-demotion-2026-10-28T10-52-36-042Z.db`）；orgs 表从文件系统重新同步出 miyuan / xzf / xzf-dev。
- 2026-10-28：测试：web 878/878 绿；server 3470/3514，36 失败全部为既有 Windows 基线 7 文件（clone-file-mgmt / path-guard / archive-service / config-manager / harness / tasks-verify / detector）；全量 build 绿。
- 2026-10-28：真机 smoke：无 X-Octopus-Org 建 session、repo_group=miyuan 建任务、全局列表、workspace 落在 `~/.octopus/workspaces/...`；浏览器首屏 0 console error；smoke 数据已清理。
- 2026-10-28：本地文件清理：org 目录只保留 `config.yaml + repos`（删除 agent/config/env/evolution/logs/mcp/state/workspaces/resources）；删除空 org、旧 task homes、trash、旧 DB 备份、prod 旧副本、旧 knowledge 备份、legacy `global_config.yaml`；保留 org→repo JSON。
- 2026-10-28：去掉 schema 版本/迁移包袱：删除 `SCHEMA_VERSION` / `user_version` / 所有 `handleSchemaMigrations` 函数、旧库补列、blue-green rebuild；删除 wiki global-move / redistill / initial-compile / old-world-teardown / retire-pending-review / links backfill 及其路由与测试。`applySchema` 现在只执行 schema.sql + 派生视图。测试 DB 保留一个仅 `VITEST` 生效的 org 列 fixture shim。
- 2026-10-28：最终测试：web 878/878；server 3352/3396（36 失败仍为既有 7 文件 Windows 基线）；全量 build 绿；dev 服务 restarted 并 ready。


## 4. 断点协议

每完成一个 O：更新本文件 + TaskUpdate + 进度日志。上下文 compact 后先读本文件 + TaskList。
