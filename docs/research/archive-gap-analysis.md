# 归档子系统 — 设计 vs 实现差距分析

> 基于 `execution-memory-loop.md` 设计文档与当前 codebase 实现对比

---

## 已实现

| 模块 | 位置 |
|------|------|
| 知识规则提取 pipeline（LLM + 启发式 fallback） | `services/knowledge/extract.ts` |
| 知识文件 CRUD（markdown on disk） | `services/knowledge/file-ops.ts` |
| 知识注入 Agent prompt（scope 过滤 + 预算控制） | `engine/knowledge-injector.ts` |
| 审核队列（propose → approve/reject/defer） | `services/knowledge/review.ts` + `routes/review.ts` |
| 规则有效性追踪 | `services/knowledge/effectiveness.ts` + DAO |
| 知识文件压缩（手动触发） | `services/knowledge/maintenance.ts` |
| 三层记忆（session/daily/long-term）读写搜索 | `services/agent/memory-service.ts` |
| 记忆 FTS5 全文搜索 | schema + `rebuildFtsIndex` |
| Archive API 端点（执行摘要 + 规则提取） | `routes/archive.ts` |
| 前端全套 UI（知识库/记忆/审核/归档对话框） | `web-app/components/agent/knowledge/` + `memory/` |

---

## 未实现 — 归档核心缺口

### 缺口 1: `execution_archive` / `workspace_archive` SQL 表不存在

设计文档定义两张永久表（脱离 workspace 生命周期）。当前 `schema.sql` 没有这两张表。归档执行指标（cost、duration、token breakdown、node summary、model breakdown、chain 关系）无处持久化。

**影响**: 整个 Dashboard API（`/archive/stats`、`/archive/cost-trends`、`/archive/workflow-stats`、`/archive/leaderboard`）全部无法实现。

### 缺口 2: Workspace 删除时自动归档未实现

设计文档要求 workspace 删除走两阶段提交：标记 archiving → 归档所有执行 → 标记 archived → 级联删除。当前 `workspaces` 表没有 `archive_status` 列，删除逻辑里没有归档步骤。

### 缺口 3: 执行完成时自动归档未实现

设计文档要求 `onComplete()` 自动调用 `ArchiveService.archiveExecution()`。当前执行引擎没有这个 hook。

### 缺口 4: 记忆自动归档 cron 未接线

`archive_cron_hour` 配置已定义（default: 2），但没有任何 scheduler 消费它。`archiveMemory()` 方法存在但只能手动触发。

### 缺口 5: `memory.archived` 事件定义但从未 emit

`domain-event-bus.ts` 定义了事件类型，但 route handler 和 service 都没有 dispatch。

### 缺口 6: 其他自动触发配置未消费

| 配置项 | 默认值 | 消费者 |
|--------|--------|--------|
| `session_retention_days` | 90 | ❌ 无 |
| `long_term_refine_trigger_days` | 7 | ❌ 无 |
| `session_compress_threshold_messages` | 50 | ❌ 无 |

---

## 建议实现优先级

### 🔴 P0 — 归档骨架（阻塞所有下游）

1. **建表 + ArchiveService 核心** — `execution_archive` + `workspace_archive` SQL 表，`ArchiveDAO`，`ArchiveService.archiveExecution()`
2. **Workspace 删除两阶段归档** — `workspaces` 表加 `archive_status` 列，改造 `delete()` 方法
3. **执行完成自动归档 hook** — 执行引擎 `onComplete()` 接线

### 🟡 P1 — 自动化层（手动触发已可用，不阻塞）

4. **记忆自动 cron** — scheduler 消费 `archive_cron_hour`，定时调 `archiveMemory()`
5. **Domain event emit** — 归档完成时 dispatch `memory.archived`
6. **其他自动触发** — `session_retention_days`、`long_term_refine_trigger_days`、`session_compress_threshold_messages` 接线

### 🟢 P2 — Dashboard 消费层（依赖 P0 表）

7. **Dashboard API** — `/archive/stats`、`/archive/cost-trends`、`/archive/workflow-stats`、`/archive/leaderboard` 端点
8. **前端 Loop Dashboard** — 健康度/成本分布/工作流统计可视化
