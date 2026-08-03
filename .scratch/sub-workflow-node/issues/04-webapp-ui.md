# Ticket 4: Web-App — Flow Parser + Container Node + Registration

## Status: DONE
## Priority: P0
## Depends on: Ticket 1
## Verification: `pnpm build` passes

### Changes

1. `packages/web-app/lib/workflow-parser.ts`:
   - Add `"sub_workflow"` to `VALID_NODE_TYPES`
   - Handle sub_workflow nodes as containers (similar to loop)
   - Compute container dimensions for sub_workflow nodes
   - Layout inner nodes if available (from workflow field parsed as inner nodes placeholder)

2. `packages/web-app/components/workspace/workflow-nodes/sub-workflow-container-node.tsx` (NEW):
   - Container component modeled after `loop-container-node.tsx`
   - Dashed border, `Layers` icon, "子工作流" badge
   - Shows workflow reference name and execution mode
   - Status overlay support (running/completed/failed)
   - Handles/position connectors

3. `packages/web-app/components/workspace/workflow-flow-viewer.tsx`:
   - Import `SubWorkflowContainerNode`
   - Register `"sub-workflow-container"` in `nodeTypes` map

### Acceptance Criteria
- sub_workflow nodes render as containers in the flow chart
- Container shows Layers icon, workflow name, "子工作流" badge
- Status border colors work correctly
- `pnpm build` passes for `@octopus/web-app`
