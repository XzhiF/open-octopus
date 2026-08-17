# 06 — abort 端点 + workspace 清理

## What to build
server：`POST /api/scheduler/jobs/:id/abort` → `service.abortJob(id)`。guard status in (claimed, running) → `schedules.status='aborted'` + `runDAO.markStaleExecutionsFailed`（释 unique_active）+ ExecutionService.cancel（中止运行 exec）+ `configDAO.markScheduleWorkspacesCleanedBySchedule`。audit log action='aborted'。

## Blocked by
05

## Status
done

## Acceptance Criteria
- [x] POST /jobs/:id/abort → schedules.status='aborted'
- [x] unique_active 释放（可重派/不再阻塞）
- [x] 运行 exec 取消 + ws 标 cleaned
- [x] 非 claimed/running 状态 abort → 400

## Exploration

### Analog studied
`enqueueJob` (status-transition guard + transaction + audit shape), `triggerJob` (route handler shape), `checkTimeouts` in `scheduler-engine.ts` (`ExecutionService.cancel` via `await import('../execution-service-registry')` — the proven no-static-cycle pattern), `checkStaleClaimed` (`markStaleExecutionsFailed` + `markScheduleWorkspacesCleanedBySchedule` tear-down).

### Files modified (all within ticket 06 ownership)
- `packages/server/src/routes/scheduler.ts` — import `SchedulerJobNotAbortableError`, `classifyError`→400 case, `POST /jobs/:id/abort` route (async, `rateLimitDefault`).
- `packages/server/src/services/scheduler/scheduler-service.ts` — `SchedulerJobNotAbortableError` class + `async abortJob(id)`.
- `packages/server/src/__tests__/scheduler-routes.test.ts` — 5 integration tests (claimed→aborted, running→aborted, draft→400, queued→400, unknown→404) + `createClaimedScheduleWithActiveExecution` helper.
- `scheduler-engine.ts` — NOT modified. The engine keeps no in-flight executor Promise handles (executors are fire-and-forget `.then/.catch`), so there is no "engine-level exec cancel" to perform; the ticket's engine-line conditional ("if abort needs engine-level exec cancel") is false. `ExecutionService.cancel` is a DB/workflow-level operation the ticket explicitly assigns to `scheduler-service.ts`, done there via the same dynamic-import pattern `checkTimeouts` uses (avoids a static dep cycle with `execution-service-registry`, and avoids touching the shared composition root `index.ts`).

### Specific functions chosen
- `configDAO.updateSchedule(id, { status:'aborted', claimed_at:null })` — set terminal status. Chosen over `updateScheduleWithVersion` because abort is not an optimistic-locking edit (no concurrent editor; the status guard is the concurrency control).
- `runDAO.markStaleExecutionsFailed(id, reason)` — releases `idx_sched_execs_unique_active` (partial index on `status IN triggered/running`). Reused verbatim from `checkStaleClaimed`.
- `configDAO.markScheduleWorkspacesCleanedBySchedule(id, now)` — flips `schedule_workspaces.status` running/started → cleaned. Reused verbatim from `checkStaleClaimed`.
- `configDAO.findActiveExecutions(id)[0]` + `runDAO.findExecutionById(...)` — two-step to capture the in-flight execution's `execution_id` + `workspace_id` (a `ScheduleRow` has `workspace_id` but NOT `execution_id`; that lives on `schedule_executions`). Captured BEFORE `markStaleExecutionsFailed` mutates the row.
- `getExecutionService(workspaceId)?.service.cancel(executionId)` — async, best-effort, guarded by `if (executionId && workspaceId)`; missing links (claimed-not-yet-running) or a gone workspace skip cancel without blocking the abort (DB state is already terminal).
- Audit `action='aborted'` — `writeAuditLog` opts type `action: string` (DAO persists plain string, no CHECK constraint), so no `shared` `AuditAction` union change needed (stays in lane; `shared` is owned by 01/05).

## Verification Method
**Type**: integration
**Steps**: dispatch 任务 → POST /abort → SELECT status='aborted' + schedule_executions failed + ws cleaned；abort draft → assert 400。
**Pass**: assert PASS。**Fail**: max 3 then SKIP。
