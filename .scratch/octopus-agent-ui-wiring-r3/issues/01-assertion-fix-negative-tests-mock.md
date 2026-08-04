# 01 — Assertion Fix + Negative Tests + Mock Integration

## What to build
Three tasks in one ticket:

### Task 1: Fix Tautological Assertions
File: `packages/web-app/components/node-detail/__tests__/octopus-agent-detail-tabs.test.tsx`

Replace all `toBeDefined()` calls with meaningful assertions:
- `expect(element).toBeDefined()` → `expect(element).toBeVisible()` or `expect(element).toHaveText("...")`
- For tab content, assert specific text content is visible
- For fallback values, assert "—" text is rendered

### Task 2: Add Negative Tests
Add 2+ negative tests:
- OctopusAgentDetailTabs with empty string props → shows fallback
- OctopusAgentDetailTabs with executionId="" → handles gracefully

### Task 3: Mock Heartbeat Integration Test
NEW file: `packages/server/src/__tests__/heartbeat-integration.test.ts`

This test verifies AC-1 and AC-2 without requiring AI execution:
1. Use the DAO to insert a mock heartbeat event into agent_events table
2. Call the extractLatestHeartbeat function (or equivalent)
3. Assert the heartbeat data is correctly extracted
4. Assert the API response includes the heartbeat field

Look at existing server tests for patterns:
- `packages/server/src/__tests__/observability-filterEvent.test.ts` — mock DAO pattern
- The extractLatestHeartbeat function is in `packages/server/src/routes/execution.ts`

## Blocked by
None — can start immediately.

## Status
done

## Acceptance Criteria
- [x] H1: Zero tautological assertions in detail-tabs test
- [x] H2: Negative test ratio ≥ 20%
- [x] H3: Mock integration test proves AC-1 + AC-2

## Verification Method
**Verification type**: Unit + Integration test
**Verification steps**: `npx vitest run` — all tests PASS
**Pass criteria**: All tests PASS + static analysis confirms targets met
**Failure handling**: Max 3 fix attempts
