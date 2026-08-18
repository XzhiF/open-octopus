# 09 — 前端两阶段流：TemplatePicker + 编写骨架 + goal/ac 卡

## What to build
TaskModal 重构为两阶段（US1-6/14/D12/D15）。交互参照原型 VariantL（`app/tasks/prototype/page.tsx`，代码重写不复制）：模板页选任务类型 + Skill 组多选（🔒 提示、多选整合提示）+ org/projects；创建序列 = 先建会话后建任务；编写页顶栏锁定 badges + 预设弹窗（仅 org+projects）；右侧 goal/ac 卡：ghost 占位 → SSE 浮现 → 直编（spec-field source=user）→ 逐条确认（持久化）→ 入队门禁。

## Blocked by
04 — 创建扩展 + skill-groups 路由 · 05 — spec-field gates

## Status
done

## Acceptance Criteria
- [ ] AC1: TaskModal draft 打开 → 先渲染 TemplatePicker；GET /api/skill-groups 渲染组列表（checkbox 多选，default 组含「不物化」说明）；选组后创建按钮可用
- [ ] AC2: 创建序列：POST /api/clones/task-author/sessions → POST /api/tasks{source_chat_session_id, task_type, skill_groups, preset} → 进入编写页；DB 恰一个 draft（D15）
- [ ] AC3: 编写页顶栏：类型 badge + 每组 🔒 badge（无下拉）+ 语境按钮弹窗（仅 org+projects 两项，无 skills，US14）
- [ ] AC4: goal/ac 卡：未绑定显示 ghost 占位；spec_field_update SSE 到达 → 浮现；直编走 spec-field source=user，保存后打「✏️ 已编辑」标且确认态重置
- [ ] AC5: 确认操作 → spec-field(goal_confirmed/ac_confirmed)；关闭弹窗重开确认态仍在（US6 持久化）
- [ ] AC6: 入队按钮：未全部确认 → disabled + 提示；全确认 → POST ready；409 时展示缺失项（服务端门禁兜底）
- [ ] AC7: chat 上方命令栏聚合所有选中组的 /命令；Skill 组信息不出现在右侧面板（D11）

## Verification Method
**Verification type**: browser E2E + manual checklist

**Verification steps**:
```bash
cd packages/web-app && pnpm playwright test e2e/task-authoring-v3.spec.ts -g "template|goalac"
```
E2E（扩展 task-domain-helpers）：模板页选 2 组 → 创建 → 断言 DB task_spec.skill_groups ∧ 家目录 ∧ 单 draft；SSE 触发浮现（sendTaskAuthorChat 模式）；直编 → DB version+1；确认 → 重开仍在；未确认入队 409。Manual：LLM 主动绑定 goal/ac 的话术与时机。screenshot 证据落 E2E_ARTIFACTS_DIR。

**Pass criteria**: All verification steps PASS
**Failure handling**: Max 3 fix attempts, then mark SKIP with reason

## Exploration

### Analog studied
- Closest existing feature: the v2 `AuthoringMode` in `packages/web-app/components/tasks/task-modal.tsx` (spec LEFT / task-author chat RIGHT, lazy session creation on first message, `onDraftResolved` adopts an autosaved draft). The interaction reference is `app/tasks/prototype/page.tsx` VariantL (lines 2927–3490) — code is rewritten, not copied (R6/throwaway).
- SpecPanel (`components/tasks/spec-panel.tsx`) is the analog for the SSE `spec_field_update` subscription + version-bump pattern + `[save draft]` PUT If-Match. The v3 goal/ac card reuses the SAME SSE subscription seam but writes via `POST spec-field source=user` (D7) instead of PUT.

### Files needing modification (all in packages/web-app — my lane)
- `lib/tasks-api.ts` — extend `CreateTaskInput` (+ `task_type`/`skill_groups`/`preset`), `createTask` body, `updateSpecField` (+ `source` param), `readyTask` (surface 409 `missing[]` via a typed error). NEW `listSkillGroups()` client for GET /api/skill-groups.
- `components/tasks/task-modal.tsx` — `resolveMode` routes `task===null` → v3 template; `task.status===draft && task_type set` → v3 workspace; v2 draft (no task_type) keeps the existing AuthoringMode (backward compat, do NOT break SpecPanel tests).
- NEW `components/tasks/authoring/template-picker.tsx` — phase 1 (task type cards + skill-group checkboxes + org/projects + 开始编写).
- NEW `components/tasks/authoring/goal-ac-card.tsx` — ghost → SSE emerge → inline edit (spec-field source=user → ✏️ 已编辑) → per-field confirm (goal_confirmed / ac_confirmed[]).
- NEW `components/tasks/authoring/authoring-workspace.tsx` — phase 2 (top bar: type badge + 🔒 skill-group badges + preset popup org+projects only; chat LEFT with command bar aggregating selected groups' /commands; OutputViewer RIGHT with GoalAcCard + enqueue checklist; enqueue gate 409 missing).

### Specific functions / contracts chosen
- `agentApi.createCloneSession(TASK_AUTHOR_CLONE)` — reuse (existing in `lib/agent/api.ts:232`, already used by AuthoringMode). Chosen because the D15 create sequence requires a session FIRST; do NOT use a different session-creation path.
- `createTask({org, source_chat_session_id, task_type, skill_groups, preset:{org,projects}})` — server route `POST /api/tasks` (routes/tasks.ts:123) reads exactly these body keys; `preset.org` OVERRIDES top-level `org` (tasks-service.ts:333). Send both to be safe.
- `updateSpecField(id, field, value, source)` — server route `POST /:id/spec-field` (tasks.ts:248) accepts `source:"user"|"agent"` (default agent); `source==="user"` → `setSpecNotice(@@spec_updated)` (tasks-service.ts:621). The server's `ServerSpecField` (tasks-service.ts:241) EXTENDS the shared enum with `"goal_confirmed" | "ac_confirmed"` — the frontend must send these field names for confirm actions (AC5), even though shared's `TaskSpecFieldSchema` omits them. Do NOT use PUT for direct edits (D7 says user-direct-edit goes through spec-field source=user).
- `readyTask(id)` — server `POST /:id/ready` (tasks.ts:269) returns 409 `{error, missing:[...]}` when the v3 gate fails (D18). The frontend must parse `missing` to show the gate gap (AC6). Do NOT swallow the 409 body.
- SSE subscription: `subscribeSSE(url, SPEC_FIELD_UPDATE_EVENT, handler)` from `lib/sse-manager` — same seam SpecPanel uses (spec-panel.tsx:127). The goal/ac card subscribes for `goal`/`ac`/`goal_confirmed`/`ac_confirmed` fields + bumps local version.

### Out of scope (other tickets)
- ArtifactViewerDialog / WorkflowLogDialog / MoaAdoptionPanel (US7/9/10/11 — tickets 10/11). The OutputViewer right panel is structured so those slots can be added later without rework; this ticket renders only the goal/ac card + enqueue checklist there.

## Verification Result

**Unit tests**: 44 new tests, all green (skill-groups-api 3, tasks-api 20 incl. 4 v3 cases, template-picker 6, goal-ac-card 8, authoring-workspace 7). Existing task-modal-spec-panel (10) + task-modal-composite (10) still pass — v2 legacy flow untouched.

**Typecheck**: all new/modified web-app files clean. (Pre-existing `app/tasks/prototype/page.tsx` `moSugChecked` typos + `task-modal-composite.test.tsx` fixture are throwaway/baseline — not this ticket's files.)

**E2E** (`pnpm playwright test e2e/task-authoring-v3.spec.ts -g "template|goalac"`): 6/6 PASS against the real server (:3001) + real web (:3000) + real SQLite:
- template-01: GET /api/skill-groups renders groups; default group shows 不物化 note; create enables on select (AC1)
- template-02: session-first → POST /api/tasks(v3) → AuthoringWorkspace; DB task_spec.task_type+skill_groups; home dir readdir; sessions.scope_id == task.id (AC2/D15)
- template-03: type badge + 🔒 skill-group badges (no dropdown); preset popup = org+projects only, no 技能 label (AC3/US14)
- goalac-01: ghost → SSE spec_field_update(goal) emerges; direct edit → spec-field source=user → DB version+1 + ✏️ edited mark (AC4/D7)
- goalac-02: confirm goal/ac → spec-field(goal_confirmed/ac_confirmed); close+reopen modal → confirm state persists (AC5/D18)
- goalac-03: enqueue disabled when unconfirmed; server readyTaskRaw → 409 missing=[goal_confirmed,ac_confirmed] (AC6 backstop)

**Environment note**: the running dev server was stale (pre-ticket-04 build — skill-groups route 404, v3 create returned empty task_spec). Rebuilt `@octopus/server` dist + restarted `PORT=3001 node packages/server/dist/index.js` to load committed route code. No server SOURCE was modified (ticket 06's lane).

