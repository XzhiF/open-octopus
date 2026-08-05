# Requirement Brief — resource-module-enhancement Iteration 2

## Overview
Gap-fix iteration for resource-module-enhancement. This iteration targets ONLY the verification gaps identified in the round 1 verification report.

## Context
- Root feature: resource-module-enhancement
- Previous iteration: resource-module-enhancement
- Previous score: 81/100
- Previous decision: REVIEW
- Branch: feat/resource-module-enhancement (same branch)

## Gap Targets

### Gap 1: Browser E2E for Web UI (P0 — score blocker)
**What failed**: AC-14 through AC-17 were skipped — no browser E2E tests were written or executed.
**Why it matters**: Web UI interactions (type filters, activate/deactivate buttons, activated badge, uninstall guard, backup dialog) are unverified. 4 ACs at 0% drag requirements coverage from 81 to 63.
**Required fix**:
- Write Playwright E2E tests for resource page covering:
  - AC-14: Type filter buttons include rule/command/clone
  - AC-15: Activate button visible on inactive resources, click triggers activation
  - AC-15: Deactivate button visible on activated resources, click triggers deactivation
  - AC-16: Uninstall button shows "Deactivate first" tooltip when resource is activated
  - AC-17: Clone uninstall shows backup confirmation dialog with Yes/No
- Tests should go in `packages/web-app/e2e/tests/resource-enhancement.spec.ts`

### Gap 2: Clone Git Source Lifecycle (P1)
**What failed**: AC-6, AC-7, AC-9, AC-10, AC-13 were skipped — no git test fixture for clone source discovery and install.
**Why it matters**: The clone resource type's full lifecycle (source discover → install → activate → backup uninstall) is untested end-to-end.
**Required fix**:
- Create a local test git repo fixture with clone definitions:
  ```
  test-clone-repo/
  └── clones/
      └── test-reviewer/
          ├── persona.md
          └── config.json
  ```
- Write integration test that:
  - AC-13: Source discovery detects clones in git repo
  - AC-6: Install clone from git source
  - AC-7: Activate clone (verify files copied to ~/.octopus/agent/clones/)
  - AC-9: Uninstall with keepBackup=true → backup created
  - AC-10: Uninstall with keepBackup=false → clean removal
- Tests should go in `packages/shared/src/__tests__/resource-clone-lifecycle.test.ts`

## Feature Scope
**Do:**
- Write Playwright E2E tests for Web UI AC-14-17
- Write clone lifecycle integration tests for AC-6,7,9,10,13
- Ensure all tests pass

**Don't:**
- Do NOT modify any production code from iteration 1
- Do NOT add new features beyond test coverage
- Do NOT refactor existing implementation

## Key Decisions
| # | Decision | Conclusion | Reason |
|---|---------|-----------|--------|
| D1 | Scope | Test-only gap fix | Minimize regression risk |
| D2 | Clone fixture | Local git repo (not remote) | No external dependencies for tests |
| D3 | E2E framework | Playwright (existing) | Consistent with existing e2e infrastructure |

## Acceptance Criteria
| # | User Story | AC | Verification Method |
|---|-----------|----|-------------------|
| G1 | Web UI type filters | AC-14: filter buttons include rule/command/clone | Playwright: click each filter, verify card list updates |
| G2 | Web UI activate/deactivate | AC-15: activate button triggers activation, badge appears | Playwright: click activate → badge visible |
| G3 | Web UI uninstall guard | AC-16: uninstall blocked when activated | Playwright: verify tooltip/disabled state |
| G4 | Web UI backup dialog | AC-17: clone uninstall shows backup dialog | Playwright: click uninstall → dialog appears with checkbox |
| G5 | Clone source discovery | AC-13: discovers clones in git repo | Integration: source analyze → clone listed |
| G6 | Clone install from git | AC-6: install clone from git source | Integration: install → registry entry |
| G7 | Clone activate | AC-7: activate clone copies to agent dir | Integration: activate → directory exists |
| G8 | Clone uninstall backup | AC-9: uninstall with backup | Integration: uninstall keepBackup=true → backup exists |
| G9 | Clone uninstall clean | AC-10: uninstall without backup | Integration: uninstall keepBackup=false → no backup |

## Verification Strategy
### Global Config
- Environment: local dev (server:3001, web:3000)
- Test user: default org
- Data prefix: `E2E_TEST_`

### Per-layer Methods
#### Integration Tests
- Clone lifecycle: `packages/shared/src/__tests__/resource-clone-lifecycle.test.ts`
- Uses local git repo fixture (git init + commit in temp dir)

#### Browser E2E
- Web UI: `packages/web-app/e2e/tests/resource-enhancement.spec.ts`
- Playwright automation for filter/activate/deactivate/uninstall flows

### Prerequisites
- [ ] Server running on localhost:3001
- [ ] Web app running on localhost:3000
- [ ] Playwright installed and configured

### Previous Iteration Evidence
Verification report: `.scratch/resource-module-enhancement/verification-report.md`
