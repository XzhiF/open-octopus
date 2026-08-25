# 12 — web-app 统一 TaskModal + 看板 failed/aborted 列

## What to build
web-app：/tasks 全宽看板（task-pool.ts 加 failed/aborted 列）+ 统一 `TaskModal`（status+type 上下文切 authoring/simple/done）。authoring 模式：spec 左/对话 右（task-author clone chat）+ project/skill 选择器 + spec/subunit 编辑器 + [入队] 按钮→`POST /jobs/:id/enqueue`。simple/done 模式：执行流程图 + 结果。替换 tasks/page.tsx:112 placeholder toast。

## Blocked by
10, 05

## Status
done

## Verification Result
- `pnpm --filter @octopus/web-app build` → GREEN (`/tasks` route compiles).
- `tsc --noEmit` on ticket-12 files (app/tasks/page, lib/task-pool, lib/clone-chat, lib/scheduler-api, components/tasks/*) → CLEAN. (One pre-existing unrelated error remains elsewhere: `components/scheduler/execution-history-table.tsx` imports a never-exported `ExecutionStatus` — not introduced by this ticket; only `SchedulerExecutionStatus` is exported.)
- Vitest component unit tests (3 TDD seams) → 17/17 PASS:
  - `lib/__tests__/task-pool.test.ts` (7) — 7 columns incl failed/aborted, G2 buckets.
  - `lib/__tests__/scheduler-api.test.ts` (3) — enqueueJob/abortJob contract (URL/method/body).
  - `lib/__tests__/clone-chat.test.ts` (7) — clone SSE reducer (full-accumulator text_delta, thinking, tool_call lifecycle, no-op events).
- Full web-app vitest suite: no regressions — the 3 still-failing files (harness-floating-panel, knowledge-ui, system-pages) are pre-existing and unrelated to ticket 12.
- Full Playwright E2E (screenshots 320/768/1024/1440, click [+新建], enqueue→queued, failed column) deferred to ticket 14 (matt-e2e-tester) per runner instructions; build + type-check + component unit tests is the gate here.

## Acceptance Criteria
- [ ] 点 [+新建] → authoring modal（spec 左/对话 右）
- [ ] project/skill 选择 + task-author chatbot 产 spec
- [ ] [入队] → draft→queued
- [ ] 点简单卡 → modal 简单执行视图
- [ ] 看板 failed/aborted 列显示对应任务
- [ ] 无 placeholder toast

## Verification Method
**Type**: E2E (Playwright)
**Steps**: 截图 320/768/1024/1440：/tasks 看板 7 列；点 [+新建] → authoring modal；选 project/skill；[入队] → 看板卡移到 queued；failed 任务 → failed 列。
**Pass**: 截图 + assert PASS。**Fail**: max 3 then SKIP。

## Exploration

### Analog studied
- `/tasks` page (`app/tasks/page.tsx`): existing 5-col kanban + right-side `ChatPanel` (global chat via `useChatStream`).
- `components/scheduler/project-selector.tsx` + `lib/api-client.ts#fetchManifestRepos`: multi-repo project selection (group + source_path resolved server-side).
- `lib/resource/api.ts#listResources({type:'skill'})`: installed skills list.
- `components/workspace/chat/use-chat-stream.ts` + `chat-panel.tsx`: workspace/global chat SSE protocol.
- `lib/sse-manager.ts#subscribeSSE`: shared SSE connection (schedule_status already wired on /tasks).

### Critical finding — clone chat protocol mismatch (useChatStream NOT reusable as-is)
Verified against `packages/server/src/routes/clone/index.ts` (ticket 09, done):
- Clone chat route: `POST /api/clones/task-author/sessions/:id/chat`, body `{ message }`, **named** SSE events.
- `text_delta` data = `{ delta, content }` where `content` is the **full accumulator** (not a per-call delta), and **no `messageId`/`sessionId`**.
- `tool_call` is one event with sub-`type` (`start`|`input`|`result`); `done`/`error` are named events.
- `useChatStream` posts `{ content }` to `…/sessions/:id/messages` and its reducer expects per-delta `content` + `messageId` + `type`-field chunks — **incompatible**.
Spec forbids "重写前端 chat 组件" (rewrite frontend chat components). Decision: build a **new focused** `useCloneChatStream` hook + lean chat view inside the TaskModal (net-new code, the existing `ChatPanel`/`useChatStream` stay untouched for global chat). Reuse the existing `MessageBubble` styling via a compact message list.

### Files needing modification (web-app ONLY)
- `lib/task-pool.ts` — add `'failed'` + `'aborted'` to `TaskPoolStatus`/`TASK_POOL_COLUMNS` (7 cols) + `groupJobsByStatus` empty record.
- `lib/scheduler-api.ts` — add `enqueueJob(id)` → `POST /jobs/:id/enqueue`; add `abortJob(id)` → `POST /jobs/:id/abort` (G4, server done) for the modal [中止] button.
- `app/tasks/page.tsx` — full-width kanban (drop right ChatPanel/PanelGroup per v2.1 "无右侧常驻面板"); cards + [+新建] open `TaskModal`; remove placeholder toast at :112; keep SSE refresh.
- `components/tasks/task-modal.tsx` (NEW) — unified context-aware modal: authoring (spec LEFT / clone chat RIGHT) / simple execution + [中止] / done result / failed-aborted / composite stub.
- `lib/clone-chat.ts` (NEW) — `useCloneChatStream` hook + pure `reduceCloneEvent` reducer speaking the clone SSE protocol.

### Functions chosen (with reasons)
- `fetchManifestRepos(org)` + `ProjectSelector` — reuse the existing project picker (handles group/source_path). Do NOT hand-roll.
- `listResources({ type:'skill', installed:true })` — installed skills for the per-task skills selector.
- `listOrgs()` / `useOrgs()` — org for ProjectSelector (no global org context exists).
- `subscribeSSE(url,'schedule_status',cb)` — keep existing SSE-driven kanban refresh.
- `createJob`/`updateJob`/`getJob` — draft create/edit (task-author clone itself POSTs the job via its SKILL; web-app edits draft task_spec via PUT).
- Composite execution (DAG/children/dag, ticket 13): render a stub when `task_spec.subunits` present — do NOT build it.

### TDD seams (pre-agreed)
1. `groupJobsByStatus` / `TASK_POOL_COLUMNS` — 7 buckets incl failed/aborted (extend existing test).
2. `enqueueJob` / `abortJob` — contract test (URL/method/body via fetch mock).
3. `reduceCloneEvent` — pure SSE→messages reducer (text_delta accumulator, tool_call lifecycle, done, error).
TaskModal markup is UI → visual/E2E signal only (deferred to ticket 14); keep it thin, delegate to tested helpers.
