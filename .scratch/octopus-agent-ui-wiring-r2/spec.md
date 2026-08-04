# Spec: octopus-agent-ui-wiring R2 — Test Quality

## Problem Statement
R1 verification report scored 63.86/100 (NO-GO) due to test authenticity issues: low assertion density (0.070), zero negative tests, unreliable E2E screenshots, and conditional assertions that silently pass.

## Solution
1. Add negative/error-path unit tests to increase assertion density
2. Fix E2E screenshots to capture distinct UI states
3. Strengthen conditional E2E assertions
4. Restore documentation files

## Feature Scope
**Do:** Add negative tests, fix screenshots, strengthen assertions, restore docs
**Don't:** Modify implementation code, add new features

## Key Decisions
| # | Decision | Conclusion | Reason |
|---|---------|-----------|--------|
| D1 | Scope | Test quality only | Implementation is correct |
| D2 | Negative test strategy | Edge cases + error paths | Increase assertion density to ≥0.15 |
| D3 | Screenshot fix | Distinct state captures | Before/during/after or error states |

## User Stories
1. As a QA, I want negative tests for heartbeat handling, so that edge cases are covered
2. As a QA, I want distinct E2E screenshots, so that verification evidence is reliable
3. As a QA, I want hard assertions in E2E tests, so that failures are detected

## Implementation Decisions

### New test files / modifications:
| File | Changes |
|------|---------|
| `executor-type.test.ts` | Add negative tests (unknown types, empty strings) |
| `types.test.ts` | Add edge case tests (undefined heartbeat, null values) |
| `use-execution-events.test.ts` | Add error path tests (API failure, missing data) |
| `octopus-agent-node.spec.ts` | Fix screenshots + strengthen assertions |
| `octopus-agent-detail-tabs.tsx` (test) | Add new test file for component rendering |

## Verification Strategy
### AC to Verification Method Mapping
| AC | Verification Level | Method |
|----|-------------------|--------|
| G1-G3 | Unit | vitest run, all PASS |
| G4 | Static | Assertion density calculation |
| G5 | Static | File size comparison |
| G6 | Static | Verification report score |
