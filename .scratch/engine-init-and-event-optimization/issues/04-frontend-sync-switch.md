# Ticket 4: Frontend UI — syncMainBranch Switch + Form Data Types

## Status: DONE

## Description

Add "同步主分支" Switch control to ExecuteNodeDialog and CreateNodeDialog, update form data types, and pass `syncMainBranch` through to the start API.

## Files

- `packages/web-app/lib/types.ts` (add `syncMainBranch` to form types)
- `packages/web-app/components/workspace/execute-node-dialog.tsx` (add Switch)
- `packages/web-app/components/workspace/create-node-dialog.tsx` (add Switch)
- `packages/web-app/components/workspace/workspace-flow-panel.tsx` (or wherever start is called — pass param)

## Changes

### types.ts

```typescript
// ExecuteNodeFormData — add field
export interface ExecuteNodeFormData {
  inputValues: Record<string, string>
  rollbackOnError: boolean
  syncMainBranch?: boolean  // NEW
}

// CreateNodeFormData — add field
export interface CreateNodeFormData {
  workflowRef: string
  name: string
  rollbackOnError: boolean
  inputValues: Record<string, string>
  syncMainBranch?: boolean  // NEW
}
```

### execute-node-dialog.tsx

Add Switch below existing "回滚" switch:

```tsx
<div className="flex items-center justify-between rounded-lg border p-3">
  <div className="space-y-0.5">
    <Label htmlFor="sync-main-switch">同步主分支</Label>
    <p className="text-xs text-muted-foreground">
      执行前拉取所有项目的最新主分支代码
    </p>
  </div>
  <Switch
    id="sync-main-switch"
    checked={syncMainBranch}
    onCheckedChange={setChecked}
  />
</div>
```

Default value: `true`

### create-node-dialog.tsx

Same Switch control, same position.

### API caller

Where `onConfirm` handler calls start API, include `syncMainBranch` in the request body:

```typescript
fetch(`/api/workspaces/${wsId}/executions/${execId}/start`, {
  method: 'POST',
  body: JSON.stringify({ inputValues, syncMainBranch: formData.syncMainBranch ?? true }),
})
```

## Acceptance Criteria

- [ ] ExecuteNodeDialog shows "同步主分支" Switch, default on
- [ ] CreateNodeDialog shows "同步主分支" Switch, default on
- [ ] Form submission includes `syncMainBranch` in API request
- [ ] `pnpm build` succeeds

## Verification

- `pnpm build` passes
- Manual: open ExecuteNodeDialog, verify Switch appears and defaults to on
