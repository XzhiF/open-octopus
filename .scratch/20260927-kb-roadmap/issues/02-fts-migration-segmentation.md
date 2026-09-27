# 02 — experiences_fts v2 blue-green 迁移不分词（老库中文经验面）

## What to build
`schema.ts` 的 experiences_fts v2 迁移仍复制**原文**入索引，未过 `segIndex()`。
老库升到 v35 后，若不手动调 `POST /api/agent/memory/rebuild-fts`，中文经验面 0 命中
（新写入路径已即时分词，不受影响）。

修法（择一）：
- 迁移事务内对复制的 content/skill_name 过 `segIndex()` 再插入（迁移是一次性路径，不在启动热路径，成本可接受）；
- 或迁移完成后自动置一个 `search_index_dirty` 标记，首次 recall 命中经验面为空时提示调用 rebuild。

## 上线 Runbook 备忘（P0 → 使用方）
现有 dev 库经验面中文检索启用前打一次：
`curl -X POST http://localhost:3001/api/agent/memory/rebuild-fts`

## Blocked by
无。注意迁移属 durable 格式——改完必须重跑消费方（recall/regression/schema-migration）全量测试再宣称绿

## Status
pending

## Triage labels
needs-triage

## Acceptance Criteria
- [ ] 老库（未分词索引）跑迁移/或按方案二，中文查询经验面命中 > 0，有回归用例
- [ ] `pnpm --filter @octopus/server test` schema-migration + chinese-recall-regression 全绿
