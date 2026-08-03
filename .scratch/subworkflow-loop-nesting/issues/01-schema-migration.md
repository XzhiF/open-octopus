# Ticket 1: Schema Migration — Add parent_node_id and iteration_index columns

## Status: DONE

## Scope

Add two nullable columns to `node_executions` table:
- `parent_node_id TEXT` — set for sub-workflow child nodes
- `iteration_index INTEGER` — set for loop inner nodes

Update TypeScript types, DAO methods, and schema migration logic.

## Files to Change

| File | Change |
|------|--------|
| `packages/server/src/db/schema.ts` | Add `ensureColumn` calls for both new columns in `ensureColumnsForExistingTables()`. Bump `SCHEMA_VERSION`. |
| `packages/server/src/db/schema.sql` | Add `parent_node_id TEXT` and `iteration_index INTEGER` to `CREATE TABLE node_executions` |
| `packages/server/src/db/types.ts` | Add `parent_node_id: string \| null` and `iteration_index: number \| null` to `NodeExecutionRow` |
| `packages/server/src/db/dao/execution-dao.ts` | Update `insertNodeExecution`, `insertNodeExecutionOrIgnore` to include new columns. Add new columns to `updateNodeExecution` allowed set. |

## Implementation Details

### schema.ts
```ts
// In ensureColumnsForExistingTables():
ensureColumn(db, 'node_executions', 'parent_node_id', "TEXT")
ensureColumn(db, 'node_executions', 'iteration_index', "INTEGER")
```

### schema.sql
Add to `node_executions` CREATE TABLE:
```sql
parent_node_id TEXT,
iteration_index INTEGER,
```

### execution-dao.ts
- `insertNodeExecution`: Add `parent_node_id` and `iteration_index` to INSERT columns and VALUES
- `insertNodeExecutionOrIgnore`: Same changes
- `updateNodeExecution`: Add `"parent_node_id"` and `"iteration_index"` to the `allowed` set

## Verification Method

```bash
# 1. TypeScript compilation
cd packages/server && pnpm tsc --noEmit

# 2. Unit tests
cd ../.. && pnpm test -- packages/server
```

## Acceptance Criteria

- [ ] Both columns exist in schema.sql CREATE TABLE
- [ ] Both columns added via ensureColumn for existing databases
- [ ] NodeExecutionRow type includes both fields as nullable
- [ ] insertNodeExecution and insertNodeExecutionOrIgnore accept and persist both fields
- [ ] updateNodeExecution allows updating both fields
- [ ] TypeScript compiles cleanly
- [ ] Existing tests pass
