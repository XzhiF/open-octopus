# T4: Server Routes — Activate/Deactivate Endpoints + Modified Uninstall + Middleware

## Status: pending

## Problem

The server currently exposes 10 resource endpoints but has no activate/deactivate endpoints. The middleware `VALID_TYPES` set only allows 3 types. The uninstall endpoint doesn't support `keepBackup` or activation guard. The list endpoint type filter validation is hardcoded to 3 types. The audit endpoint `VALID_ACTIONS` doesn't include activate/deactivate.

## Solution

1. Add `POST /activate` route — validates with `ActivateRequestSchema`, calls `manager.activate()`
2. Add `POST /deactivate` route — validates with `DeactivateRequestSchema`, calls `manager.deactivate()`
3. Modify `POST /uninstall` — pass `keepBackup` to manager, map `UNINSTALL_BLOCKED` error
4. Modify `GET /` list — accept new types in filter validation
5. Modify `GET /audit` — add activate/deactivate to VALID_ACTIONS
6. Update middleware `VALID_TYPES` set to include `rule`, `command`, `clone`
7. Update middleware error suggestion message
8. Add `ACTIVATION_BLOCKED`/`DEACTIVATION_BLOCKED` to error mapping in `mapError()`

## Acceptance Criteria

- [ ] `POST /api/resources/activate` with valid name/type returns `{ name, type, activatedTo }`
- [ ] `POST /api/resources/activate` on not-found returns 404
- [ ] `POST /api/resources/activate` on already-activated returns 409
- [ ] `POST /api/resources/activate` on skill/agent/workflow returns 400
- [ ] `POST /api/resources/deactivate` with valid name/type returns `{ name, type }`
- [ ] `POST /api/resources/deactivate` on not-activated returns 409
- [ ] `POST /api/resources/uninstall` with activated resource returns 409 (UNINSTALL_BLOCKED)
- [ ] `POST /api/resources/uninstall` with `keepBackup: true` for clone returns `backupPath`
- [ ] `GET /api/resources?type=rule` returns only rules
- [ ] `GET /api/resources?type=command` returns only commands
- [ ] `GET /api/resources?type=clone` returns only clones
- [ ] `GET /api/resources/audit?action=activate` returns activate records
- [ ] Middleware accepts `rule`, `command`, `clone` as valid type params
- [ ] All existing tests still pass
- [ ] TypeScript compiles without errors

## Files to Change

- `packages/server/src/routes/resource/index.ts` — new routes, modified routes
- `packages/server/src/routes/resource/middleware.ts` — VALID_TYPES expansion

## Tests to Write

- `packages/server/src/routes/resource/__tests__/resource-routes.test.ts` — extend:
  - POST /activate — success, not-found, already-activated, invalid-type
  - POST /deactivate — success, not-found, not-activated
  - POST /uninstall — block if activated, keepBackup flag
  - GET / with new type filters
  - GET /audit with activate/deactivate actions
  - Middleware validates new types
