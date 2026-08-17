# 09 — task-author clone + SKILL + route + 退役哨兵

## What to build
server + core-pack：builtin `task-author` CloneDef（persona + skills filter + cwd=project.source_path，多仓库主 cwd+余 refs）+ `task-author/SKILL.md`（scheduler API + task_spec schema + WorkflowConfig 物化 curl recipes）。route `/api/clones/task-author/sessions/:id/chat`（复用 generic clone 路由 clone/index.ts:241）。**退役 'taskpool-draft' 哨兵**（G7）：authoring chat 走真 clone session（sessions 表），`source_chat_session_id` 链 task，clone-session `scope_id=task_id`；删 `TASKPOOL_DRAFT_CHAT_SCOPE`；createJob 失败 rollback 清孤儿 session。

## Blocked by
01, 08

## Status
done

## Acceptance Criteria
- [x] task-author clone 注册（builtin-clones）+ SKILL.md 安装
- [x] chat 经 /api/clones/task-author/sessions/:id/chat（真 clone session）
- [x] 无 'taskpool-draft' 假 workspace_id（FK 风险消除）
- [x] createJob 失败 → 无孤儿 session
- [x] task-author SKILL 含 scheduler API + task_spec→WorkflowConfig 物化指引

## Verification Method
**Type**: integration + manual
**Steps**: POST /api/clones/task-author/sessions/:id/chat → assert session 在 sessions 表 + scope_id=task_id；createJob 故意失败 → assert 无孤儿 chat session；manual 检 SKILL.md 内容。
**Pass**: assert PASS。**Fail**: max 3 then SKIP。

## Exploration

### Analog studied
- `builtin-clones.ts` (5 builtins: workspace/scheduler/archive/resource/harness-agent). Pattern: persona const + entry in `BUILTIN_CLONES[]` with `{name, displayName, type:'built-in', persona, skills, memoryScope, config:{}}`. Resolver `resolveBuiltinCloneInfo` reads config.json/persona.md from disk with fallback to the inline def — so a builtin resolves even before its on-disk dir exists.
- `clone-runtime.ts` `CloneRuntime.getDefaultCwd()` returns the clone's own dir (`~/.octopus/agent/built-in/{name}/`). The generic chat route (`routes/clone/index.ts:280`) calls `runtime.getDefaultCwd()` and passes it as cwd — no per-session cwd override exists. Per-task `cwd=project.source_path` therefore requires per-session context (scope_id → project) and is a follow-up alongside per-task skill scoping; the clone is registered now with cwd guidance carried in the persona, and the route is NOT reinvented (per ticket instruction).
- `routes/clone/index.ts:241` generic clone chat route: resolves clone via `resolveCloneDefFromFs(name)` → 404 if missing. Once `task-author` is in `BUILTIN_CLONES`, `resolveCloneDefFromFs('task-author')` returns the def (persona fallback to inline) → chat route resolves (200 SSE). Verified: no route change needed.
- `routes/scheduler.ts` POST /jobs (lines 193-214): the `TASKPOOL_DRAFT_CHAT_SCOPE='taskpool-draft'` sentinel (line 22) + `chatService.createSession('taskpool-draft', title)` (line 205) inserts a `chat_sessions` row with a fake `workspace_id` — the FK-risk sentinel G7 retires.
- `AgentSessionDAO.insertSession` (sessions table) accepts `clone_name`, `session_type:'clone_direct'`, `scope_id`, `is_active`, `is_deleted`. `updateSession(id, {scope_id})` links session→task. `softDelete(id)` marks `is_deleted=1` (clone chat route treats is_deleted as 404, so a soft-deleted session can't be chatted → not an orphan). `sessions.scope_id` is plain TEXT, no DB FK → safe to point at job.id.

### Files to modify
- `packages/server/src/services/agent/builtin-clones.ts` — add `task-author` CloneDef (persona + skills + memoryScope) + `TASK_AUTHOR_PERSONA` const.
- `packages/server/src/routes/scheduler.ts` — retire `TASKPOOL_DRAFT_CHAT_SCOPE`; replace `chatService?: ChatService` dep with `agentSessionDAO?: AgentSessionDAO`; rewrite POST /jobs auto-create to insert a real task-author clone session (scope_id=null), then `updateSession(scope_id=job.id)` on success / `softDelete` on failure (rollback).
- `packages/server/src/index.ts` — update wiring: pass `d.agentSession` (AgentSessionDAO) as 4th arg to `createSchedulerRoutes` instead of `chatSvc`.
- `packages/core-pack/skills/task-author/SKILL.md` (NEW) — curl-driven REST reference (scheduler API + task_spec schema + WorkflowConfig materialization), following `octo-scheduler/SKILL.md` pattern.
- `packages/server/src/__tests__/scheduler-routes.test.ts` — rewrite AC18 (asserts old 'taskpool-draft' in chat_sessions) to assert new G7 behavior (session in `sessions` table, clone_name='task-author', scope_id=job.id); add clone-route wiring + chat-resolves test + createJob-failure rollback test.

### Functions chosen
- `AgentSessionDAO.insertSession({...})` — creates the real clone session (clone-session mechanism). Use this, NOT `ChatService.createSession` (that writes chat_sessions with a workspace_id FK — the retired sentinel).
- `AgentSessionDAO.updateSession(id, {scope_id: job.id})` — links clone session to task after createJob succeeds.
- `AgentSessionDAO.softDelete(id)` — rollback on createJob failure (consistent with DAO pattern; is_deleted=1 → not chattable → not an orphan).
- `service.createJob(body)` — unchanged; persists `source_chat_session_id` (scheduler-service.ts:354).

### Out of scope (noted, not blocking)
- Per-task skill scoping: ADR-006 makes `getPlugins()` ignore `CloneDef.skills` (every clone inherits all shared skills). `skills: ['task-author']` is declarative-only. Full per-task scoping (synthetic dir or re-enable `loadSkills` filter) is a follow-up.
- Per-session cwd override (`cwd=project.source_path`): the generic chat route uses `runtime.getDefaultCwd()`; per-session cwd from scope_id→project is a follow-up. Persona carries multi-repo guidance meanwhile.
