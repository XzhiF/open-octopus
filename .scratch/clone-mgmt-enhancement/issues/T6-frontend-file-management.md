# T6: Frontend — File Management Panel

## Status: pending

## Summary

Add a file management panel (as a Sheet/drawer) for viewing and editing clone files (persona.md and config.json). Available for all clones (built-in + user).

## Scope

### Frontend changes

1. **New component: `CloneFilePanel.tsx`**:
   - Sheet (side drawer) triggered from clone card action menu
   - Tab selector: "persona.md" | "config.json"
   - Textarea editor for each file
   - Save button → calls `PUT /api/clones/:name/files/:path`
   - Load on open → calls `GET /api/clones/:name/files/:path`
   - Unsaved changes warning

2. **Update `CloneCardGrid.tsx`**:
   - Add "文件管理" menu item to dropdown (for all clones, including built-in)

3. **Update `lib/agent/api.ts`**:
   - Add `getCloneFile(name: string, path: string): Promise<{ content: string }>`
   - Add `updateCloneFile(name: string, path: string, content: string): Promise<{ ok: true }>`

4. **Update `CloneTab.tsx`**:
   - Accept file management state (which clone's files are open)
   - Render `CloneFilePanel` sheet

## Verification

### Manual checklist

- [ ] Click "文件管理" on clone card → drawer opens
- [ ] persona.md tab shows persona content
- [ ] config.json tab shows config content
- [ ] Edit and save → success toast, file updated
- [ ] Works for both built-in and user clones

## Dependencies

- T2 (file management API endpoints)

## Files to modify

- `packages/web-app/components/agent/clone/CloneFilePanel.tsx` — new component
- `packages/web-app/components/agent/clone/CloneCardGrid.tsx` — add menu item
- `packages/web-app/components/agent/clone/CloneTab.tsx` — add sheet state
- `packages/web-app/lib/agent/api.ts` — add file management API calls
