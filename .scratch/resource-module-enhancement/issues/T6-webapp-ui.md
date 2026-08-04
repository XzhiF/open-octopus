# T6: Web UI — Type Filters + Activate/Deactivate + Badges + Uninstall Flow

## Status: done

## Problem

The web UI resource list only has 3 type filter buttons (skill/agent/workflow). Resource cards don't show activation status. There's no way to activate/deactivate from the UI. The uninstall dialog doesn't handle activated-resource blocking or clone backup confirmation.

## Solution

### resource-list.tsx
1. Add 3 new type filter buttons: Rules, Commands, Clones
2. Add count tracking for new types in `counts` useMemo
3. Update empty state text to mention new types

### resource-card.tsx
1. Add icon mapping for `rule` (ScrollText), `command` (Terminal), `clone` (Copy)
2. Add badge variant styles for new types
3. Show "Activated" green badge when `entry.activated === true`
4. Show "Activate" button for inactive new-type resources (rule/command/clone only)
5. Show "Deactivate" button for activated resources
6. Disable uninstall button when activated (tooltip: "Deactivate first")

### UninstallConfirm.tsx
1. For clone type: show "Keep backup?" checkbox
2. For activated resources: show "Deactivate first" warning
3. Pass `keepBackup` to uninstall API call

### api.ts
1. Add `activateResource(name, type)` function
2. Add `deactivateResource(name, type)` function
3. Update `uninstallResource` to accept `keepBackup` param

### types.ts
1. Update `ListQuery.type` union to include new types

## Acceptance Criteria

- [ ] `/resources` page shows 7 filter buttons (all + 6 types)
- [ ] Type counts update correctly for new types
- [ ] Resource cards for new types show correct icons
- [ ] Activated resources shows green "Activated" badge
- [ ] Inactive rule/command/clone cards show "Activate" button
- [ ] Activated cards show "Deactivate" button
- [ ] Clicking Activate calls activate API and refreshes list
- [ ] Clicking Deactivate calls deactivate API and refreshes list
- [ ] Uninstall button disabled with tooltip when activated
- [ ] Clone uninstall shows backup checkbox
- [ ] Uninstall passes keepBackup flag to API
- [ ] All existing tests still pass
- [ ] TypeScript compiles without errors

## Files to Change

- `packages/web-app/components/resource/resource-list.tsx` — filter buttons, counts
- `packages/web-app/components/resource/resource-card.tsx` — icons, badges, buttons
- `packages/web-app/components/resource/UninstallConfirm.tsx` — backup dialog, guard
- `packages/web-app/lib/resource/api.ts` — new API functions
- `packages/web-app/lib/resource/types.ts` — type expansion

## Tests to Write

- No automated tests for UI components (covered by E2E in brief, but not in this iteration scope)
- TypeScript type-check serves as validation
