# Brief: octopus-agent-ui-wiring R2 — Test Quality + Screenshot Evidence

## Overview
Gap-fix iteration targeting test authenticity and E2E evidence quality. The implementation code is correct; the gap is entirely in test quality.

## Context
- Root feature: octopus-agent-ui-wiring
- Previous iteration: octopus-agent-ui-wiring
- Previous score: 63.86/100 (NO-GO)
- Branch: feat/agent-workflow-integration

## Gap Targets

### Gap 1: Test Authenticity Score (44/100 → ≥70)
**What failed**: Assertion density 0.070 (threshold 0.30), zero negative/error-path tests
**Required fix**:
- Add negative tests: what happens when heartbeat is undefined, when agent-events API returns no heartbeat, when node type is not octopus_agent
- Add error-path tests: what happens when OctopusAgentDetailTabs receives invalid props
- Increase assertion density in unit tests (add more specific value assertions, not just toBeDefined)

### Gap 2: E2E Screenshot Evidence
**What failed**: 3 screenshots are byte-identical (94,966 bytes each), suggesting they captured the same empty/default state
**Required fix**:
- Ensure screenshots capture distinct UI states (before/during/after execution)
- Add wait conditions before screenshots to ensure content is rendered
- If execution fails (no AI key), capture meaningful error state screenshots instead

### Gap 3: E2E Conditional Assertions
**What failed**: Tests 1, 3, 4 use conditional assertions that silently pass when UI elements are missing
**Required fix**:
- Convert conditional assertions to hard assertions where possible
- At minimum, add explicit "element exists" assertions that fail if the component isn't rendered

## Feature Scope
**Do:**
- Add 5+ negative/error-path unit tests
- Fix E2E screenshots to capture distinct states
- Strengthen E2E assertions from conditional to hard where possible
- Restore documentation files if externally reverted

**Don't:**
- Do NOT modify server implementation code
- Do NOT modify frontend component logic
- Do NOT add new features

## Acceptance Criteria
| # | AC | Verification Method |
|---|-----|-------------------|
| G1 | Negative test: heartbeat undefined handled gracefully | Unit test PASS |
| G2 | Negative test: invalid props don't crash OctopusAgentDetailTabs | Unit test PASS |
| G3 | Negative test: getExecutorType with unknown type returns undefined | Unit test PASS |
| G4 | Assertion density ≥ 0.15 across all test files | Verification report |
| G5 | E2E screenshots are distinct (different byte sizes) | File size comparison |
| G6 | Test authenticity score ≥ 70 | Verification report |

> **Execution requirement**: All tests MUST be executed, not just written.
