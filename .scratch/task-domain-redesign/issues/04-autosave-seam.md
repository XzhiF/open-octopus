# 04 — server: autosave seam + scope_id writer

## What to build
`clone/index.ts:406` autosave seam（auto-title 块后、done SSE 前，cloneName==='task-author' 门控）：首 turn 若无关联 tasks 行→建(status=draft, source_chat_session_id, title=auto)；每轮 update title+updated_at（targeted UPDATE，不 bump version、不碰 task_spec/resources，SG8）。`POST /api/tasks` + autosave seam 都 `updateSession(scope_id=task.id)`（SG3）。

## Blocked by
03 (tasks service)

## Status
done

## Acceptance Criteria
- [x] AC1: task-author 首轮流后 tasks 行存在(status=draft, source_chat_session_id, title=auto)
- [x] AC2: 每轮 title+updated_at 更新；version 不 bump；task_spec/resources 不被 autosave 改
- [x] AC3: sessions.scope_id=tasks.id（autosave + POST /tasks 都设）

## Verification Method
**integration**: mock task-author 首轮流 → DB 断 tasks 行+scope_id；二轮流 → title 变+version 不变。Pass: 行存在+scope_id 正确+version 稳定。

## Exploration

### Analog studied
1. **Existing auto-title block** at `packages/server/src/routes/clone/index.ts:402-406` — the closest existing "turn-end side-effect" pattern: after the chat loop, gated by `session.title === '${cloneName} 会话' || session.title === '新会话'`, writes the session title from `body.message.slice(0, 40)`. My autosave seam slots in immediately after this block, before the `done` SSE at line 408 — same lifecycle point, same "best-effort side-effect at turn-end" shape.
2. **03's `tasks-routes.test.ts`** — integration-test conventions: real `better-sqlite3` in-memory DB + `applySchema` (R1/R3/R4/R5), Hono `app.request()` (R3 API↔DB), data prefix `e2e-td-` (R7), assert response+SQL (R4). My test reuses this stance.

### Files needing modification (ticket 04 scope — clone/* lane only)
1. `packages/server/src/routes/clone/index.ts` — add autosave seam between line 406 (end of auto-title block) and 408 (done SSE), gated by `cloneName === 'task-author'`. Add `taskDAO?: TaskDAO` to `CloneSessionRouteDeps` (optional → backwards-compatible with existing tests passing `{ sessionDAO }`).
2. `packages/server/src/index.ts:441-443` — wire `taskDAO: d.task` (already constructed at line 158 as `new TaskDAO(db)`; type declared at line 135).
3. NEW `packages/server/src/routes/clone/autosave.ts` — extract `autosaveTaskDraft(deps, input)` as a pure function so the seam is unit-testable without SSE.
4. NEW `packages/server/src/__tests__/clone-autosave.test.ts` — integration test at the route seam (AC1/AC2/AC3).

### Specific functions chosen
- **`TaskDAO.getBySourceChatSession(sessionId)`** — find existing draft task linked to this session. Its docstring explicitly names "the autosave seam (clone/index.ts:406) to decide whether to create a new draft row or update the title". Use this, NOT `listByStatus('draft')` (which doesn't filter by session).
- **`TaskDAO.insert({...})`** — create new draft row. The DAO defaults `task_spec='{}'`, `authoring_resources='[]'`, `resources='[]'`, `skills='[]'`, `project_ids='[]'`, `version=1` — exactly the SG8 invariant (autosave must not touch these).
- **`TaskDAO.updateAutosave(id, name)`** — targeted UPDATE `name+updated_at` ONLY (SG8). Its docstring explicitly states "does NOT bump version and does NOT touch task_spec/resources/authoring_resources". Use this for subsequent turns, NOT `updateWithVersion` (which bumps version — wrong for autosave, right for the spec-field tool).
- **`AgentSessionDAO.updateSession(sessionId, { scope_id: taskId })`** — SG3 scope_id writer. Same primitive 03's `TasksService.createTask` uses (line 256); the spec calls it out by name.

### Test seam (pre-agreed)
POST `/api/clones/task-author/sessions/:id/chat` → drain SSE body → assert DB state. Mock `CloneRuntime` (avoids real LLM call; yields `{type:'text_delta',content}` + `{type:'result',sessionId}` per `MessageChunk` shape at `packages/providers/src/types.ts:89-108`) + `resolveCloneInfo` (avoids filesystem setup — `resolveCloneDefFromFs` falls through to `info.persona` when `fs.existsSync(personaPath)` is false). Real DB + `applySchema` + real `AgentSessionDAO` + real `TaskDAO` wired into the route.
