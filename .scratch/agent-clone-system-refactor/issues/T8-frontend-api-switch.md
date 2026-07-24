# T8: Frontend API Path Switch (Workspace/Scheduler Chat → Clone API)

**Status:** deferred (out of scope — web-app excluded from this spec iteration)
**Depends on:** T5
**Blocks:** —

## Scope

Update the web-app frontend to use the new clone session API paths instead of the old workspace/agent chat paths. Rendering logic must NOT change.

## Changes

### 8.1 API Path Migration

| Current Path | New Path | Context |
|-------------|----------|---------|
| `POST /api/workspaces/:id/chat/send` | `POST /api/clones/workspace/sessions/:id/chat` | Workspace chat |
| `POST /api/workspaces/:id/chat/stop` | `POST /api/clones/workspace/sessions/:id/stop` | Workspace stop |
| `POST /api/agent/sessions/:id/chat` | `POST /api/clones/:name/sessions/:id/chat` | Agent chat |
| `POST /api/agent/sessions/:id/stop` | `POST /api/clones/:name/sessions/:id/stop` | Agent stop |
| `GET /api/workspaces/:id/chat/sessions` | `GET /api/clones/workspace/sessions` | Workspace sessions list |
| `POST /api/workspaces/:id/chat/sessions` | `POST /api/clones/workspace/sessions` | Create workspace session |
| `POST /api/global-chat/sessions` | `POST /api/clones/scheduler/sessions` | Global/scheduler chat |

### 8.2 Hook Updates

Update `useChatStream` hook (or equivalent) to:

1. Use new API base paths
2. Pass clone name as parameter
3. Maintain same SSE event parsing (format unchanged)

### 8.3 Page Updates

- **Workspace chat page**: Use `/api/clones/workspace/sessions/...`
- **Scheduler/global chat page**: Use `/api/clones/scheduler/sessions/...`
- **Agent chat page**: Use `/api/clones/:name/sessions/...` (where name is the selected clone)

### 8.4 Constraint

- **Rendering logic MUST NOT change** — same SSE event types, same UI components
- Only API paths change
- ChatPanel component remains identical

## Verification

1. Manual: Workspace page chat — send message, receive streaming response, thinking blocks, tool calls
2. Manual: Scheduler page chat — send message, receive streaming response
3. Manual: Agent page chat — send message, receive streaming response
4. All three pages render identically to pre-refactor behavior
5. `pnpm build` passes for web-app
