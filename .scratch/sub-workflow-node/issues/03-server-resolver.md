# Ticket 3: Server — Pass workflowResolver to Engine

## Status: DONE
## Priority: P0
## Depends on: Ticket 2
## Verification: `pnpm build` passes

### Changes

1. `packages/server/src/services/execution/EngineFactory.ts`:
   - Create a `workflowResolver` callback that resolves workflows from `WorkflowService` + `BuiltInWorkflowService`
   - Pass it to the `WorkflowEngine` constructor

### Acceptance Criteria
- WorkflowEngine receives a workflowResolver that can load any workspace workflow by name
- Sub-workflow nodes can resolve child workflows during execution
- `pnpm build` passes for `@octopus/server`
