# 05 — server: spec-field tool + reverse context msg（SPIKE S1 gated）

## What to build
`update_task_spec_field` 工具 handler（agent 调 `{task_id,field,value}`→tasks DAO 局部合并 task_spec/resources/authoring_resources→emit spec_field_update SSE）。field∈{projects,skills,goal,ac,subunits,integration_goal,resources,authoring_resources}。冲突 stale version→409→agent re-GET+retry。反向 context msg：[保存草稿]后注入 `@@spec_updated` 到 task-author session（机制=prepend 到下条 user msg，**SPIKE S1 验证**；不可行→回退 agent 工具 re-GET，回来 persuade 改 v2-D7）。

## Blocked by
03 (tasks service), 04 (autosave — clone/index.ts 同文件序，串行避免并发冲突)

## Status
done

## Acceptance Criteria
- [~] AC1: update_task_spec_field 写 tasks 字段 + emit spec_field_update SSE — **03's scope** (TasksService.updateSpecField + spec_field_update SSE), verified passing in tasks-routes.test.ts (22/22). Not redone here.
- [~] AC2: stale version→409 — **03's scope** (TaskVersionConflictError → route 409), verified passing in tasks-routes.test.ts. Not redone here.
- [x] AC3: [保存草稿]→`CloneRuntime.chat` `specUpdateNotice?` 参→system-prompt append（SPIKE S1 验，v2-D7 PUSH；非 prepend-to-user-msg）

## Verification Result
**PASS** — reverse direction (user [保存草稿] → task-author agent) verified via two test files:
- `packages/server/src/__tests__/clone-spec-notice.test.ts` (integration, 4 tests):
  - AC3a: `TasksService.updateTask` sets `@@spec_updated: <fields>` in the in-memory store keyed by task_id.
  - AC3b: next task-author chat send reads the notice, passes it to `CloneRuntime.chat` as `specUpdateNotice`, clears the store after the stream (one-shot; `!aborted` gate leaves it pending on abort for at-least-once).
  - AC3c: no pending notice → `specUpdateNotice` undefined, no `@@spec_updated` leak.
  - gate: non-task-author path never touches the store.
- `packages/server/src/services/agent/__tests__/clone-runtime.test.ts` (2 new tests): real `CloneRuntime` + mocked provider `sendQuery` — asserts the notice is concatenated into `systemPrompt.append` (SPIKE S1 mechanism, clone-runtime.ts:310-329); omitted notice leaves `append == cloneSystemPrompt` (no separator/leak).

Anti-fake-run: real better-sqlite3 + applySchema, real TasksService/TaskDAO/AgentSessionDAO/SSEService wired into a Hono app, app.request (API↔DB), data prefix E2E_TD_, assert store state + captured chat arg. Only CloneRuntime + clone-resolver mocked (the runtime's append-concat is asserted separately with a real runtime + provider spy).

Regression check: task-domain-redesign surface green (88/88 across clone-autosave/clone-spec-notice/clone-api/clone-files-n/a/tasks-routes/06-schedules-origin/07-sse-schedule-status/clone-runtime); `pnpm --filter @octopus/server run build` (tsup + DTS) succeeds. Full-suite failures (46) are all pre-existing in untouched subsystems (engine/harness/archive/v1-scheduler/schema[06]/clone-file-mgmt[clone-files.ts]/prompt-assembler[snapshot rot — my diff to clone-runtime.ts touches only chat()/sendWithProvider(), not assembleContext()]).

## Verification Method
**integration**: curl POST /spec-field → DB 断字段+SSE 收到；stale version→409；[保存]→session 含 @@spec_updated（或回退机制可验证）。Pass: 字段+SSE+409+反向可达。
**SPIKE S1 — RESOLVED**：机制=system-prompt append（`CloneRuntime.chat` 加 `specUpdateNotice?` 参→`sendWithProvider.append` concat，clone-runtime.ts:310-329；`assembleContext` 每 turn fresh :261）；非 prepend-to-user-msg（避免 DB 污染）；v2-D7 保持 PUSH。

## Exploration

### Analog studied
**04's task-author autosave seam** (`packages/server/src/routes/clone/autosave.ts` +
`packages/server/src/routes/clone/index.ts:416-428`). It is the closest analog: a
best-effort, turn-end side-effect wired into the clone chat SSE route, gated by
`cloneName === 'task-author' && taskDAO`, non-fatal on failure. The reverse
context-msg seam is the SAME shape but in the SEND path (before `runtime.chat`)
rather than the turn-end path (after the stream).

### Files needing modification (within boundary)
- `packages/server/src/services/tasks/spec-notice-store.ts` (**NEW**) — in-memory
  `Map<task_id, string>` module singleton. API: `setSpecNotice` /
  `getSpecNotice` / `clearSpecNotice` / `clearAllSpecNotices` (test reset). No db
  column / schema migration (06 owns schema.ts — avoid conflict).
- `packages/server/src/services/agent/clone-runtime.ts` — `chat()` gains optional
  `specUpdateNotice?: string` (5th param, before `abortSignal`; all 4 existing
  callers pass ≤4 args so reorder is safe — verified
  clone/index.ts:306, main-agent-route.ts:239/763, clone-runtime.test.ts:168).
  `sendWithProvider` concatenates the notice into `systemPrompt.append`
  (clone-runtime.ts:310-329, exactly the SPIKE S1 mechanism).
- `packages/server/src/services/tasks/tasks-service.ts` — `updateTask` (03's
  file) sets `setSpecNotice(id, '@@spec_updated: <fields>')` after a successful
  `updateWithVersion` (small hook, non-fatal).
- `packages/server/src/routes/clone/index.ts` — SEND path (before
  `runtime.chat`, ~line 286-306, a DIFFERENT location from 04's turn-end
  autosave block at :416-428): resolve `task_id` via
  `taskDAO.getBySourceChatSession(sessionId)` (same pattern as autosave.ts), read
  `getSpecNotice(taskId)`, pass as `specUpdateNotice` to `runtime.chat`, then
  `clearSpecNotice(taskId)` AFTER the for-await stream (at-least-once on
  mid-stream error; assembleContext is fresh per turn so re-delivery is correct).

### Files NOT touched (boundary)
- db/schema.ts/types.ts/dao (02+06), scheduler-* (06), packages/shared (01),
  packages/providers (13), routes/tasks.ts (03), server/src/index.ts (06 may wire
  orphan-reaper there). The store is a self-contained module imported by
  tasks-service + clone route — no central wiring needed.

### Functions chosen
- `TaskDAO.getBySourceChatSession(sessionId)` (task-dao.ts:66) — resolve task_id
  from the chat session in the clone send path. Use THIS (not `session.scope_id`)
  because it mirrors the autosave seam's resolution and is the canonical
  source_chat_session_id→task link. Returns `TaskRow | null` with `.id`.
- `provider.sendQuery(prompt, cwd, resumeSessionId?, options?)` (providers
  types.ts:111) — options is the 4th arg; `options.systemPrompt.append` is the
  string the SDK appends to the preset system prompt. The runtime test captures
  this arg to assert the notice is concatenated.
