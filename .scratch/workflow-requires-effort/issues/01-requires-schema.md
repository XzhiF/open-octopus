# Ticket 1: Add `requires` Field to WorkflowSchema

## Status: Ready

## Summary

Add a top-level `requires` field to WorkflowSchema that allows workflows to explicitly declare their skill and agent_file dependencies.

## Scope

- **Package**: `@octopus/shared`
- **Files**: `packages/shared/src/types/workflow.ts`
- **Type**: Schema addition (backward compatible)

## Acceptance Criteria

1. `WorkflowSchema.parse()` accepts `requires: { skills: string[], agent_files: string[] }`
2. Both `skills` and `agent_files` are optional within `requires`
3. The entire `requires` field is optional (backward compatible)
4. `WorkflowDef` type includes `requires?: { skills?: string[], agent_files?: string[] }`

## Implementation Plan

### Step 1: Write tests (RED)

Create `packages/shared/__tests__/requires-schema.test.ts`:
- Test that `requires` with both fields parses successfully
- Test that `requires` with only `skills` parses
- Test that `requires` with only `agent_files` parses
- Test that empty `requires: {}` parses
- Test that workflow without `requires` still parses (backward compat)
- Test that invalid types in `requires.skills` (non-string array) fail

### Step 2: Implement schema (GREEN)

Add to `WorkflowSchema` in `packages/shared/src/types/workflow.ts`:

```typescript
requires: z.object({
  skills: z.array(z.string()).optional(),
  agent_files: z.array(z.string()).optional(),
}).optional(),
```

The `WorkflowDef` type is inferred from `WorkflowSchema` via `z.infer`, so no separate interface needed.

### Step 3: Verify

Run `pnpm test` to ensure all tests pass.

## Verification Method

```bash
pnpm test --filter @octopus/shared -- requires-schema
```

## Dependencies

None — this is the foundation ticket.
