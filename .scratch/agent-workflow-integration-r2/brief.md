# Requirement Brief — agent-workflow-integration Iteration 2

## Overview
Gap-fix iteration for agent-workflow-integration. Targets ONLY the gaps identified in R1 verification report.

## Context
- Root feature: agent-workflow-integration
- Previous iteration: R1 (score 79/100, REVIEW)
- Branch: feat/agent-workflow-integration (same branch)
- PR: https://github.com/XzhiF/open-octopus/pull/44

## Carryover from R1
| Gap | Status | Priority |
|-----|--------|----------|
| Browser E2E not executed | NOT EXECUTED | P1 |
| Server test assertion density | LOW (0.136) | P1 |

## Gap Targets

### Gap 1: Browser E2E — Versions Tab
**What failed**: Frontend components (CloneVersionsTab, VersionList, PublishVersionDialog, VersionDiff, OctopusAgentNode) compile but have zero browser-level test coverage.
**Required fix**: Playwright tests for:
- Clone detail page renders Versions Tab
- Version list displays correctly with stage/status badges
- Publish dialog opens, submits, and refreshes list
- Version diff shows differences between two versions
- Rollback confirmation dialog works
- OctopusAgentNode renders in workflow viewer with correct icon/color

### Gap 2: Server Test Assertion Density
**What failed**: heartbeat-sse.test.ts (density 0.043), harness-intervene.test.ts (0.084), heartbeat.test.ts (0.070) have too few value assertions.
**Required fix**:
- heartbeat-sse.test.ts: Assert specific fields in emitted SSE event data (execution_id, node_id, agent_name, version, step, tokens_used)
- harness-intervene.test.ts: Assert response body fields, verify execution state change in DB mock
- heartbeat.test.ts: Assert specific heartbeat payload values, not just event emission count

## Feature Scope
**Do:**
- Add Playwright E2E tests for Versions Tab UI
- Increase assertion density in 3 server test files
- Run all tests to verify no regressions

**Don't:**
- Do NOT modify any implementation code
- Do NOT add new features
- Do NOT refactor existing tests (only enhance assertions)

## Verification Strategy
- Environment: `pnpm dev --isolated` (server:3001, web:3000)
- Playwright tests in `packages/web-app/e2e/`
- Server tests enhanced in-place

> **Execution requirement**: All tests MUST be executed, not just written.
> Tests written but not executed = 0% credit.
