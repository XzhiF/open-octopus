# 02 — Dual Store Unification

Type: grilling
Status: resolved
Blocked by: 01

## Answer

**统一到 DB（experiences 表 + FTS5）**：
- 废弃 `SubsystemAdapter.writeExperience()` 的文件存储路径
- 删除空目录 `~/.octopus/agent/evolution/experiences/`
- 所有经验读写统一走 `EvolutionDAO` + `EvolutionService`
- 当前无数据需要迁移（文件存储从未有实际数据）

## Question

当前存在两个并行的 experience 存储：
- DB: `experiences` 表 + `experiences_fts`（EvolutionService 使用）
- File: `~/.octopus/agent/evolution/experiences/*.md`（SubsystemAdapter 使用）

如何统一？统一到哪个？还是保持双写？
