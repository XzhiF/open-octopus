# 04 — 任务创建扩展 + skill-groups 路由（两阶段流服务端）

## What to build
模板页的服务端承接：GET /api/skill-groups（registry group 聚合 + 内置 default 空标记组）；POST /api/tasks 扩展（source_chat_session_id + task_type + skill_groups + preset → 建 draft + 建家目录 + 物化 plugin 目录 + SG3 scope_id 回写）；PUT 锁定（拒改 skill_groups/task_type → 409）；DELETE draft 联动 reap。创建顺序 = 先会话后任务（D15）。

## Blocked by
02 — TaskHomeService · 03 — PluginMaterializer

## Status
done

## Acceptance Criteria
- [x] AC1: `server/src/routes/skill-groups.ts` GET /api/skill-groups?org= — registry type=skill 按 group 聚合；description 读 SKILL.md frontmatter（best-effort，读不到为空不报错，SW-BP13）；含内置 `{group:"default"}` 空标记组
- [x] AC2: POST /api/tasks body 接受 `source_chat_session_id, task_type, skill_groups[], preset{org,projects}`；成功后：tasks 行 task_spec 含 task_type/skill_groups ∧ 家目录存在 ∧ skills/ 物化 ∧ sessions.scope_id == task.id
- [x] AC3: 首轮 autosave 后**恰好一个 draft**（D15 回归锁定，SW-BP1）：source_chat_session_id 缺失/不匹配时走既有 autosave 路径但不得产生与本 task 重复的孪生
- [x] AC4: PUT /:id 变更 skill_groups 或 task_type → 409（SW-BP9）；变更其他字段正常
- [x] AC5: DELETE draft → 家目录 reap（非 draft 状态保留家目录）
- [x] AC6: skill_groups 中的 skill 不写入 authoring_resources（避免双重注入，R5）

## Verification Method
**Verification type**: integration test（真 DB + 文件系统）

**Verification steps**:
```bash
cd packages/server && pnpm vitest run src/__tests__/tasks-v3-routes.test.ts
```
沿用 tasks-routes.test.ts 模式：POST 创建 → GET 响应断言 + SELECT tasks 断言 task_spec.skill_groups + readdir 家目录断言 skills/（R3 三方交叉）；PUT 改组→409；DELETE→readdir 不存在；GET skill-groups→含测试安装的组（经 ResourceManager API 装 fixture 组）。

**Pass criteria**: All verification steps PASS
**Failure handling**: Max 3 fix attempts, then mark SKIP with reason

## Exploration

**Analog studied**:
- `tasks-routes.test.ts` + `tasks-v3-gates.test.ts` — integration test pattern (Hono `app.request` + in-memory better-sqlite3 + `applySchema` + SSE collector + R3 API↔DB↔fs cross-validation).
- `plugin-materializer.test.ts` + `07-resource-loading.test.ts` — ResourceManager fixture pattern: temp `basePath` + `rm.registerInstalled({name,type,group})` + write `SKILL.md` at `basePath/installed/skills/{group}/{name}/`.
- `archive.ts` `/skill-groups` — existing group listing via `fs.readdir`; I instead use `ResourceManager.list({type:"skill",installed:true})` per spec D3 (registry is the source of truth).

**Files to modify**:
1. `packages/server/src/routes/skill-groups.ts` — NEW: `GET /api/skill-groups` (registry skill aggregation by group + best-effort SKILL.md frontmatter `description` + built-in `default` empty-marker group, D17).
2. `packages/server/src/services/tasks/tasks-service.ts` — MODIFIED: extend `createTask` (task_type/skill_groups/preset → task_spec + `createHome` + `materializeGroups` + scope_id link); extend `updateTask` (SW-BP9 lock: reject skill_groups/task_type change → 409; merge-preserve when PUT omits them); extend `deleteTask` (draft → `reapHome`); constructor accepts optional `taskHomeService`/`pluginMaterializer` (tail-appended, SW-BP15).
3. `packages/server/src/routes/tasks.ts` — MODIFIED: POST route passes v3 body fields; PUT route passes raw task_spec to service (lock check needs pre-parse raw values).
4. `packages/server/src/index.ts` — MODIFIED: wire `/api/skill-groups` route + inject TaskHomeService/PluginMaterializer into TasksService.
5. `packages/server/src/__tests__/tasks-v3-routes.test.ts` — NEW integration test (AC1-AC6).

**Functions chosen**:
- `TaskHomeService.createHome(id)` / `reapHome(id)` / `homePath(id)` — home skeleton + reap (ticket 02, do NOT follow junctions SW-BP14). Use these because home lifecycle is ticket 02's lane; reuse, don't re-implement.
- `PluginMaterializer.materializeGroups(home, groups)` — per-task plugin links (ticket 03). Use this because "default" skip (D17) + junction/copy fallback + idempotency are already owned here.
- `ResourceManager.list({ type:"skill", installed:true }).resources` + `.group`/`.name`/`.installPath` — aggregate skill groups. Do NOT use `archive.ts` fs.readdir path (registry is the source of truth, D3).
- `AgentSessionDAO.updateSession(sessionId, { scope_id: id })` — already used in `createTask`; keep for the scope_id writeback (SG3, D15).
