# 04 — server: autosave seam + scope_id writer

## What to build
`clone/index.ts:406` autosave seam（auto-title 块后、done SSE 前，cloneName==='task-author' 门控）：首 turn 若无关联 tasks 行→建(status=draft, source_chat_session_id, title=auto)；每轮 update title+updated_at（targeted UPDATE，不 bump version、不碰 task_spec/resources，SG8）。`POST /api/tasks` + autosave seam 都 `updateSession(scope_id=task.id)`（SG3）。

## Blocked by
03 (tasks service)

## Status
ready-for-agent

## Acceptance Criteria
- [ ] AC1: task-author 首轮流后 tasks 行存在(status=draft, source_chat_session_id, title=auto)
- [ ] AC2: 每轮 title+updated_at 更新；version 不 bump；task_spec/resources 不被 autosave 改
- [ ] AC3: sessions.scope_id=tasks.id（autosave + POST /tasks 都设）

## Verification Method
**integration**: mock task-author 首轮流 → DB 断 tasks 行+scope_id；二轮流 → title 变+version 不变。Pass: 行存在+scope_id 正确+version 稳定。
