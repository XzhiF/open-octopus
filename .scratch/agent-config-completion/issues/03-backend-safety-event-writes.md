# Issue 3: Backend — Wire safety event writes (B5)

**Status:** done
**Priority:** high
**Depends on:** none
**Files:**
- `packages/server/src/routes/agent/safe-mode.ts`
- `packages/server/src/routes/agent/chat-routes.ts`

## Problem

`SafetyDAO.insertSafetyEvent()` exists but has zero callers. Safety events are never recorded, making the SafetyAudit panel always empty.

## Acceptance Criteria

1. `POST /safe-mode/enable` writes a safety event: `{ type: 'safe_mode_toggle', operation: 'Enable safe mode', decision: 'intercept', actor: 'system' }`
2. `POST /safe-mode/disable` writes a safety event: `{ type: 'safe_mode_toggle', operation: 'Disable safe mode', decision: 'intercept', actor: 'system' }`
3. `safe-mode.ts` deps include `safetyDAO` (add to `createSafeModeRoutes` params)
4. `chat-routes.ts`: When SSE chat detects a dangerous command pattern in the user message (via `SafetyInterceptor.isDangerousCommand`), write `{ type: 'dangerous_command', operation: <command>, decision: 'intercept', actor: 'user' }`. This is fire-and-forget — must not block streaming.
5. Safety event writes are wrapped in try/catch so failures don't affect the primary operation
6. All writes include `org` and `timestamp` (ISO string)

## Verification Method

```bash
# Enable safe mode, then query events:
curl -X POST -H "Authorization: Bearer agent" http://localhost:3001/api/agent/safe-mode/enable
curl -H "Authorization: Bearer agent" "http://localhost:3001/api/agent/safety/events?limit=5"
# Expect: items array with a safe_mode_toggle event

# Send a dangerous command via chat:
curl -X POST -H "Authorization: Bearer agent" \
  -H "Content-Type: application/json" \
  -d '{"message":"rm -rf /"}' \
  http://localhost:3001/api/agent/sessions/{id}/chat
# Then query events — expect dangerous_command entry
```
