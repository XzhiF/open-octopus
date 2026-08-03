# T1: Core lib/ modules — api.mjs, workspace.mjs, execution.mjs, db.mjs

## Status: DONE

## Scope

Implement 4 core API/DB layer modules:
- `lib/api.mjs` — unified HTTP + port resolution
- `lib/workspace.mjs` — workspace lifecycle CRUD
- `lib/execution.mjs` — workflow execution + polling
- `lib/db.mjs` — SQLite CLI execution

## API Contracts

See spec.md for full signatures.

## Verification Method

1. `node -c lib/api.mjs` → syntax OK
2. `node -c lib/workspace.mjs` → syntax OK
3. `node -c lib/execution.mjs` → syntax OK
4. `node -c lib/db.mjs` → syntax OK
5. All functions exported correctly
