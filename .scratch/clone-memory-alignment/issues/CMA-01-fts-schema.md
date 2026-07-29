# Ticket: FTS Schema Migration - Add source Column

## ID
CMA-01

## Status
done

## Summary
Add `source` column to `session_memory_fts` FTS5 virtual table to distinguish main agent memory from clone memory.

## Scope
- Drop and recreate `session_memory_fts` with `source` column (TEXT, default 'main')
- Update `AgentSessionDAO.rebuildFtsIndex()` to populate source column
- Update `AgentSessionDAO.searchSessionMemory()` to return source column
- Update `AgentSessionDAO.insertSummaryMessage()` to accept optional source param

## Files
- `packages/server/src/db/schema.sql` — update FTS table definition
- `packages/server/src/db/dao/agent-session-dao.ts` — update FTS methods

## Acceptance Criteria
- AC1: `session_memory_fts` table has `source` column
- AC2: Existing data migrated with `source='main'`
- AC3: `rebuildFtsIndex()` populates source from message metadata
- AC4: `searchSessionMemory()` returns source in results

## Verification Method
```bash
# Run existing tests to ensure no regression
pnpm test -- --run packages/server/src/__tests__/agent-migrations.test.ts

# Manual verification: check FTS table has source column
sqlite3 ~/.octopus/db/octopus.db ".schema session_memory_fts"
```

## Dependencies
None (foundation for all other tickets)

## Implementation Notes
FTS5 virtual tables don't support ALTER TABLE ADD COLUMN. Must DROP and recreate. The migration happens automatically on next `rebuildFtsIndex()` call. Add defensive check to handle both old and new schema during transition.
