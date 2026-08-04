# 04 — Grilling: Agent Version Semantics Model

Type: grilling
Status: resolved
Blocked by: None

## Question

Agent 版本管理采用哪种语义模型？

## Answer

**Decision: Release Tag 模型 + Maven-style 版本限定符**

- 每次 publish 创建不可变版本号
- 版本格式参考 Maven：`{major}.{minor}.{patch}-{qualifier}`
  - Qualifier: `alpha` → `beta` → `rc` → stable (no suffix)
  - Examples: `1.0.0-alpha.1`, `1.0.0-beta.2`, `1.0.0`
- Workflow 可 pin 到特定版本或使用 `latest`（跟随最新 stable）
- 版本单元：persona.md + config.json + skills 列表（整体）
- Memory 不纳入版本管理（运行时数据）
- 支持版本阶段过滤：workflow 可指定 `min_stage: beta` 拒绝 alpha 版本
