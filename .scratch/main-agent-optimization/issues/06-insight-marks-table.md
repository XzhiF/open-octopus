# Issue 06: Insight Marks Table

**Status:** pending
**Scope:** server, schema
**Files:** `packages/server/src/db/schema.sql`, `packages/server/src/db/schema.ts`, `packages/server/src/db/dao/evolution-dao.ts`, `packages/server/src/db/types.ts`

## Description
Add `insight_marks` table to SQLite schema. Add DAO methods: `insertMark`, `listUnprocessedMarks`, `markProcessed`.

## Acceptance Criteria
- Table created in schema.sql
- Schema version bumped
- DAO has 3 new methods
- Type definition added

## Verification
- `pnpm build` succeeds
