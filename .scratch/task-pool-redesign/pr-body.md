## Task Pool Redesign — project-bound authoring + composite dispatch

PR #50 evolved into a full wayfinder-driven redesign. A task is authored by a **project-bound task-author clone** (structured spec = WHAT) → manual enqueue (confirm gate) → scheduler dispatch: simple (1 workspace) or **composite** (N independent workspaces orchestrated + integrated via a new `task_dispatch` engine node + composition workflow). Full kanban lifecycle (failed/aborted terminal + retry-cap, SSE on all transitions, abort), unified task modal UI.

### Architecture (ADR-0008)
Composite orchestration lives in the **workflow layer**: a task pins a composition workflow (coordinator-ws) → `task_dispatch` node fans out N child schedules (each `createFromSpec` own ws) → engine DAG/Loop/Swarm orchestrates → swarm/moa aggregates. Reuses existing engine primitives — no second orchestration engine.

### Key decisions (16) + story-gap fixes (11, G1–G10)
- **G1 cross-boundary await** = pause-resume (reuses interaction/approval infra), NOT a blocking Promise — restart-safe DB marker. The spec's #1 risk, now built + tested.
- **G2 failed/aborted terminal + retry-cap** — kills the infinite `claimed→stale→re-dispatch` loop.
- **G3 source_path** multi-repo resolution via `repos/index.md` (was a silent skip + a lying comment).
- **G4 abort** endpoint + workspace cleanup.
- **G5 SSE** on ALL transitions (was only running/done); `SchedulerEngine` now has `SSEService`.
- **G7 retired `taskpool-draft` sentinel** → real task-author clone session (`scope_id=task_id`).
- **G9 task_spec→WorkflowConfig materialization** (simple=workflow_chain; composite=composition-task ref + subunits).
- **G10 composition = Loop over subunits → `task_dispatch` → moa aggregate**.
- D16: `workflow_chain` kept as the simple sequential same-ws fast path.
- Full map: `.scratch/task-pool-redesign/map.md` · `docs/adr/0008-composition-layer-workflow-task-dispatch.md`

### E2E verification (50/50 PASS)
| AC | Status |
|----|--------|
| US1 kanban 7 cols + authoring modal | PASS (4 responsive screenshots) |
| US4 composite children[]+dag | PASS (API+DB+UI) |
| US5 enqueue draft→queued+SSE | PASS (4-layer cross-validation) |
| US6/7/8 simple/composite/done modal | PASS (screenshots) |
| US10 crash recovery rollback+SSE | PASS |
| US11 SSE all transitions | PASS |
| US15 abort (aborted+ws cleaned+SSE) | PASS |
| US16 failed terminal (no infinite re-dispatch) | PASS |
| API integration (29 tests) | PASS |

**SKIP (with reason, not failures):** US3 (LLM chatbot→spec — no API keys; alternative path POST /jobs with pre-seeded task_spec verified), US9 (real-repo drill-down — needs `repos/index.md` entries; modal DAG+cards render correctly). Full report: `.scratch/task-pool-redesign/pipeline-report.md`.

### Changed files
101 files, +10545/−364 — shared types v3 (TaskSpec/SubunitSpec/ScheduleStatus+failed/aborted/`task_dispatch` NodeDef/TaskDispatchPort), engine `TaskDispatchExecutor`+pause-resume bridge+LoopExecutor task_dispatch case, server composite dispatch+failed/aborted+abort+SSE+task-author clone+jobs API/JobDetail+source_path, core-pack composition-task.yaml + task-author SKILL, web-app unified TaskModal + 7-col kanban + composite modal.

### Test summary
3313 passed / 60 pre-existing baseline failures (db-schema, harness, clone-file-mgmt, snapshots — **none from this redesign**) / 10 skipped. E2E 50/50.

### Remaining (accepted, non-blocking)
- #4 `updateJob` config-path draft guard (UI only edits in draft — API hardening follow-up)
- #5 `project_ids` group-scope (task-author uses the config path with group)
- US3 LLM chatbot E2E (needs API keys)

<!-- MANUAL-START -->
<!-- MANUAL-END -->
