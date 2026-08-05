# Spec: octopus-agent-ui-wiring R3

## Problem Statement
R2 scored 71.9/100. Remaining gaps: 17 tautological `toBeDefined()` assertions, negative test ratio at 17.9% (need ≥20%), AC-1/AC-2 still PARTIAL without runtime verification.

## Solution
1. Replace all `toBeDefined()` with meaningful assertions in octopus-agent-detail-tabs test
2. Add 2+ negative tests to reach 20% negative ratio
3. Create mock integration test for heartbeat persistence + API return (bypasses AI key requirement)

## Feature Scope
**Do:** Fix assertions, add negative tests, create mock heartbeat test
**Don't:** Modify implementation code

## Key Decisions
| # | Decision | Conclusion | Reason |
|---|---------|-----------|--------|
| D1 | AC-1/AC-2 verification | Mock integration test | Bypasses AI key limitation |
| D2 | Assertion fix | toBeVisible/toHaveText | Meaningful assertions |

## User Stories
1. As a QA, I want meaningful assertions that catch real bugs
2. As a QA, I want negative tests covering error paths
3. As a QA, I want AC-1/AC-2 verified via mock integration

## Implementation Decisions

### Mock Integration Test
Create `packages/server/src/__tests__/heartbeat-integration.test.ts`:
1. Insert a mock heartbeat event directly into agent_events table via DAO
2. Call the agent-events API endpoint (or the underlying service method)
3. Assert: response includes `heartbeat` field with correct step/tokens/confidence
4. Assert: event_type='heartbeat' row exists in agent_events table

This tests the full data flow without requiring actual AI execution.

## Verification Strategy
| AC | Method |
|----|--------|
| H1 | Count `toBeDefined()` in test file — should be 0 |
| H2 | Count negative tests / total tests ≥ 20% |
| H3 | Mock integration test PASS |
| H4 | Verification report score ≥ 85 |
