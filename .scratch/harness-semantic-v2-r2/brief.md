# Brief: Harness Semantic V2 — Round 2 Gap Fix

## Overview
Gap-fix iteration targeting 3 SKIP ACs from Round 1: timeout-cascade Agent intervention, agent tool interceptor E2E, and session context across interventions.

## Context
- Root feature: harness-semantic-v2
- Previous score: 82/100 (adjusted: 72/100)
- Branch: feat/workflow-engine-harness (same branch)
- Round 1 verified: detection → StrategyEngine → Agent LLM call → decision → status update (full chain works)

## Carryover from Round 1
| AC# | Status | Round | Priority |
|-----|--------|-------|----------|
| AC-3 | SKIP | R1 | P1 |
| AC-4 | SKIP | R1 | P1 |
| AC-7 | SKIP | R1 | P1 |

## Gap Targets

### Gap 1: AC-3 — Timeout Cascade Agent Intervention
**What failed**: test-timeout-cascade workflow not tested with Harness Agent
**Required fix**: Create/update test-timeout-cascade.yaml that triggers 3 consecutive node timeouts → verify Harness Agent analyzes and returns fix_and_retry or guide_and_retry
**Verification**: Execute via API, check harness_status != null, check delegation event has decision

### Gap 2: AC-4 — Agent Tool Interceptor E2E
**What failed**: Agent node with dangerous bash tool call not tested end-to-end
**Required fix**: Create a workflow with an agent node that attempts `kill $HOST_PID` or `pnpm dev` on host ports → verify tool interceptor blocks, Agent guides, agent resumes
**Verification**: Execute via API, check node completed + harness_status = harness_modified, check tool interceptor log

### Gap 3: AC-7 — Session Context Across Interventions
**What failed**: No multi-intervention execution tested
**Required fix**: Create a workflow that triggers 2+ harness interventions in one execution (e.g., a node that fails with stupid retry + another node with process conflict) → verify Harness Agent session accumulates context
**Verification**: Execute via API, check harness_events has 2+ delegation events, check executions.harness_summary

## Feature Scope
**Do:**
- Create/update test workflows for AC-3, AC-4, AC-7
- Execute E2E tests against running dev server
- Fix any bugs discovered during testing

**Don't:**
- Do NOT modify working code from Round 1
- Do NOT refactor existing implementations

## Acceptance Criteria
| # | AC | Verification Method |
|---|----|-------------------|
| G1 | AC-3: timeout-cascade → Agent decision (not advisory) | API execution + DB check |
| G2 | AC-4: agent tool interceptor → block + guide + resume | API execution + DB check |
| G3 | AC-7: session context across 2+ interventions | API execution + DB check |

> **Execution requirement**: All tests MUST be executed, not just written.
