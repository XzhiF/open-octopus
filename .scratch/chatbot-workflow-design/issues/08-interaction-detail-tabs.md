# Ticket 8: InteractionDetailTabs — Node Detail UI Component

## Summary
Create the `InteractionDetailTabs` component that displays interaction node details in three tabs: conversation history, trace (tokens/cost), and results. Register it in `NodeInfoDialog` for the `"interaction"` executor type.

## Scope

### 8.1 InteractionDetailTabs Component

Create `packages/web-app/components/workspace/interaction/interaction-detail-tabs.tsx`:

```typescript
interface InteractionDetailTabsProps {
  executionId: string
  nodeId: string
  workspaceId: string
}
```

**Three tabs:**

#### Tab 1: Conversation (对话记录)
- Fetches messages from `GET /api/workspaces/:wsId/interactions/:execId/:nodeId/messages`
- Renders using `MessageBubble` component (reused from ChatPanel)
- Shows user/assistant messages with timestamps
- Supports `ask_user_question` display type

#### Tab 2: Trace (追踪)
- Fetches from existing endpoints:
  - `llm_calls` for the node_execution_id
  - `node_token_usages` for the node_execution_id
- Displays: model, input/output tokens, cache tokens, cost, duration
- Reuses existing trace display patterns from `AgentDetailTabs`

#### Tab 3: Result (结果)
- Fetches from node execution data:
  - `outputs` — the node's output mapping
  - `vars_snapshot` — VarPool snapshot at completion
- Displays:
  - `summary` text from the completion data
  - `vars_update` key-value pairs
  - Output mapping results

### 8.2 NodeInfoDialog Registration

Modify `packages/web-app/components/workspace/node-info-dialog.tsx`:

Add `"interaction"` to the executor type dispatch:

```typescript
case "interaction":
  return <InteractionDetailTabs
    executionId={executionId}
    nodeId={step.nodeId}
    workspaceId={workspaceId}
  />
```

### 8.3 Component Architecture

- Use Tabs component (from existing UI library, e.g., Radix or shadcn)
- Each tab lazy-loads its data on first activation
- Conversation tab reuses `MessageBubble` from chat components
- Trace tab reuses trace display patterns from agent detail
- Result tab uses simple key-value display

## Files to Create
- `packages/web-app/components/workspace/interaction/interaction-detail-tabs.tsx`

## Files to Modify
- `packages/web-app/components/workspace/node-info-dialog.tsx` — register interaction type

## Verification
- [ ] `pnpm build` passes
- [ ] Clicking a completed interaction node shows 3 tabs
- [ ] Conversation tab displays message history
- [ ] Trace tab shows token/cost data
- [ ] Result tab shows summary and vars_update
