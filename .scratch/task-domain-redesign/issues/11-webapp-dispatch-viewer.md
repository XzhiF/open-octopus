# 11 — web-app: dispatch viewer（复合父卡+drill-down）

## What to build
TaskModal 复合视图：父卡 aggregate status + drill-down（N 子 schedule via `schedules WHERE origin_type='task' AND origin_id=task.id` 查 + dag from buildDagFromTaskSpec + integration node）。SSE 推父+各子 task_status/schedule_status。复用引擎流程图组件画 composition DAG（v1 D15）。简单任务→简单执行视图；done→结果视图。

## Blocked by
10 (web-app kanban/modal)

## Status
done

## Acceptance Criteria
- [x] AC1: 复合卡显 aggregate status；click→drill-down N 子+dag+integration
- [x] AC2: SSE 推父+各子状态实时刷新
- [x] AC3: 简单/done 视图切换

## Verification Method
**E2E (Playwright)**: 复合 task→父卡+drill-down N 子；SSE 刷新。Pass: drill-down+实时。

## Exploration

**Analog studied**: ticket 10's `CompositeMode` in `packages/web-app/components/tasks/task-modal.tsx` (committed) + the server's SSE emit shape on the `taskpool` channel.

**Key findings — what ticket 10 left minimal**:

1. **SSE only subscribes to `task_status`** (`task-modal.tsx:445`). The server emits TWO event types on the same `taskpool` channel that `/api/tasks/events` forwards:
   - `task_status` `{task_id, status, schedule_id, origin_type}` — parent mirror, from `schedule-status-listener.ts:105` (ScheduleStatusListener, SG2).
   - `schedule_status` `{schedule_id, status}` — per-schedule child transitions, from `task-dispatch-service.ts:115/130/276` (child queued/running, SG10) + `workflow-executor.ts:320/450/496` (running/done/failed).
   
   AC2 ("SSE 推父+各子状态实时刷新") requires catching each **child** `schedule_status` transition (queued→running→done) — ticket 10 misses these, so child cards only refresh on the slower parent-mirror event. **This is the core gap.**

2. **SSE subscription re-creates on every `detail` refetch** (`task-modal.tsx:468` — `detail` is in the effect deps). Each refetch tears down + re-creates the subscription, risking missed events during the gap. Stabilize with a ref holding the latest `detail` so the handler sees fresh children without re-subscribing.

3. **Server `TaskDetailDTO.children` shape** (`tasks-service.ts:111-117`): 5 fields — `schedule_id, name, status, origin_role, workflow_ref`. NO `workspace_id` exposed. The client `TaskChild` mirror (`tasks-api.ts:31-44`) matches exactly. "Show child ws" is satisfied by surfacing `origin_role` (coordinator/primary/subunit — the workspace-role signal) which is already shown as a small badge on each child card. Adding `workspace_id` would require server changes (out of bounds — server DONE+committed).

**Files to modify (web-app only, my lane)**:
- `packages/web-app/components/tasks/task-modal.tsx` — `CompositeMode`: add a second `subscribeSSE("schedule_status", …)` for child transitions; stabilize the subscription via a ref so refetches don't tear it down; route both event types into the events panel with correct labels (parent → "父任务", child → child name).
- `packages/web-app/components/tasks/__tests__/task-modal-composite.test.tsx` — add tests: (a) `schedule_status` for a child schedule_id triggers refetch + refreshes the child card; (b) `schedule_status` for an unrelated schedule_id is ignored; (c) the events panel renders `schedule_status` entries labelled with the child name; (d) the subscription survives a refetch (no re-subscribe on `detail` change).

**Functions chosen**:
- USE `subscribeSSE(url, "schedule_status", handler)` — second subscription on the same URL; `sse-manager` dedupes the underlying `EventSource` (refcount pattern, `sse-manager.ts:43-99`).
- USE `getTask(id)` for refetch on any relevant event (parent `task_status` or child `schedule_status`).
- USE a `detailRef` (`useRef`) holding the latest `TaskDetail` so the SSE handlers read fresh children without entering the effect deps → stable subscription.
- Do NOT add `workspace_id` to `TaskChild` — server doesn't return it; out of bounds.
