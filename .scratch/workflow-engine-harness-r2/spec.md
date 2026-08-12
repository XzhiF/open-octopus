# Spec: WorkflowEngine Harness — R2 Gap Fix

## Overview
Gap-fix iteration for workflow-engine-harness. Targets E2E browser tests and code review fixes.

## Context
- Root feature: workflow-engine-harness
- Previous score: PENDING (E2E not executed)
- Branch: feat/workflow-engine-harness
- PR: https://github.com/XzhiF/open-octopus/pull/45

## Gap Targets

### Gap 1: E2E Browser Tests (P0 — blocks convergence)
**What failed**: Playwright browser E2E tests were not written or executed
**Required**: 
- Floating panel visibility + interaction (collapse/expand/drag)
- Chatbot send intervention via harness-intervene API
- DAG node harness markers (🛡️ icons)
- LogViewer harness filter toggle

### Gap 2: Code Review Should-Fix Items (P1)
**What failed**: 6 should-fix items from code review
**Required**:
- ExecutionLifecycle autoResume cleanup (call onExecutionEnd)
- ExecutionLifecycle runInteractionCompleteInBackground cleanup
- Python process-isolation wrapper (or document why not needed)
- Distinguish harness delegate vs user pause in SSE

### Gap 3: Integration E2E against real dev server (P1)
**What failed**: Test workflows were only run as unit tests, not against a real dev server
**Required**:
- Start dev server
- Run harness-test-stupid-retry workflow via API
- Verify harness_events in DB
- Verify SSE events received by client

## Feature Scope
**Do:**
- Write and execute Playwright browser tests
- Fix code review should-fix items
- Run integration tests against dev server

**Don't:**
- Do NOT modify working code from Round 1
- Do NOT add new features

## Acceptance Criteria

| # | AC | Verification Method |
|---|----|-------------------|
| G1 | Playwright test: floating panel visible during execution | Browser E2E |
| G2 | Playwright test: chatbot sends intervention | Browser E2E |
| G3 | Playwright test: DAG node shows 🛡️ marker | Browser E2E |
| G4 | ExecutionLifecycle cleanup in all paths | Unit test |
| G5 | Integration test: real server + test workflow | Integration test |

## Verification Strategy
- Environment: local dev `pnpm dev --isolated`
- Browser E2E: Playwright against http://localhost:3000
- API: curl against http://localhost:3001
