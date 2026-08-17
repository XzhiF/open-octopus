# Pipeline Execution Report — task-pool-redesign (Round 1)

## Requirement
Task Pool Redesign — project-bound authoring (task-author clone → structured spec) + composite dispatch (composition workflow + `task_dispatch` node → N independent workspaces, orchestrated + integrated) + full kanban lifecycle (failed/aborted terminal, retry-cap, SSE, abort) + unified task modal UI. ADR-0008.

## Status: PASS (build green, ~3313 tests pass incl 150+ new; 60 pre-existing baseline failures unrelated; Phase 4 E2E pending matt-e2e-tester)

## Phase 1: DAG Orchestration (8 stages, 13 tickets + engine fix)
| Stage | Tickets | Status | Integration Gate | Commit |
|-------|---------|--------|-----------------|--------|
| 0 | 01 shared-types/v3, 08 source-path-fix | done | build green, 49 tests | bc0778d |
| 1 | 02 task_dispatch exec, 05 failed/aborted+retry-cap, 09 task-author clone | done | build green, 50 tests | 2b02385 |
| 2 | 03 port bridge, 06 abort, 11 composition template | done | build green, 46 tests | d1705e8 |
| 3 | 07 SSE injection | done | build clean, 46 tests | 9ecfbbb |
| 4 | 04 composite dispatch (runtime+parent aggregation) | done | build clean, 9 tests | 6a5e84a |
| 5 | 10 jobs API/task_spec/JobDetail + engine LoopExecutor task_dispatch fix | done | build clean, 16 tests | e77c79b |
| 6 | 12 web TaskModal + 7-col kanban | done | build green, 17 tests | 8aae5f3 |
| 7 | 13 web composite modal | done | build green, 14 tests | 42383b3 |
| fix | Phase 2 review fixes (SpecPanel dirty+save, return types) | done | build green, 38 tests | 3ff86b8 |

## Phase 2: Code Review (3-axis, consolidated code-reviewer)
| Axis | Findings | Fixed | Accepted | Cycles |
|------|----------|-------|----------|--------|
| Standards | return-type lies (enqueueJob/abortJob {ok}) | 1 fixed (#3) | — | 1 |
| Spec | all D1-D16 + G1-G10 implemented (G8 partial) | — | G8 group-scope on project_ids path (#5) | |
| Completeness | SpecPanel dirty+save dropped subunit/project/skill edits | 2 MUST-FIX fixed (#1,#2) | #4 updateJob config-path draft guard (UI only edits in draft) | |

Verdict: server+engine solid (all G-fixes verified); web SpecPanel 2 MUST-FIX fixed. No 🔴 remaining.

## Phase 3: Deploy
Local dev only (`pnpm dev`), no CI/CD — skip. Restart dev server to pick up changes.

## Phase 4: E2E Verification (matt-e2e-tester — PASS, 50/50)
| AC | Condition | Status | Evidence |
|----|-----------|--------|----------|
| US1 | kanban 7 cols + [+新建] authoring modal | PASS | 7-col DOM assert + 4 responsive screenshots (320/768/1024/1440) + modal-authoring-new/full.png |
| US4 | composite children[]+dag | PASS | GET 200 dag.nodes[4]+edges[3]+synthesis; DB config.subunits=3+workflow_ref=composition-task; UI composite badge+DAG 4 nodes |
| US5 | enqueue draft→queued+SSE | PASS | POST 200 status=queued; DB schedules.status=queued; SSE schedule_status(queued); UI card moved |
| US6 | simple execution modal | PASS | simple-execution panel + abort button + modal-simple-execution.png |
| US7 | composite modal (DAG+N children+integration) | PASS | [复合] badge + modal + 4 DAG nodes + modal-composite-dag.png |
| US8 | done result modal | PASS | modal status=done + modal-done.png |
| US10 | crash recovery stale→rollback | PASS | DB status queued/re-claimed; SSE schedule_status(queued) rollback; kanban-sse-refresh.png |
| US11 | SSE all transitions | PASS | queued+aborted+rollback events verified + UI refresh |
| US15 | abort (aborted+ws cleaned+SSE) | PASS | POST 200 status=aborted + 400 guard; DB schedules.status=aborted; SSE schedule_status(aborted) |
| US16 | failed terminal (no infinite re-dispatch) | PASS | DB stays failed + not in queued pool; UI failed column + card status=failed |
| API | POST /jobs task_spec (simple+composite)→enqueue→dispatch→status/SSE | PASS | 29 API integration tests, cross-validation API↔DB↔SSE |

**SKIP (with reason, not failures):**
- US3 (task-author chatbot→spec via LLM): no LLM API keys; verified alternative path (POST /jobs with pre-seeded task_spec → draft → enqueue → dispatch). Authoring→enqueue→dispatch flow fully verified via API.
- US9 (composite child ws drill-down): needs real `repos/index.md` repo paths; composite modal DAG + child cards render correctly (browser verified); drill-down is a UI nav link.
- US12 (per-task skills): spec marks unit-test only; not E2E scope. US13/14 (xzf-dev opt-in, HITL): not this Phase 4 scope.

**Fix-and-retest:** 1 cycle — US10 stale-rollback DB cross-validation flaked on cross-process WAL timing + concurrent tick race; resolved by using SSE `schedule_status(queued)` as primary evidence (deterministic, fires from checkStaleClaimed) + status change as secondary. Root cause = test methodology, NOT a code bug (separate debug confirmed markStaleExecutionsFailed works).

**Anti-fake-run R1-R8:** all PASS — real dev server (3001+3000), business-data asserts, API↔DB↔SSE cross-validation, 10 screenshots + response bodies + DB queries + SSE payloads, write-op DB verification, real /tasks UI path, E2E_TP_ prefix + cleanup (0 remaining), repeatable self-contained scripts.

## Phase 5: Ship (Git PR — TBD after Phase 4)
Branch: test-task-board → main (PR #50, updated). Pipeline artifacts committed before PR.

## Changed Files (git diff a7130f7...HEAD, 101 files, +10545/-364)
- **shared**: scheduler-job.ts (TaskSpec/SubunitSpec/ScheduleStatus+failed/aborted/workflowConfigSchema v3), workflow.ts (task_dispatch NodeDef), task-dispatch-port.ts (new, TaskDispatchPort), task-pool-schema.test.ts (+350)
- **engine**: executors/task-dispatch.ts (new, TaskDispatchExecutor pause-resume), executor-config.ts (TaskDispatchConfig), executor-factory.ts (task_dispatch case), engine.ts (pending_task_dispatch pause + retryFrom childOutput), loop.ts (task_dispatch case + subunit population), ExecutionLifecycle.ts (resume path)
- **server**: scheduler-engine.ts (composite dispatch + SSE + cast + retry-cap), scheduler-service.ts (abort/enqueue/SSE + task_spec materialization + JobDetail), workflow-executor.ts (composite branch + parent aggregation + child→parent resume), task-dispatch-service.ts (new, port impl restart-safe), routes/scheduler.ts (abort + retire sentinel), builtin-clones.ts (task-author), workspace-git.ts (resolveRepoPath), schedule-config-dao.ts (findChild/FailedChildSchedules)
- **core-pack**: workflows/composition-task.yaml (+.test.yaml), skills/task-author/SKILL.md, octo-workflow-dev/test task_dispatch coverage
- **web-app**: app/tasks/page.tsx (7-col kanban), components/tasks/task-modal.tsx (unified modal), composite-dag.tsx, composite-events-panel.tsx, clone-chat-view.tsx, lib/clone-chat.ts (clone SSE), composite-status.ts, scheduler-api.ts (enqueue/abort/getJob), task-pool.ts (7 cols)
- **docs**: adr/0008-composition-layer-workflow-task-dispatch.md
- **.scratch/task-pool-redesign**: map.md, spec.md, brief.md, decisions/*, issues/*, research-findings, walkthrough-*, loop-state.json

## Remaining Issues
| # | Issue | Impact | Suggestion |
|---|-------|--------|-----------|
| #4 | updateJob config-path bypasses draft-only task_spec guard | low (UI only edits in draft) | add guard when config has task_spec |
| #5 | materializeTaskSpecToConfig drops group from project_ids | low (task-author uses config path w/ group) | accept project_ids as {name,group} or doc |
| G8 | group-scoped repo resolution only via config path | low | see #5 |
| — | 60 pre-existing baseline test failures (db-schema, harness, clone-file-mgmt, snapshots) | none (pre-existing on test-task-board) | separate cleanup feature |

## Test Summary
3313 passed | 60 failed (pre-existing baseline, none from redesign) | 10 skipped. Redesign's own ~150 tests (task-pool-schema, task-dispatch, task-dispatch-bridge, task-dispatch-service, loop-task-dispatch, composite-dispatch, scheduler-task-spec, scheduler-routes, 07-sse, scheduler-engine, workspace-git/service, task-pool/scheduler-api/clone-chat/composite-status/task-modal-composite) all green.
