# 07 — Grilling: Version Data Model & Storage

Type: grilling
Status: resolved
Blocked by: 04

## Question

Agent 版本数据在 SQLite 中怎么存储？需要文件系统支持吗？

## Answer

**Decision: DB + Filesystem 双存储**

### DB 层 (Source of Truth)
- 新表 `agent_versions`：id, agent_name, version, stage, status, snapshot(JSON), changelog, published_at/by
- `clones` 表增加 `current_version_id` 指针
- 版本解析："latest" → 最新 stable；具体版本号 → 精确匹配；"min_stage:beta" → 阶段过滤

### Filesystem 层 (Working Directory)
- 版本目录：`~/.octopus/agent/versions/{name}/{version}/` — 不可变快照
- 活跃目录：`~/.octopus/agent/clones/{name}/` — 当前运行时使用（不变）

### 流程
- **发布**: 双写（DB snapshot + 复制到 versions/）
- **回滚**: 从 versions/ 复制回 clones/ + 更新 DB 指针
- **运行时**: 读 clones/（与现有 runtime 完全兼容）
- **查看历史**: DB 查列表 + versions/ 或 DB snapshot 读内容
