# Brief: octopus-agent-ui-wiring R3 — Assertion Authenticity + Mock Integration

## Overview
Gap-fix iteration targeting the remaining test quality gaps: tautological assertions, negative test ratio, and AC-1/AC-2 runtime verification via mock.

## Context
- Root feature: octopus-agent-ui-wiring
- Previous score: 71.9/100 (REVIEW), up from 63.86
- Branch: feat/agent-workflow-integration

## Gap Targets

### Gap 1: Replace Tautological Assertions (17 instances)
**What failed**: `octopus-agent-detail-tabs.test.tsx` has 17 `toBeDefined()` calls that always pass
**Required fix**: Replace with `.toBeVisible()` or `.toHaveText()` for meaningful assertions
**Target**: Zero tautological assertions

### Gap 2: Negative Test Ratio (17.9% → ≥20%)
**What failed**: Need 2 more negative tests to reach 20% threshold
**Required fix**: Add 2 negative tests to any test file (e.g., OctopusAgentDetailTabs with invalid executionId, useExecutionEvents with malformed API response)

### Gap 3: AC-1/AC-2 Mock Integration Test
**What failed**: Runtime heartbeat verification blocked by missing AI key
**Required fix**: Create a mock integration test that:
1. Directly inserts a heartbeat event into agent_events table
2. Calls the agent-events API endpoint
3. Verifies heartbeat field is returned in response
4. This proves the full pipeline works without needing actual AI execution

## Feature Scope
**Do:** Fix tautological assertions, add negative tests, create mock heartbeat integration test
**Don't:** Modify implementation code, add new features

## Acceptance Criteria
| # | AC | Verification Method |
|---|-----|-------------------|
| H1 | Zero tautological assertions in detail-tabs test | Static analysis |
| H2 | Negative test ratio ≥ 20% | Static analysis |
| H3 | Mock integration test proves AC-1 + AC-2 | Integration test PASS |
| H4 | Confidence score ≥ 85 | Verification report |

> **Execution requirement**: All tests MUST be executed, not just written.
