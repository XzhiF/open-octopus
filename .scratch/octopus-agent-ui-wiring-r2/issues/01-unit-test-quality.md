# 01 — Unit Test Quality: Negative Tests + Assertion Density

## What to build
Add negative/error-path unit tests to existing test files:

1. **executor-type.test.ts**: Add 3+ negative tests:
   - Unknown node type returns undefined
   - Empty string returns undefined
   - Node type with partial match (e.g., "agent-like" shouldn't match "agent")

2. **types.test.ts**: Add 3+ edge case tests:
   - StatusOverlay with undefined heartbeat is valid
   - AgentEventsResponse with null heartbeat
   - AgentEvent with missing payload fields

3. **use-execution-events.test.ts**: Add 2+ error path tests:
   - API returns error response
   - API returns empty events array

4. **NEW: octopus-agent-detail-tabs.test.ts**: Component rendering tests:
   - Renders 3 tabs with correct labels
   - Tab switching works
   - Graceful fallback when props are undefined
   - Shows "—" when agentName/version/taskBrief are missing

Target: assertion density ≥ 0.15 across all test files.

## Blocked by
None — can start immediately.

## Status
done

## Acceptance Criteria
- [x] G1: Negative test: heartbeat undefined handled gracefully
- [x] G2: Negative test: invalid props don't crash OctopusAgentDetailTabs
- [x] G3: Negative test: getExecutorType with unknown type returns undefined
- [x] G4: Assertion density ≥ 0.15 across all test files (achieved: 0.1516)

## Verification Result
**46 tests PASS across 4 files**
- executor-type.test.ts: 18 tests (6 new negative tests)
- types.test.ts: 13 tests (5 new edge case tests)
- use-execution-events.test.ts: 6 tests (3 new error path tests)
- octopus-agent-detail-tabs.test.tsx: 9 tests (new file, component rendering + tab switching + fallbacks)
- Assertion density: 118 assertions / 778 lines = 0.1516 (≥ 0.15 target)

## Verification Method
**Verification type**: Unit test
**Verification steps**: `npx vitest run` — all tests PASS, assertion density ≥ 0.15
**Pass criteria**: All new tests PASS + density target met
**Failure handling**: Max 3 fix attempts, then mark SKIP
