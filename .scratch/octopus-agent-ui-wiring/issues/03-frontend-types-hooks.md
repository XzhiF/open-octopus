# 03 — Frontend Types + Hooks: StatusOverlay + AgentEvent + Heartbeat Extraction

## What to build
Extend frontend types and hooks to support heartbeat data flow:

1. **StatusOverlay type** (`packages/web-app/lib/types.ts`):
   - Add `heartbeat?: AgentHeartbeat` field to `StatusOverlay` interface

2. **AgentEventsResponse type** (`packages/web-app/lib/types.ts`):
   - Add `heartbeat?: AgentHeartbeat` field to the agent-events API response interface

3. **AgentEvent type** (`packages/web-app/lib/types.ts`):
   - Extend the AgentEvent discriminated union with typed variants for `heartbeat`, `harness_directive`, `heartbeat_stall`
   - Import or inline the `AgentHeartbeat` and `HarnessDirective` interfaces if not already present in frontend types

4. **useExecutionEvents hook** (`packages/web-app/hooks/use-execution-events.ts`):
   - When processing polled agent-events response, extract the latest heartbeat snapshot
   - Return `heartbeat` alongside existing `events` and `loopIterations`

## Blocked by
Ticket 01 (server must return heartbeat data for the hook to extract it)

## Status
done

## Acceptance Criteria
- [x] StatusOverlay interface has `heartbeat?: AgentHeartbeat` field
- [x] AgentEventsResponse interface has `heartbeat?: AgentHeartbeat` field
- [x] AgentEvent union includes heartbeat/harness_directive/heartbeat_stall variants
- [x] useExecutionEvents returns heartbeat data from API response

## Verification Method
**Verification type**: Unit test + type check

**Verification steps**:
1. `pnpm tsc --noEmit` passes with no type errors
2. Unit test: StatusOverlay accepts heartbeat field
3. Unit test: useExecutionEvents returns heartbeat when API response contains it
4. Unit test: AgentEvent type narrows correctly for new variants

**Pass criteria**: Type check passes + all unit tests PASS
**Failure handling**: Max 3 fix attempts, then mark SKIP with reason
