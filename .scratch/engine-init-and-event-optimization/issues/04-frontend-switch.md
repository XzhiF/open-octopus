# Ticket 4: Frontend — add "同步主分支" Switch to ExecuteNodeDialog and CreateNodeDialog

## Status: DONE

## Description

Add a Switch control labeled "同步主分支" to both dialog components. Default value is `true`. Pass the value through form data to the start API.

## Files

- `packages/web-app/lib/types.ts` (extend `ExecuteNodeFormData` and `CreateNodeFormData`)
- `packages/web-app/components/workspace/execute-node-dialog.tsx`
- `packages/web-app/components/workspace/create-node-dialog.tsx`
- `packages/web-app/hooks/use-scheduler-submit.ts` or equivalent submission hook

## Changes

### types.ts

```typescript
export interface ExecuteNodeFormData {
  inputValues: Record<string, string>
  rollbackOnError: boolean
  syncMainBranch: boolean  // NEW — default true
}

export interface CreateNodeFormData {
  workflowRef: string
  name: string
  rollbackOnError: boolean
  inputValues: Record<string, string>
  syncMainBranch: boolean  // NEW — default true
}
```

### execute-node-dialog.tsx

Add persisted state for `syncMainBranch` (default `true`), add Switch UI after rollback Switch, include in `onConfirm` payload.

### create-node-dialog.tsx

Add `syncMainBranch: true` to `defaultFormData()`, add Switch UI, include in form submission.

### API call

The submission hook must pass `syncMainBranch` to `startExecution()`:

```typescript
await startExecution(workspaceId, executionId, {
  inputValues: formData.inputValues,
  syncMainBranch: formData.syncMainBranch,
})
```

## Verification

- `pnpm build` succeeds (type check passes)
- Manual E2E: Switch appears in both dialogs, default checked
- Manual E2E: Unchecking Switch passes `syncMainBranch: false` to API
