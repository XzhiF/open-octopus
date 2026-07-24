# T7: Frontend — @@mention Autocomplete + Delegation

## Status: pending

## Summary

Implement @@mention in the chat input: detect `@@` pattern, show autocomplete dropdown with clone list, parse message on send to extract `delegate_to` field, and display delegation responses with source badge.

## Scope

### Frontend changes

1. **New component: `MentionAutocomplete.tsx`**:
   - Wraps the chat input area
   - Detects `@@` pattern in input text
   - Shows dropdown with clone list (fetched from `GET /api/clones`, cached)
   - Filters by typed characters after `@@`
   - Each item shows: display_name + name + type badge
   - Excludes "Main Agent" from list (no upward delegation)
   - Selection replaces `@@typed` with `@@clone-name ` (with space)
   - Close on: Escape, click outside, backspace past `@@`

2. **Message send parsing**:
   - Before sending, detect `@@clone-name` at start of message
   - Extract `clone_name` from the pattern
   - Strip the `@@clone-name` prefix from message text
   - If current chat is same clone → send as normal message (self-reference no-op)
   - Otherwise: send with `delegate_to: clone_name`

3. **Update `useAgentChat` hook** (or chat send flow):
   - Accept optional `delegate_to` parameter in send function
   - Pass `delegate_to` to `chatStream()` call

4. **Update `api.ts` chatStream()**:
   - Accept `opts.delegate_to` and include in request body

5. **Source badge display**:
   - In `ChatArea` message list, when SSE events have `source` field:
     - Show badge: `[scheduler]` before the response text
   - User messages retain original `@@syntax` in display

6. **Update `ChatArea` component**:
   - Accept mention autocomplete wrapper or integrate inline
   - Handle `source` field in streaming messages
   - Show delegation status indicator

## Verification

### Manual checklist

- [ ] Type `@@` → autocomplete dropdown appears
- [ ] Type `@@sch` → filters to "scheduler"
- [ ] Select clone → input shows `@@scheduler `
- [ ] Send message → request includes `delegate_to: "scheduler"`
- [ ] Response shows source badge
- [ ] Self-reference (@@scheduler in scheduler chat) → normal message
- [ ] Code blocks containing `@@` → no autocomplete trigger

## Dependencies

- T1 (unified clone list API)
- T3 (backend delegate_to support)

## Files to modify

- `packages/web-app/components/agent/chat/MentionAutocomplete.tsx` — new component
- `packages/web-app/components/agent/chat/ChatArea.tsx` — integrate autocomplete + source badge
- `packages/web-app/hooks/useAgentChat.ts` — add delegate_to support
- `packages/web-app/lib/agent/api.ts` — add delegate_to to chatStream
- `packages/web-app/lib/agent/types.ts` — add mention-related types
