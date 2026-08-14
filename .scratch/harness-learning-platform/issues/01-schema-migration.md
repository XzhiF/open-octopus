# 01 — Experience Schema Migration + DAO Extension

## What to build
演进 `experiences` 表 schema，支持多消费者 scope 隔离、效果追踪和节点级关联。FTS5 使用蓝绿迁移策略防止数据丢失。新增 DAO 方法支持 scope-aware 查询和搜索。

## Blocked by
None — can start immediately

## Status
done

## Acceptance Criteria
- [x] AC-1: experiences 表新增 7 列（scope, scope_ref, pattern_tags, outcome, source_type, execution_id, node_id），所有列有 DEFAULT 值
- [x] AC-2: 现有 experiences 数据不受影响（DEFAULT scope='agent', source_type='session'）
- [x] AC-3: FTS5 蓝绿迁移完成（新建 v2 → 填充 → 原子交换），搜索正常工作
- [x] AC-4: 5 个新索引创建成功（scope, scope+ref, source_type, execution_id, org+scope+time）
- [x] AC-5: EvolutionDAO 新增 4 个方法：listByScope, searchByScope, updateOutcome, getSuccessStats
- [x] AC-6: searchByScope 支持 FTS5 MATCH + scope 过滤，fallback LIKE
- [x] AC-7: getSuccessStats 返回 decision × pattern 成功率统计（JSON）
- [x] AC-8: 所有现有 EvolutionDAO 测试通过（向后兼容）

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

## Exploration

### Analog studied
- **Existing experiences table + FTS**: The `experiences` table (schema.sql §25) with its 2-column FTS5 index (`experiences_fts`) served as the primary analog. The existing `EvolutionDAO` methods (`insertExperience`, `searchExperiences`, `listExperiences`) demonstrated the established DAO patterns (BaseDAO, prepared statement caching, non-fatal FTS inserts).
- **Schema migration pattern**: `handleSchemaMigrations()` in `schema.ts` with `ensureColumn()` was the established pattern for adding columns to existing tables. `migrateFtsTableWithSource()` demonstrated the FTS5 drop-and-recreate migration approach.

### Files modified
1. `packages/server/src/db/schema.sql` — Added 7 columns to experiences table, rebuilt FTS5 with 5 columns, added 5 indexes
2. `packages/server/src/db/schema.ts` — Bumped SCHEMA_VERSION to 35, added `ensureColumn` calls for 7 new columns, added `migrateExperiencesFtsV2()` blue-green migration function
3. `packages/server/src/db/types.ts` — Added `ExperienceRowV2` interface extending `ExperienceRow`
4. `packages/server/src/db/dao/evolution-dao.ts` — Added 4 new methods (listByScope, searchByScope, updateOutcome, getSuccessStats) + `insertExperienceV2`, updated FTS inserts to include new columns
5. `packages/server/src/__tests__/db-schema.test.ts` — Updated index count (79→84)

### Files created
1. `packages/server/src/__tests__/schema-migration.test.ts` — 15 tests for schema v35 (columns, defaults, FTS v2, indexes, blue-green migration, backward compat)
2. `packages/server/src/__tests__/evolution-dao-v2.test.ts` — 33 tests for new DAO methods (listByScope, searchByScope, updateOutcome, getSuccessStats, backward compat)

### Key design decisions
- **External content FTS5** (not content-sync): Chose external content mode (no `content=` param) over content-sync because it matches the existing DAO pattern of manual FTS inserts, avoids needing sync triggers, and keeps the blue-green migration simpler.
- **`insertExperienceV2` as new method**: Rather than overloading existing `insertExperience`/`insertExperienceWithFts` with optional v2 fields, added a dedicated `insertExperienceV2` to maintain backward compatibility.
- **`getSuccessStats` uses pattern_tags[0] as decision**: First tag in the JSON array is treated as the decision type; all tags contribute to pattern stats.
- **FTS blue-green**: Creates `_v2` table → populates from `experiences` → drops old → renames `_v2` to final name. Non-fatal on failure (old FTS stays functional).
