# 09 — task-author clone + SKILL + route + 退役哨兵

## What to build
server + core-pack：builtin `task-author` CloneDef（persona + skills filter + cwd=project.source_path，多仓库主 cwd+余 refs）+ `task-author/SKILL.md`（scheduler API + task_spec schema + WorkflowConfig 物化 curl recipes）。route `/api/clones/task-author/sessions/:id/chat`（复用 generic clone 路由 clone/index.ts:241）。**退役 'taskpool-draft' 哨兵**（G7）：authoring chat 走真 clone session（sessions 表），`source_chat_session_id` 链 task，clone-session `scope_id=task_id`；删 `TASKPOOL_DRAFT_CHAT_SCOPE`；createJob 失败 rollback 清孤儿 session。

## Blocked by
01, 08

## Status
ready-for-agent

## Acceptance Criteria
- [ ] task-author clone 注册（builtin-clones）+ SKILL.md 安装
- [ ] chat 经 /api/clones/task-author/sessions/:id/chat（真 clone session）
- [ ] 无 'taskpool-draft' 假 workspace_id（FK 风险消除）
- [ ] createJob 失败 → 无孤儿 session
- [ ] task-author SKILL 含 scheduler API + task_spec→WorkflowConfig 物化指引

## Verification Method
**Type**: integration + manual
**Steps**: POST /api/clones/task-author/sessions/:id/chat → assert session 在 sessions 表 + scope_id=task_id；createJob 故意失败 → assert 无孤儿 chat session；manual 检 SKILL.md 内容。
**Pass**: assert PASS。**Fail**: max 3 then SKIP。
