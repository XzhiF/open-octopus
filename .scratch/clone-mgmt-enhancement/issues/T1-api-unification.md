# T1: API Unification — Merge Two Clone API Systems

## Status: pending

## Summary

Merge the old `/api/agent/clones` (filesystem meta.json) and new `/api/clones` (DB-backed CloneDAO) into a single unified `/api/clones` API that is filesystem-backed. Add `display_name` support. Update frontend types and API calls.

## Scope

### Server changes

1. **Rewrite `routes/clone/index.ts`** to be filesystem-backed (no CloneDAO dependency for clone definitions):
   - `GET /api/clones` — read built-in clones from `~/.octopus/agent/built-in/` + user clones from `~/.octopus/agent/clones/`, return unified CloneInfo with `display_name` and `type`
   - `POST /api/clones` — create user clone: mkdir + write config.json (with display_name) + persona.md
   - `GET /api/clones/:name` — read from filesystem (check built-in dir first, then clones dir)
   - `DELETE /api/clones/:name` — delete user clone dir (return 403 for built-in)

2. **Add `resolveCloneDef()` helper** that reads from filesystem:
   - Built-in: `~/.octopus/agent/built-in/{name}/config.json` + `persona.md`
   - User: `~/.octopus/agent/clones/{name}/config.json` + `persona.md`

3. **Update `clone-init-service.ts`** to write `display_name` in config.json for built-in clones

4. **Update `builtin-clones.ts`** to include `display_name` for each built-in clone

5. **Remove old clone routes from `routes/agent/clone-routes.ts`**:
   - Remove: POST/GET/DELETE `/clones`, POST `/clones/:name/delegate`
   - Keep: POST `/clones/:name/merge`, POST `/clones/:name/delegate/cancel`, GET `/clones/:name/experiences`, POST `/clones/:name/activate`, DELETE `/clones/active`

6. **Keep session routes** in `routes/clone/index.ts` unchanged (sessions still DB-backed)

7. **Update `main-agent-route.ts`** to use filesystem-based `resolveCloneDef()` instead of CloneDAO

### Frontend changes

8. **Update `lib/agent/types.ts`** CloneInfo to match new response type (add display_name, type, persona, skills, memory_scope)

9. **Update `lib/agent/api.ts`** to call `/api/clones` endpoints (not `/api/agent/clones`)

10. **Update `useAgentClones` hook** to work with new CloneInfo shape

## Verification

### Integration tests (`packages/server/src/__tests__/clone-api.test.ts`)

- `GET /api/clones` returns 4 built-in + 0 user clones initially
- `POST /api/clones` creates user clone with display_name
- `GET /api/clones/:name` returns clone details for built-in and user
- `DELETE /api/clones/:name` deletes user clone, returns 403 for built-in
- `POST /api/clones` without skills succeeds (skills optional)

### Build verification

- `pnpm build` passes
- `pnpm test` passes (existing clone-runtime tests still green)

## Dependencies

- None (first ticket)

## Files to modify

- `packages/server/src/routes/clone/index.ts` — rewrite to filesystem-backed
- `packages/server/src/services/agent/builtin-clones.ts` — add display_name
- `packages/server/src/services/agent/clone-init-service.ts` — write display_name in config.json
- `packages/server/src/routes/agent/clone-routes.ts` — remove CRUD routes
- `packages/server/src/routes/agent/main-agent-route.ts` — use filesystem resolution
- `packages/server/src/routes/agent/index.ts` — update route mounting
- `packages/server/src/index.ts` — update clone route mounting
- `packages/web-app/lib/agent/types.ts` — update CloneInfo
- `packages/web-app/lib/agent/api.ts` — update clone API calls
- `packages/web-app/hooks/useAgentClones.ts` — update to new shape
- `packages/server/src/__tests__/clone-api.test.ts` — new test file
