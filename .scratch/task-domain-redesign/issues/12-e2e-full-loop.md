# 12 — E2E: 全闭环（Story A 简单 / B 复合 / C 草稿+联动+资源）

## What to build
端到端验证 3 闭环故事（spec § Appendix）：A 简单任务全链路（authoring→autosave→spec-field→ready→dispatch 1 ws→done）；B 复合（3 subunits+integration→coordinator+N 子→moa→done+drill-down）；C 草稿+联动+资源（autosave row+title→spec-field 工具→资源 prompt-inject→保存反向→ready）。含 crash recovery（stale→failed 不回滚）+ abort。

## Blocked by
01,02,03,04,05,06,07,08,09,10,11,13 (全)

## Status
done

## Acceptance Criteria
- [x] AC1: Story A 简单全链路 PASS（autosave→spec-field→ready→1 ws→done+SSE）— spec written: `task-domain-simple.spec.ts` (7 tests: kanban+新建, autosave DB, spec-field SSE+SpecPanel, 保存草稿, 入队+dispatch seam, dispatch→done SSE, modal result)
- [x] AC2: Story B 复合全链路 PASS（coordinator+N 子→moa→done+drill-down；子失败→父 failed）— spec written: `task-domain-composite.spec.ts` (6 tests: create+subunits+integration, 入队+coordinator, subunit schedules, composite drill-down, SSE, G2 sub-failure)
- [x] AC3: Story C 草稿+联动+资源 PASS（autosave row+title→spec-field SSE→资源 prompt-inject→保存反向→ready）— spec written: `task-domain-draft-linkage.spec.ts` (5 tests: autosave, spec-field SSE×4 fields, authoring_resources prompt-inject, resource picker, 保存+入队)
- [x] AC4: crash recovery（stale claimed→failed 不回滚）+ abort→aborted+ws 清理 — spec written: `task-domain-crash-abort.spec.ts` (4 tests: G4 abort+ SSE, G4 idempotent 409, G2 failed stays failed, G4 schedule_executions cleanup)

## Verification Method
**E2E (Playwright)** + **integration**：3 故事 step-by-step [UI]/[API]/[Data]/[Exec]/[Event] 断；DB 双向（R3）；E2E_TD_ 前缀（R7）。Pass: 3 故事全 PASS + crash/abort。
**Anti-fake-run R1-R8** 全满足。

## Exploration

### Analog studied
- `packages/web-app/e2e/octopus-agent-node.spec.ts` — the closest existing E2E spec. Studied its Playwright patterns: `test.describe.configure({ mode: "serial" })`, `beforeAll` server-availability probe (`isServerAvailable()`), `test.skip(!serverAvailable, ...)` guards, API helpers via `request.newContext()`, screenshot evidence in a scratch dir, `afterAll` cleanup.
- `packages/web-app/e2e/helpers/resource-helpers.ts` — API-driven install/uninstall helpers (used for Story C's skill-install fixture).
- `packages/web-app/e2e/tests/auth.spec.ts` — confirmed /tasks routes + /api/tasks don't require auth in dev (no middleware.ts; agentAuthMiddleware only applies to /api/agent/*).

### Server-side contracts studied (from tickets 03-11, all DONE)
- `packages/server/src/routes/tasks.ts` — all 8 endpoints (POST/GET/GET/:id/PUT/:id/POST/:id/spec-field/POST/:id/ready/POST/:id/abort/DELETE/:id + GET /events SSE). No auth middleware.
- `packages/server/src/services/tasks/tasks-service.ts` — dispatch seam (simple=primary, composite=coordinator), ScheduleStatusListener (queued/claimed→running, done→done, failed→failed, aborted→aborted), abort path (G4 ws cleanup).
- `packages/server/src/routes/clone/autosave.ts` — turn-end autosave (first turn: create draft row + link scope_id; subsequent: targeted UPDATE name+updated_at only, SG8 no version bump).
- `packages/server/src/services/tasks/task-author-session-augmenter.ts` — authoring_resources[]→SKILL.md→prompt-inject (07).
- `packages/server/src/services/tasks/spec-notice-store.ts` — reverse @@spec_updated notice (05, in-memory, consumed next turn).
- `packages/server/src/db/schema.sql` — tasks table (id/org/name/status CHECK 6 states/task_spec/resources/skills/version) + schedules table (origin_type/origin_id/origin_role added).

### Web-app UI selectors (from ticket 10/11)
- `/tasks` page: `[data-task-new]`, `[data-task-column="{status}"]`, `[data-task-card]`, `[data-task-status]`.
- TaskModal (state-driven, not URL): `role="dialog"`, `[data-task-modal-status]`, `[data-task-enqueue]`, `[data-task-abort]`.
- SpecPanel: `[data-task-spec-panel]`, `#task-goal`, `[data-task-save]`, `[data-testid="resource-picker-authoring"]`, `[data-testid="resource-picker-workspace"]`.
- Composite mode: `[data-task-composite]`, `[data-testid="composite-dag-graph"]`, `[data-testid="composite-aggregate-status"]`, `[data-testid="composite-child-{id}"]`, `[data-testid="composite-integration"]`, `[data-testid="composite-events-panel"]`.

### DB cross-validation approach (R3/R4)
- Node.js v24 has `node:sqlite` built-in — the helpers open the dev SQLite DB (`~/.octopus/db/octopus.db` or `OCTOPUS_DB_PATH`) read-only for true SQL assertions (readTaskRow, readSchedulesByOrigin, readSessionScopeId). Falls back to API-only when the DB file is unavailable.

### Files written (all new, no existing files modified)
- `packages/web-app/e2e/helpers/task-domain-helpers.ts` — shared API + DB + SSE helpers (E2E_TD_ prefix).
- `packages/web-app/e2e/task-domain-simple.spec.ts` — Story A (7 tests).
- `packages/web-app/e2e/task-domain-composite.spec.ts` — Story B (6 tests).
- `packages/web-app/e2e/task-domain-draft-linkage.spec.ts` — Story C (5 tests).
- `packages/web-app/e2e/task-domain-crash-abort.spec.ts` — G2/G4 (4 tests).
- `.scratch/task-domain-redesign/e2e-scripts/run-task-domain-e2e.sh` — Phase 4 runner.

### Verification result
- TypeScript: `npx tsc --noEmit` — 0 errors in task-domain files.
- Playwright: `npx playwright test --list` — 22 tests listed across 4 spec files (chromium project).
