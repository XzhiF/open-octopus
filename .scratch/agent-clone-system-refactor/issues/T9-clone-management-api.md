# T9: Clone Management API Enhancement

**Status:** pending
**Depends on:** T1, T2, T4
**Blocks:** —

## Scope

Enhance the existing clone management routes to support the new clone system with proper DB-backed CRUD and built-in/user clone distinction.

## Changes

### 9.1 Enhanced Clone Management Routes

Update `packages/server/src/routes/agent/clone-routes.ts` to add DB-backed management:

| Method | Path | Handler | Notes |
|--------|------|---------|-------|
| `GET` | `/api/agent/clones` | List all clones | Built-in + user clones (from DB) |
| `GET` | `/api/agent/clones/:name` | Get clone details | CloneDef format |
| `POST` | `/api/agent/clones` | Create user clone | DB registration + filesystem |
| `DELETE` | `/api/agent/clones/:name` | Delete user clone | Built-in clones cannot be deleted |

### 9.2 CloneDAO Extensions

Add `type` column support:

```typescript
/** Find clone by name with type filter */
findByNameAndType(name: string, type: string): CloneRow | null

/** List clones by type */
listByType(org: string, type: string): CloneRow[]

/** Insert with type column */
insertWithType(row: CloneRow & { type: string }): RunResult
```

### 9.3 Backward Compatibility

- Existing filesystem-based clone operations (delegate, merge, activate) remain functional
- New DB-backed list/get operations supplement existing routes
- Old `meta.json` format still works for user clones

### 9.4 Built-in Clone Protection

- `DELETE /api/agent/clones/:name` returns 403 for built-in clones
- `POST /api/agent/clones` with a name matching a built-in clone returns 409

## Verification

1. `GET /api/agent/clones` returns 4 built-in clones + any user clones
2. `GET /api/agent/clones/workspace` returns CloneDef for workspace clone
3. `POST /api/agent/clones` creates a user clone with DB entry
4. `DELETE /api/agent/clones/workspace` returns 403 (built-in protection)
5. `DELETE /api/agent/clones/my-clone` deletes user clone
6. `pnpm build` passes
7. `pnpm test -- packages/server` passes
