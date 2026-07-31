# T10: Web App — Interaction Node UI

## Status: pending

## Scope
Add frontend support for interaction nodes:

1. **Interaction node component** (`packages/web-app/components/workspace/workflow-nodes/interaction-node.tsx`):
   - Visual representation in workflow graph (similar to approval-node)
   - Shows `pending_interaction` status with distinct styling

2. **Interaction Modal** (`packages/web-app/components/workspace/interaction-modal.tsx`):
   - Dialog that opens when `execution_interaction_started` SSE event received (modal mode)
   - Embeds chatbot UI for the interaction session
   - Closes on `execution_interaction_completed`

3. **Interaction Panel** (extend existing chat panel):
   - When display mode is `panel`, embed chatbot in sidebar
   - Don't block workflow visualization

4. **SSE event handlers**:
   - Listen for `execution_interaction_started` → open modal/panel
   - Listen for `execution_interaction_completed` → close modal, update node status

5. **Node detail view**:
   - Add interaction detail tabs (similar to approval-detail-tabs)
   - Show interaction summary, vars_update, round count

## Files
- Create: `packages/web-app/components/workspace/workflow-nodes/interaction-node.tsx`
- Create: `packages/web-app/components/workspace/interaction-modal.tsx`
- Modify: SSE event handlers in execution views
- Modify: node detail components

## Dependencies
- T7 (API routes + SSE events)

## Verification Method
- `pnpm build` passes for @octopus/web-app
- Manual: start a workflow with interaction node, verify modal/panel opens
- Existing UI tests still pass
