# Server/Lifecycle Walk-Through — Peer Report (Explore, condensed)

> Source: teammate session "Explore". Condensed verdicts + file:line. Full verbatim in conversation.

## Lifecycle / crash recovery (Story C)
- `checkStaleClaimed` EXISTS (scheduler-engine.ts:459-479): finds claimed/running >10min, rolls back to queued.
- `markStaleExecutionsFailed` EXISTS (schedule-run-dao.ts:95-101): triggered/running→failed, releases `idx_sched_execs_unique_active`.
- Periodic trigger EXISTS (scheduler-engine.ts:117 setInterval 60s → auxiliaryTick → checkStaleClaimed). NOT a missing trigger.
- `unique_active` EXISTS (schema.sql:565), released in all terminal paths.
- Claim logic EXISTS (scheduler-engine.ts:416-454): claimed+claimed_at, dispatch, rollback on sync failure.

## GAPS found
- **Missing lifecycle state (HIGH)**: `ScheduleStatus` type = 5 values (draft/queued/claimed/running/done). `failed` + `aborted` NOT in type. A failed task's `schedules.status` stays `running` (no writer to 'failed'); only `schedule_executions.status`→failed. Failed tasks orphaned in 'running'. No kanban 'failed' col.
- **Unconnected feedback (MEDIUM)**: `checkStaleClaimed` rollback emits NO SSE; SchedulerEngine has no SSEService injected. UI 10s poll catches it. Real-time rollback invisible.
- **POST /jobs/:id/abort MISSING (HIGH)**: no route, no `abortJob`, no 'aborted' status. Can't stop a running/claimed schedule. (Only ExecutionService.cancel for individual exec, internal.)
- Parent-child schedules MISSING (expected — composite is new).

## Server package (Story A/B)
- POST /jobs EXISTS (draft, trigger_source=requirement; auto-creates 'taskpool-draft' chat session).
- enqueue EXISTS (draft→queued, guards). **No SSE on enqueue/queued.**
- GET /jobs EXISTS (?trigger_source=requirement). **JobDetail has NO children[]/dag** (composite needs it).
- **POST /jobs/:id/abort MISSING** (corroborates above).
- SSE taskpool emits ONLY running + done. queued/claimed/rollback/abort silent.
- **task-author clone MISSING** (5 builtins: workspace/scheduler/archive/resource/harness-agent). Generic `/api/clones/:name/sessions/:id/chat` auto-works once registered.
- **source_path silent failure CONFIRMED (HIGH)**: `initWorktreesFromSpec` (workspace-git.ts:115-117) silently skips empty source_path; NO repos/index.md fallback (that's in `initWorktreesSync`, a DIFFERENT method for user workspaces, not scheduler). The shared-type comment "empty source_path resolved server-side from repos/index.md" is ASPIRATIONAL (a lie). Multi-repo → empty workspace, workflow runs with no project code, no error propagated.
- **'taskpool-draft' sentinel CONFIRMED**: chat_session.workspace_id = fake id (FK risk); one-way link; orphan sessions if createJob fails; chat_sessions vs sessions two storage systems.
- **Silent failure (MEDIUM)**: `buildSchedulerJob` (scheduler-engine.ts:653) casts to `'draft'|'queued'|'claimed'` — drops running/done; runtime may exceed type bounds.
- **Orphan field (LOW)**: `ProjectSpec.group` written, never read. Legacy orphans: schedules.workflow_ref/input_values/workspace_id (legacy, not read by v2).

## Cross-check vs spec.md
- spec API table listed `POST /jobs/:id/abort` as **existing** → ERROR (it's MISSING). Must mark new build + add 'aborted' status.
- spec said SSE emits "父+各子" → GAP: current emits only running/done; SchedulerEngine has no SSEService. Must inject + emit all transitions.
- spec R4 noted source_path bug but fix (wire repos/index.md into initWorktreesFromSpec) must be explicit; aspirational comment must be fixed/removed.
- spec lifecycle (Story C) assumes done; missing failed/aborted path.
