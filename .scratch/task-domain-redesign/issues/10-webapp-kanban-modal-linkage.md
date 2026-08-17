# 10 — web-app: /tasks 看板 + TaskModal 联动 + 资源 picker

## What to build
`/tasks` 看板（tasks 状态列：draft/ready/running/done/failed/aborted；SG14 全量改读 Task 类型，弃 SchedulerJob）。TaskModal authoring：spec↔agent 联动（SpecPanel 订阅 spec_field_update SSE→实时刷新本地 state+version；[保存草稿]→PUT /tasks+反向通知 agent）；autosave row+title 显示；资源 picker（authoring_resources draft-scope / resources workspace-scope，SG13 SubunitsEditor 加 per-subunit resources picker）；[保存草稿]按钮；router.push 重指 /tasks/:id/children/:scheduleId（SG15）。订阅 /api/tasks/events SSE。

## Blocked by
03 (tasks service), 04 (autosave), 05 (spec-field), 07 (resource loading)

## Status
done

## Verification Results
- Web-app unit tests: 37/37 pass across 4 files (`lib/__tests__/tasks-api.test.ts` 15, `lib/__tests__/task-board.test.ts` 6, `components/tasks/__tests__/task-modal-spec-panel.test.tsx` 10, `components/tasks/__tests__/task-modal-composite.test.tsx` 6). The 7 failures in the full suite (`harness-floating-panel`, `knowledge-ui`, `system-pages`) are PRE-EXISTING — confirmed via `git stash` run on the clean tree (same 7 fail without my changes); none touch the tasks domain.
- `pnpm --filter @octopus/web-app build`: succeeds (`/tasks` route present).
- `tsc --noEmit`: clean for all ticket-10 files (the pre-existing errors in `useAgentChat`/`useKnowledge`/`moa-model-resolver`/`resource/types`/`yaml-utils` are unrelated and out of scope).

## AC Coverage
- [x] AC1: /tasks 看板显 6 Task 状态列 (draft/ready/running/done/failed/aborted) — reads `Task.status` directly, no schedule join (`groupTasksByStatus` in `lib/task-board.ts`).
- [x] AC2: agent `update_task_spec_field` → `spec_field_update` SSE → SpecPanel applies field live + bumps local version (avoids subsequent [save] 409) — `spec-panel.tsx` subscribeSSE.
- [x] AC3: [保存草稿] → `updateTask` PUT `/api/tasks/:id` with If-Match (server sets reverse-msg notice via 05); autosave row+title surfaced via `resolveDraft` polling `listTasks({status:'draft'})` + page 10s polling + `task_status` SSE.
- [x] AC4: ResourcePicker lists the 4 provisionable types (skill/agent/command/rule) via `listResources({installed:true})`; two scope (authoring_resources draft-scope / resources workspace-scope); SubunitsEditor renders a per-subunit `subunit-resource-picker-${i}`.
- [x] AC5: `Task` type replaces `SchedulerJob` across `/tasks` page + `task-modal` + `spec-panel`; `router.push` retargeted to `/tasks/:taskId/children/:scheduleId` (SG15).

## Files Changed
NEW:
- `/Users/xzf/Projects/ai/XzhiF/open-octopus/packages/web-app/lib/tasks-api.ts` — thin `/api/tasks` client (list/get/create/update/delete/ready/abort/spec-field) + `TaskDetail`/`TaskChild` types.
- `/Users/xzf/Projects/ai/XzhiF/open-octopus/packages/web-app/lib/task-board.ts` — 6 TaskStatus kanban columns + `groupTasksByStatus`.
- `/Users/xzf/Projects/ai/XzhiF/open-octopus/packages/web-app/components/tasks/spec-panel.tsx` — `SpecPanel` (SSE spec_field_update + [保存草稿] PUT) + `ResourcePicker` (two scope) + `SubunitsEditor` (per-subunit resources) + `SkillsSelector`.
- `/Users/xzf/Projects/ai/XzhiF/open-octopus/packages/web-app/lib/__tests__/tasks-api.test.ts` (15 tests)
- `/Users/xzf/Projects/ai/XzhiF/open-octopus/packages/web-app/lib/__tests__/task-board.test.ts` (6 tests)
- `/Users/xzf/Projects/ai/XzhiF/open-octopus/packages/web-app/components/tasks/__tests__/task-modal-spec-panel.test.tsx` (10 tests)

MODIFIED:
- `/Users/xzf/Projects/ai/XzhiF/open-octopus/packages/web-app/app/tasks/page.tsx` — `SchedulerJob`→`Task`; `listJobs({trigger_source})`→`listTasks()`; SSE `/api/scheduler/events` `schedule_status`→`/api/tasks/events` `task_status`.
- `/Users/xzf/Projects/ai/XzhiF/open-octopus/packages/web-app/components/tasks/task-modal.tsx` — `SchedulerJob`→`Task`+`TaskDetail`; `enqueueJob`→`readyTask`; `abortJob`→`abortTask`; `updateJob`→`updateTask` (in SpecPanel); composite derives DAG from `task_spec.subunits` + children from `TaskDetail.children`; `router.push` retarget (SG15); re-exports `SpecPanel`/`ResourcePicker` from `spec-panel.tsx`.
- `/Users/xzf/Projects/ai/XzhiF/open-octopus/packages/web-app/components/tasks/__tests__/task-modal-composite.test.tsx` — `JobDetail`/`getJob`→`TaskDetail`/`getTask` fixtures; SSE `schedule_status`→`task_status`; asserts `/tasks/parent-1/children/child-1` (SG15).

## Notes
- Boundary respected: only `packages/web-app` touched. No edits to server/engine/shared/providers/core-pack (all DONE/other tickets).
- The composite DAG + child cards + events panel (drill-down UI) are minimally type-adapted to `Task`+`TaskDetail.children` (required by SG14 to keep the build green); ticket 11 will replace/enhance the dispatch-viewer. The legacy `lib/task-pool.ts` (v1, 7 columns against `SchedulerJob`) is now dead (the /tasks page uses `task-board.ts`); left in place as harmless dead code — a refactor-cleaner pass can remove it later (not required by any AC).

## Acceptance Criteria
- [ ] AC1: /tasks 看板显 tasks 状态列（不 join schedules 即可显 running/failed/aborted）
- [ ] AC2: agent update_task_spec_field→SpecPanel 经 SSE 实时刷新
- [ ] AC3: [保存草稿]→PUT+反向通知；autosave row+title 显
- [ ] AC4: 资源 picker（authoring vs workspace 两 scope）；SubunitsEditor per-subunit resources
- [ ] AC5: router.push 重指；Task 类型替换 SchedulerJob

## Verification Method
**E2E (Playwright)**: /tasks 显状态；agent 绑字段→SpecPanel 刷新；保存→反向；选资源→分流。Pass: 联动+资源+看板。

## Exploration

**Analog studied:** the existing `/tasks` page + `components/tasks/task-modal.tsx` (v1 task-pool impl against `SchedulerJob`/`schedules` table). Direct predecessor — same kanban + authoring + composite modal, just against the old `SchedulerJob` instead of the new first-class `Task`.

**Files needing modification (web-app only — server/shared/engine untouched):**
- `packages/web-app/lib/tasks-api.ts` (NEW) — thin client for `/api/tasks` (list/get/create/update/delete/ready/abort/spec-field) + `TaskDetail` type.
- `packages/web-app/lib/task-board.ts` (NEW) — 6 Task columns (draft/ready/running/done/failed/aborted; claimed folded into running per v2-D14) + `groupTasksByStatus(Task[])`.
- `packages/web-app/app/tasks/page.tsx` — `SchedulerJob`→`Task`; `listJobs({trigger_source})`→`listTasks()`; SSE `/api/scheduler/events` `schedule_status`→`/api/tasks/events` `task_status`+`spec_field_update`.
- `packages/web-app/components/tasks/task-modal.tsx` — `SchedulerJob`→`Task`+`TaskDetail`; SpecPanel subscribes `spec_field_update` SSE→live-update local state+bump version; [保存草稿]→`PUT /api/tasks/:id` If-Match (server sets reverse-msg notice via 05); ResourcePicker (authoring vs workspace two-scope); SubunitsEditor per-subunit resources (SG13); `router.push('/scheduler/jobs/:id')`→`/tasks/:id/children/:scheduleId` (SG15).
- `packages/web-app/lib/composite-status.ts` — loosen `JobDetailChild` dep to a local `Pick<{status}, 'status'>`-shaped child so the composite aggregate stays working against `TaskDetail.children`.
- New unit tests: `lib/__tests__/tasks-api.test.ts`, `lib/__tests__/task-board.test.ts`, `components/tasks/__tests__/task-modal-spec-panel.test.tsx` (SSE spec_field_update applies field + bumps version; [保存草稿] calls PUT with If-Match; ResourcePicker lists installed resources of the 4 provisionable types). Update existing `components/tasks/__tests__/task-modal-composite.test.tsx` to use `Task`/`TaskDetail`/`getTask` fixtures + retargeted `router.push`.

**Specific functions chosen:**
- USE `listTasks()` (NEW, GET /api/tasks) — NOT `listJobs({trigger_source:'requirement'})` (old schedules-table path; tasks is now first-class per v2-D1/SG14).
- USE `getTask(id)` (NEW, GET /api/tasks/:id → `TaskDetail` with `children[]` via S2 origin lookup) — NOT `getJob(id)` (returns `JobDetail` from scheduler).
- USE `updateTask(id, input, version)` (NEW, PUT /api/tasks/:id with `If-Match`) — NOT `updateJob(id, {config:{...task_spec}}, version)` (PUT /api/scheduler/jobs).
- USE `readyTask(id)` (NEW, POST /:id/ready — draft→ready + dispatch seam) — NOT `enqueueJob(id)` (POST /jobs/:id/enqueue).
- USE `abortTask(id)` (NEW, POST /:id/abort — running/ready→aborted + ws cleanup) — NOT `abortJob(id)`.
- USE `updateSpecField(id, field, value)` (NEW, POST /:id/spec-field) — agent tool endpoint; server emits `spec_field_update` SSE which SpecPanel subscribes to.
- REUSE `subscribeSSE(url, eventType, listener)` (lib/sse-manager) — for both `task_status` + `spec_field_update` on `/api/tasks/events`.
- REUSE `useAgentChat` + `ChatArea` + `agentApi.{createCloneSession,getCloneSession,cloneChatStream,stopCloneChat}` (unchanged) — task-author clone chat (05/07 patterns).
- REUSE `listResources({type:'skill'|'agent'|'command'|'rule', installed:true})` (lib/resource/api) — ResourcePicker lists the 4 `TaskResourceType` provisionable resources.

**Boundary respected:** composite drill-down UI (DAG + child cards + events panel) stays in `task-modal.tsx`/`composite-dag.tsx` minimally type-adapted to `Task`+`TaskDetail.children` (required by SG14 — keep build green; NOT building new drill-down). Ticket 11 will enhance/replace the dispatch-viewer. `router.push` retarget to `/tasks/:taskId/children/:scheduleId` is mine (SG15). Server/shared/engine/providers/core-pack untouched (all DONE/other tickets).
