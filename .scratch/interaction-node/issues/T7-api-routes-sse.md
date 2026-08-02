# T7: Server API Routes + SSE Events

## Status: done

## Scope
Add interaction-specific API routes and SSE events:

1. **Interaction routes** (new file or extend execution routes):
   - `POST /api/executions/:id/interaction/:nodeId/start` → starts interaction, returns `{ sessionId }`
   - `GET /api/executions/:id/interaction/:nodeId/status` → returns `{ status, rounds, sessionId }`
   - `POST /api/executions/:id/interaction/:nodeId/complete` → force complete with `{ summary, vars_update }`

2. **SSE events** (extend existing execution SSE):
   - `execution_interaction_started` — payload: `{ sessionId, display, nodeId }`
   - `execution_interaction_completed` — payload: `{ summary, vars_update, nodeId }`

3. **Execution service integration**:
   - When engine returns `pending_interaction`, emit SSE event and create interaction session via Chat Bridge
   - When interaction completes (via bridge callback), resume engine execution

## Files
- Create: `packages/server/src/routes/interaction.ts` (or extend existing)
- Modify: `packages/server/src/services/execution.ts` (handle pending_interaction)
- Modify: `packages/server/src/routes/events.ts` or SSE service

## Dependencies
- T6 (Chat Bridge)

## Verification Method
- API routes respond correctly
- SSE events emitted on interaction start/complete
- `pnpm build` passes
