# 09 — core-pack: task-author SKILL.md 重写

## What to build
`.claude/skills/task-author/SKILL.md` 重写：教 agent 调 `/api/tasks` + `update_task_spec_field` 工具（不再 curl `/api/scheduler/jobs`）；task_spec schema curl recipes 改指向 /api/tasks；加 `load_resource_for_authoring` 用法（现场加载已安装非-cwd 资源）；加 authoring_resources vs resources(workspace) 区分指引。composition-task.yaml subunit_count 注入（SG5 配合）。

## Blocked by
03 (tasks service), 05 (spec-field tool)

## Status
done

## Acceptance Criteria
- [x] AC1: SKILL.md 教 /api/tasks + update_task_spec_field（无 /api/scheduler/jobs 引用）
- [x] AC2: load_resource_for_authoring 用法文档 — **按 peer course-correction 调整**：该 SDK 工具不存在（全仓 0 匹配），改为文档化其**实现机制**（spec-field `field=authoring_resources` 绑定 + augmenter prompt-inject），并显式标注"不要调用名为 load_resource_for_authoring 的工具"
- [x] AC3: authoring vs workspace 资源区分指引

## Verification Method
**manual checklist + integration**: grep SKILL.md 无 /api/scheduler/jobs；mock task-author 按 SKILL 调 /api/tasks+spec-field→draft 建+字段绑。Pass: 路由对+字段绑。

## Exploration

### Analog studied
v1 task-author SKILL.md（本文件被重写前的版本）+ `builtin-clones.ts` 的 `TASK_AUTHOR_PERSONA`（骨架，细节引用回 SKILL）。v1 教 agent curl `/api/scheduler/jobs`（`trigger_source='requirement'`）；v2 一等 `tasks` 表后，整个 API 面迁移到 `/api/tasks`，且新增 `update_task_spec_field`（对话中绑字段）+ `authoring_resources`/`resources` 两 scope 资源加载。

### Files modified (within boundary)
- **`.claude/skills/task-author/SKILL.md`** — 重写（version 2.0.0）。所有 curl 配方从 `/api/scheduler/jobs` 迁到 `/api/tasks`（9 个路由：POST/GET/GET:id/PUT/DELETE + spec-field/ready/abort/events）；新增"对话中绑定 spec 字段"（8 字段表 + spec-field curl + 409 retry + 双向 `@@spec_updated` 联动）、"资源加载 authoring vs workspace 两 scope"、"如何发现本 SKILL"（plugin 扫描 Read on demand，非注入）、task_spec→WorkflowConfig 物化指引（drop task_spec + subunit_count 注入 + 简单/复合分流 + known future-wiring）。
- **`packages/core-pack/workflows/composition-task.yaml`** — 注释精化（结构未变）。明确 `subunit_count` 注入路径：`materializeTaskSpecToConfig` 注 `workflow_chain[0].input_values.subunit_count`（number，type-cast 透传 Zod `record<string,string>`）→ engine 经 `pool.update` 合并进 `$vars.subunit_count` → `break_when` 读注入值非 simulate 默认；引用 `packages/engine/src/__tests__/loop-task-dispatch.test.ts`（镜像本模板形状，e2e 验证 pause-resume + break_when 收敛）。诚实标注 `goal`/`integration_prompt` 未注入（future-wiring）。

### NOT touched (boundary respected)
- `packages/server/*`（03/04/05/06/07/08 拥有）—— 含 `builtin-clones.ts` 的 `TASK_AUTHOR_PERSONA`（仍有一行 v1 `/jobs/:id/enqueue` 残留，但 persona 显式 "API curl 配方详见 task-author SKILL.md"，SKILL 是权威源；persona 更新属 07 augmenter territory，out of my lane，已在 final report 标注）。
- `packages/engine/*`（08）、`packages/shared`（01）、`packages/providers`（13）、`packages/server/src/db`（02+06）。

### Functions / contracts chosen (authoritative, from direct reads + 2 Explore agents)
- `update_task_spec_field` — **HTTP 端点** `POST /api/tasks/:id/spec-field`（routes/tasks.ts:157），**非** Claude SDK 原生工具（无 customTools 注册）。shared schema `{task_id, field, value}`（task.ts:85-93）；8 字段 enum `projects|skills|goal|ac|subunits|integration_goal|resources|authoring_resources`（task.ts:32-42）；返回 `{version}`；409 on 并发版本冲突→re-GET+retry。SKILL 教 agent 经 Bash curl 调（与 v1 curl scheduler jobs 同形）。
- `load_resource_for_authoring` — **全仓 0 实现**（仅 spec/issue 文档引用）。按 course-correction 不文档化为可调工具；改文档化其实现机制：spec-field `field=authoring_resources` 绑定（已工作）+ 07 的 `TaskAuthorSessionAugmenter` prompt-inject（进行中）。
- `materializeTaskSpecToConfig`（scheduler-service.ts:171）— drop task_spec（SG5✓）+ 复合注 `input_values.subunit_count`（SG5✓，number type-cast）+ 简单走 workflow_ref 直分发（SG9 `subunits.length>=2`）。**未**接 resources 参数（SG7 由 07 落地，SKILL 诚实标注）。
- autosave seam（routes/clone/autosave.ts）— 首 turn 建 draft（status=draft, source_chat_session_id, name=autoTitle）+ link scope_id（SG3）；后续 turn UPDATE name+updated_at ONLY（SG8 不 bump version 不碰 task_spec/resources）。返回 task_id 给 route（不 surface 给 agent；augmenter 注入是 07 的活）。
- composition-task.yaml break_when `$iteration >= $vars.subunit_count` — 收敛验证：engine 1-based（iter 1..N → N+1>=N break，跑 N 次）/ simulator 0-based（iter 0..N-1 → N>=N break，跑 N 次）。

## Verification Result
**PASS** — manual checklist + integration 全绿：

1. **grep SKILL.md 无 /api/scheduler/jobs** → 0 hits（AC1✓）。 broader `/api/scheduler` = 0，`trigger_source` = 0，`enqueue` = 0。`/api/tasks` = 26 hits。
2. **SKILL 文档化 update_task_spec_field** → 5 hits；spec-field endpoint 19 hits；8 字段表 + curl 配方 + 409 retry + `@@spec_updated` 双向联动（AC1✓）。
3. **SKILL 文档化 authoring vs workspace 资源区分** → authoring_resources 11 hits；两 scope 表 + "不要混"指引 + 资源 picker（AC3✓）。
4. **load_resource_for_authoring 用法** → 文档化为"spec-field `field=authoring_resources` + augmenter 注入"组合，显式标注非独立 SDK 工具（AC2✓，按 course-correction 调整）。
5. **composition-task.yaml subunit_count loop 正确** → break_when 读 `$vars.subunit_count`（line 51）；注释文档化 input_values→$vars 注入路径；`validate-workflow.js` → 1 passed 0 failed；engine `loop-task-dispatch.test.ts` 镜像形状 e2e 验证 pause-resume + 收敛。
6. **mock task-author per SKILL → /api/tasks + spec-field** → `tasks-routes.test.ts` 22/22 PASS（真实 better-sqlite3 + applySchema，API↔DB 双向 R3，写 DB R5）：POST /api/tasks 建 draft（201+DB row）、POST /:id/spec-field 合并字段+bump version+emit spec_field_update SSE、skills/projects 路由到列、PUT If-Match+409、/ready 简单=primary/复合=coordinator、abort+ws 清理、listener schedule→tasks.status 镜像+SSE、DELETE cascade-reap。**路由对+字段绑** 全确证。

Anti-fake-run: 真实 better-sqlite3 + applySchema；真实 TasksService/TaskDAO/SSEService wired into Hono app + app.request；data prefix E2E_TD_；assert DB row + SSE emit + version bump。无手动前置。
