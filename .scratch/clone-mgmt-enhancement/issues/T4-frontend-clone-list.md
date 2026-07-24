# T4: Frontend — Clone List UI (System/User Split)

## Status: done

## Summary

Split the clone list view into two sections: system clones (top, 4 built-in) and user clones (bottom, createable/deletable). Update to use unified API types. Built-in clone cards should not show delete/merge options.

## Scope

### Frontend changes

1. **Update `CloneTab.tsx`**:
   - Split clones into `systemClones` (type === 'built-in') and `userClones` (type === 'user')
   - Render two `CloneCardGrid` sections with headers: "系统分身" and "用户分身"
   - Move "创建分身" button to user section header

2. **Update `CloneCardGrid.tsx`**:
   - Accept `showActions` prop (true for user clones, false for built-in)
   - For built-in clones: hide dropdown menu (no merge/delete)
   - Show `display_name` as card title, `name` as subtitle
   - Show type badge: "系统" for built-in, "用户" for user

3. **Update `CloneDeleteDialog.tsx`**:
   - Already handles delete, but ensure built-in clones cannot reach this dialog

4. **Update `CloneCardGrid` card layout**:
   - Display `display_name` prominently
   - Show `name` as secondary text (monospace)
   - Show `persona` excerpt (first 100 chars)
   - Show skills count badge

## Verification

### Manual checklist

- [ ] System section shows 4 built-in clones (Workspace, Scheduler, Archive, Resource)
- [ ] User section shows user-created clones
- [ ] Built-in clone cards have no delete/merge options
- [ ] display_name shown on cards
- [ ] Click clone → enters chat view

## Dependencies

- T1 (unified API + new CloneInfo type)

## Files to modify

- `packages/web-app/components/agent/clone/CloneTab.tsx`
- `packages/web-app/components/agent/clone/CloneCardGrid.tsx`
- `packages/web-app/components/agent/clone/CloneDeleteDialog.tsx`
