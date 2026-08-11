# 01 — Experience Schema Migration + DAO Extension

## What to build
演进 `experiences` 表 schema，支持多消费者 scope 隔离、效果追踪和节点级关联。FTS5 使用蓝绿迁移策略防止数据丢失。新增 DAO 方法支持 scope-aware 查询和搜索。

## Blocked by
None — can start immediately

## Status
ready-for-agent

## Acceptance Criteria
- [ ] AC-1: experiences 表新增 7 列（scope, scope_ref, pattern_tags, outcome, source_type, execution_id, node_id），所有列有 DEFAULT 值
- [ ] AC-2: 现有 experiences 数据不受影响（DEFAULT scope='agent', source_type='session'）
- [ ] AC-3: FTS5 蓝绿迁移完成（新建 v2 → 填充 → 原子交换），搜索正常工作
- [ ] AC-4: 5 个新索引创建成功（scope, scope+ref, source_type, execution_id, org+scope+time）
- [ ] AC-5: EvolutionDAO 新增 4 个方法：listByScope, searchByScope, updateOutcome, getSuccessStats
- [ ] AC-6: searchByScope 支持 FTS5 MATCH + scope 过滤，fallback LIKE
- [ ] AC-7: getSuccessStats 返回 decision × pattern 成功率统计（JSON）
- [ ] AC-8: 所有现有 EvolutionDAO 测试通过（向后兼容）

## Verification Method
**Verification type**: unit test + integration test

**Verification steps**:
```bash
# 1. Run migration
pnpm --filter @octopus/server exec vitest run --reporter=verbose src/__tests__/schema-migration.test.ts

# 2. Run DAO tests
pnpm --filter @octopus/server exec vitest run --reporter=verbose src/__tests__/evolution-dao-v2.test.ts

# 3. Verify FTS5 search
sqlite3 ~/.octopus/db/octopus.db "SELECT * FROM experiences_fts WHERE experiences_fts MATCH 'harness' LIMIT 5"

# 4. Verify indexes
sqlite3 ~/.octopus/db/octopus.db ".indexes experiences"
```

**Pass criteria**: All 8 ACs pass
**Failure handling**: Max 3 fix attempts, then mark SKIP with reason
