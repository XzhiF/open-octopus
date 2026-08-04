# T1: Shared Types — ResourceType Expansion + Activated Fields

## Status: done

## Problem

The resource module currently supports only 3 types: `skill`, `agent`, `workflow`. The brief requires 3 new types: `rule`, `command`, `clone`. Additionally, the new types need an activation lifecycle with `activated`, `activatedAt`, and `activatedTo` fields tracked in the registry. The audit system needs `activate` and `deactivate` actions. Error codes need expansion for activation-related errors. Request/response schemas need activation/deactivation endpoints and `keepBackup` on uninstall.

## Solution

1. Expand `ResourceType` Zod enum from 3 → 6 values
2. Add `activated`, `activatedAt`, `activatedTo` fields to `ResourceEntrySchema`
3. Add `activate` and `deactivate` to `ResourceAuditAction` enum
4. Add `keepBackup` to `UninstallRequestSchema`, `backupPath` to `UninstallResponseSchema`
5. Create `ActivateRequestSchema`, `ActivateResponseSchema`, `DeactivateRequestSchema`, `DeactivateResponseSchema`
6. Expand `ResourceCountSchema` with `rules`, `commands`, `clones` fields
7. Add 3 new error codes: `ACTIVATION_BLOCKED`, `DEACTIVATION_BLOCKED`, `UNINSTALL_BLOCKED`
8. Update `ManifestResourceSchema` to accept new types
9. Update `SourceDiscovery`'s manifest schema inline enum
10. Update web-app `ListQuery` type

## Acceptance Criteria

- [ ] `ResourceType` enum accepts `"rule"`, `"command"`, `"clone"`
- [ ] `ResourceEntry` parse includes `activated: boolean` (default false), `activatedAt?: string`, `activatedTo?: string`
- [ ] `ResourceAuditAction` includes `"activate"` and `"deactivate"`
- [ ] `UninstallRequest` accepts `keepBackup?: boolean`
- [ ] `UninstallResponse` includes `backupPath?: string`
- [ ] `ActivateRequest` and `ActivateResponse` schemas exist and validate correctly
- [ ] `DeactivateRequest` and `DeactivateResponse` schemas exist and validate correctly
- [ ] `ResourceCountSchema` includes `rules`, `commands`, `clones`
- [ ] New error codes `ACTIVATION_BLOCKED` (409), `DEACTIVATION_BLOCKED` (409), `UNINSTALL_BLOCKED` (409) exist with correct HTTP status
- [ ] All existing tests still pass (`pnpm test`)
- [ ] TypeScript compiles without errors for `@octopus/shared`

## Files to Change

- `packages/shared/src/resource/types.ts` — enum expansion, new schemas, new fields
- `packages/shared/src/resource/errors.ts` — new error codes
- `packages/shared/src/resource/index.ts` — verify new exports (barrel should auto-export via `types`)
- `packages/web-app/lib/resource/types.ts` — update `ListQuery` type

## Tests to Write

- `packages/shared/src/__tests__/resource.test.ts` — extend existing test file:
  - ResourceType accepts 6 values
  - ResourceEntry with activated fields parses correctly
  - New audit actions validate
  - ActivateRequest/DeactivateRequest schemas validate
  - New error codes have correct status codes
  - ResourceCountSchema includes new type counts
