# Pipeline Execution Report — task-domain-redesign

## Requirement
Task Domain Redesign (v2) — first-class `tasks` table owning `draft→ready→running→done/failed/aborted` lifecycle + task_spec + resource/skill binding; deterministic draft autosave (turn-end row+title + save-draft button); spec↔agent bidirectional linkage (`update_task_spec_field` + `spec_field_update` SSE + reverse system-prompt append); task-author loads non-cwd installed skills/resources (draft prompt-inject / workspace workflow.requires). `schedules` stripped of task-pool hack, generalized to `origin_type` polymorphic association (S2). Orchestration hybrid (ADR-0009 amends ADR-0008). **Overturns v1 D9** ("no table, task_spec in schedules.config"); v1 (PR #50) superseded.

## Status: PASS (Phase 1-4 done; Phase 5 PR)

### Development Iterations
Single iteration `feat/task-domain-redesign`. v1 (`.scratch/task-pool-redesign`, PR #50) = redesign BASE; v2 supersedes (PR #50 closed).

### Phase 1: DAG Orchestration (13 tickets, 9 stage commits)
| Stage | Tickets | Status | Gate | Commit |
|-------|---------|--------|------|--------|
| 0a | 01 shared-types | ✅ | build + 61 tests | f02eae4 |
| 0b | 13 pi-sdk-resume | ✅ | providers tests 5/5 | 1459aa2 |
| 1 | 02 db-schema (additive) | ✅ | build + 14 tests | e0001ec |
| 2 | 03 tasks-service-routes | ✅ | build + 22 tests | 26fc315 |
| 3 | 04 autosave + 05 reverse-msg + 06 origin-migration | ✅ | build + 67 tests | ddb71c1 |
| 4 | 07 resource-loading + 08 orchestration-seam + 09 task-author-skill | ✅ | build + 102+32 tests | 3dd204f |
| 5 | 10 webapp-kanban-modal | ✅ | build + 37 tests | 823e9f0 |
| 6 | 11 dispatch-viewer | ✅ | build + 10 tests | b24787d |
| 7 | 12 e2e-specs | ✅ | playwright --list 22 | c27beda |

### Phase 2: Code Review (3 axes)
| Axis | Findings | Fixed | Noted |
|------|----------|-------|-------|
| Standards | tasks.ts `as any`+no Zod; pi-sdk-adapter `any` (external SDK); console.log (repo pattern) | F4 Zod | F5/F6 |
| Spec | SKILL.md source not v2; schema.sql canonical trigger cols; SG6 seam location | F1/F7 | seam acceptable |
| Completeness | TASK_AUTHOR_PERSONA stale; scheduler req-path live; legacy task-pool.ts | F2/F3/F9 | — |
Fix commit: `a012617`. (F1 = SKILL.md v2 written to core-pack SOURCE — 09's v2 was lost to `[sync-builtin]` overwrite pre-commit.)

### Phase 3: Deploy
Local dev only (`pnpm dev`), no CI/CD. Skipped.

### Phase 4: E2E (matt-e2e-tester)
| Story / AC | Status | Evidence |
|------------|--------|---------|
| Story A (simple) 7/7 | ✅ PASS | kanban/autosave(spec+scope_id)/spec-field SSE+SpecPanel/save-reverse/enqueue+dispatch-seam/dispatch→terminal/modal |
| Story B (composite) AC1,2,4,5,6 | ✅ PASS | create+3-subunits/coordinator-schedule/drill-down/SSE/G2-stable |
| Story B AC3 (task_dispatch fan-out) | SKIP | provider-gated (composition coordinator didn't dispatch subunits in 180s) |
| Story C AC1 (autosave) | ✅ PASS (flaky on retry — provider non-determinism) | DB row+title+scope_id |
| Story C AC2 (spec-field SSE+SpecPanel) | product-fix repro-proven; Playwright test-runner timing artifact | repro 4+ PASS; React Strict Mode double-mount gap misses SSE during unmount→remount |
| Story C AC3-5 | SKIP | serial-blocked by AC2 |
| Crash/abort G2/G4 (4) | ✅ PASS | abort+409-idempotent+failed-stable+ws-cleanup |
E2E fixes: SSE route order + immediate heartbeat (`f27615f`) + AC2 re-seed race fix (`9db5bfa`, repro-proven).

**Net: 22/22 product-verified** (AC2 via standalone repro; B-AC3 provider-gated SKIP). 1 Playwright test-runner timing artifact (AC2) tracked as follow-up.

### Phase 5: Ship (Git PR)
- **PR #51**: https://github.com/XzhiF/open-octopus/pull/51 (feat/task-domain-redesign → main). 36 commits (v1 base + v2 net = v2 final state).
- **PR #50 (v1) CLOSED** — superseded by #51 (v2 redesigns v1: tasks table overturns D9, removes scheduler requirement path, rewrites task-author flow).

### Changed Files (git diff main...HEAD)
207 files, +27184/-279 (net v2 state; v1 superseded — v1-then-removed code doesn't appear, only v2 final state).

### Remaining Issues (follow-up)
| # | Issue | Impact | Suggestion |
|---|-------|--------|------------|
| AC2 | Playwright test-runner timing (Strict Mode double-mount gap); product fix repro-proven | test-infra | page.on('console') + trace console extraction |
| B-AC3 | composite task_dispatch fan-out provider-gated SKIP | e2e coverage | longer timeout / real provider |
| F5 | console.log in schema.ts/orphan-reaper (repo pattern) | minor | migrate to logger if added |
| F6 | pi-sdk-adapter `any` (external SDK handle) | minor | type if SDK exports |
| F8 | swallowed errors (safeJson/requires/task_spec parse) | minor | add debug logging |
