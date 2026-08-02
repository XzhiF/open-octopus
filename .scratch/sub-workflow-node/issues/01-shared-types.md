# Ticket 1: Shared Types — Add `sub_workflow` to NodeDef and NodeTypeSchema

## Status: READY
## Priority: P0 (blocks all other tickets)
## Verification: `pnpm build` passes

### Changes

1. `packages/shared/src/types/workspace.ts`:
   - Add `"sub_workflow"` to `NodeTypeSchema` enum

2. `packages/shared/src/types/workflow.ts`:
   - Add `"sub_workflow"` to `NodeDef.type` union
   - Add sub_workflow fields to `NodeDef` interface: `workflow`, `execution_mode`, `input_mapping`, `output_mapping`, `on_error`
   - Add same fields to `NodeSchema` Zod schema
   - Add `"sub_workflow"` to the `type` enum in `NodeSchema`

### Acceptance Criteria
- `NodeTypeSchema` includes `"sub_workflow"`
- `NodeDef` has sub_workflow fields typed correctly
- `NodeSchema` Zod validates sub_workflow YAML nodes
- `pnpm build` passes for `@octopus/shared`
