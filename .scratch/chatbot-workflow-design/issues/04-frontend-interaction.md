# Ticket 4: Frontend — useInteractionStream Hook + InteractionModal Refactor

## Summary
Create the `useInteractionStream` hook that targets the new interaction API, and refactor `InteractionModal` to use it instead of the chat system.

## Scope

### 4.1 useInteractionStream Hook

Create `packages/web-app/components/workspace/interaction/use-interaction-stream.ts`:

**Interface:**
```typescript
interface UseInteractionStreamOptions {
  workspaceId: string
  executionId: string
  nodeId: string
}

interface UseInteractionStreamReturn {
  messages: ChatMessage[]
  isStreaming: boolean
  error: string | null
  sendMessage: (content: string) => Promise<void>
  abort: () => void
  status: "requesting" | null
  streamStartMs: number | null
  streamEndState: "done" | "aborted" | null
  hasMoreMessages: boolean
  loadMoreMessages: () => void
}
```

**Implementation:**
- Similar SSE parsing logic to `useChatStream`
- API base: `/api/workspaces/${workspaceId}/interactions/${executionId}/${nodeId}`
- `sendMessage`: POST to `/messages` endpoint, read SSE stream
- `loadMoreMessages`: GET `/messages?limit=100&before=...`
- Apply same `applyChunkToMessages` logic for SSE event processing
- Track streaming state, abort, error

### 4.2 InteractionModal Refactor

Modify `packages/web-app/components/workspace/interaction-modal.tsx`:

**Remove:**
- Chat session creation via `POST /executions/:id/interaction/:nodeId/start`
- `useChatStream` hook usage
- Chat session polling logic
- `sessionCreatedRef` guard for chat session

**Add:**
- `useInteractionStream` hook initialization with `{ workspaceId, executionId, nodeId }`
- Call `start` endpoint on open (returns internal sessionId, not chat session)
- Pass interaction hook data to ChatPanel

**Keep:**
- ChatPanel component for rendering (MessageBubble, QuestionCard, etc.)
- EventSource listener for `execution_interaction_completed`
- Force complete button (now calls interaction API)
- Dual render mode (modal/panel)

**Data mapping:**
- `useInteractionStream` returns `ChatMessage[]` compatible with ChatPanel
- `sendMessage` from hook → `onSendMessage` prop on ChatPanel
- `isStreaming` → ChatPanel streaming state

### 4.3 API Client Update

Update `packages/web-app/lib/api-client.ts` if needed for new interaction endpoints.

## Files to Create
- `packages/web-app/components/workspace/interaction/use-interaction-stream.ts`

## Files to Modify
- `packages/web-app/components/workspace/interaction-modal.tsx` — refactor to use new hook

## Verification
- [ ] `pnpm build` passes (web-app compiles)
- [ ] InteractionModal renders with new data source
- [ ] SSE streaming works (messages appear in real-time)
