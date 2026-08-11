# 05 — Evolution Reflect + Scope Integration

## What to build
扩展 EvolutionService.reflect() 支持 scope 参数，新增 experience 输出路径（reflect 产出写入 experiences 表 source_type='reflection'），使反思结论可被 FTS5 检索。

## Blocked by
01 — Schema Migration (needs source_type column)
04 — Effectiveness Tracker (needs outcome data for analysis)

## Status
ready-for-agent

## Acceptance Criteria
- [ ] AC-1: reflect() 接受可选 scope 参数，按 scope 过滤分析范围
- [ ] AC-2: reflect 产出的 insights 写入 experiences 表（source_type='reflection', scope=对应scope）
- [ ] AC-3: harness scope 的 reflect 分析 decision 成功率 + detector 准确度 + pattern 频率
- [ ] AC-4: 写入的 reflection experiences 可被 FTS5 searchByScope 检索到
- [ ] AC-5: 现有 reflect() 行为（agent scope）不受影响
- [ ] AC-6: 反思触发机制定义明确（onExecutionEnd 或定时任务）

## Verification Method
**Verification type**: unit test + integration test

**Verification steps**:
```bash
# 1. Reflect with scope test
pnpm --filter @octopus/server exec vitest run --reporter=verbose src/__tests__/evolution-reflect-scope.test.ts

# 2. Verify reflection experiences in DB
sqlite3 ~/.octopus/db/octopus.db "SELECT * FROM experiences WHERE source_type='reflection' ORDER BY id DESC LIMIT 5"

# 3. Verify FTS5 search includes reflections
sqlite3 ~/.octopus/db/octopus.db "SELECT * FROM experiences_fts WHERE experiences_fts MATCH 'harness timeout' LIMIT 5"
```

**Pass criteria**: All 6 ACs pass
**Failure handling**: Max 3 fix attempts, then mark SKIP with reason
