# T2: DB Schema Migration — ALTER TABLE for Clone Support

**Status:** done ✓
**Depends on:** T1
**Blocks:** T3, T8

## Scope

Add new columns to `messages` and `sessions` tables, and add `type` column to `clones` table.

## Changes

### `packages/server/src/db/schema.sql`

Add new columns to existing tables (idempotent via conditional logic in schema.ts):

```sql
-- Messages: add type + metadata
ALTER TABLE messages ADD COLUMN type TEXT DEFAULT 'text';
ALTER TABLE messages ADD COLUMN metadata TEXT;

-- Sessions: add scope_id + provider_session_id
ALTER TABLE sessions ADD COLUMN scope_id TEXT;
ALTER TABLE sessions ADD COLUMN provider_session_id TEXT;

-- Clones: add type column
ALTER TABLE clones ADD COLUMN type TEXT DEFAULT 'user';
```

### `packages/server/src/db/schema.ts`

Update the schema initialization to run ALTER TABLE statements safely (catch "duplicate column" errors for idempotency).

## Verification

1. `pnpm test -- packages/server/src/__tests__/db-schema.test.ts` passes
2. `pnpm test -- packages/server/src/__tests__/db-connection.test.ts` passes
3. Fresh database initialization creates columns correctly
4. Existing database migration adds columns without data loss
