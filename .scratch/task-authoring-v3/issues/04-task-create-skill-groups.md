# 04 — 任务创建扩展 + skill-groups 路由（两阶段流服务端）

## What to build
模板页的服务端承接：GET /api/skill-groups（registry group 聚合 + 内置 default 空标记组）；POST /api/tasks 扩展（source_chat_session_id + task_type + skill_groups + preset → 建 draft + 建家目录 + 物化 plugin 目录 + SG3 scope_id 回写）；PUT 锁定（拒改 skill_groups/task_type → 409）；DELETE draft 联动 reap。创建顺序 = 先会话后任务（D15）。

## Blocked by
02 — TaskHomeService · 03 — PluginMaterializer

## Status
ready-for-agent

## Acceptance Criteria
- [ ] AC1: `server/src/routes/skill-groups.ts` GET /api/skill-groups?org= — registry type=skill 按 group 聚合；description 读 SKILL.md frontmatter（best-effort，读不到为空不报错，SW-BP13）；含内置 `{group:"default"}` 空标记组
- [ ] AC2: POST /api/tasks body 接受 `source_chat_session_id, task_type, skill_groups[], preset{org,projects}`；成功后：tasks 行 task_spec 含 task_type/skill_groups ∧ 家目录存在 ∧ skills/ 物化 ∧ sessions.scope_id == task.id
- [ ] AC3: 首轮 autosave 后**恰好一个 draft**（D15 回归锁定，SW-BP1）：source_chat_session_id 缺失/不匹配时走既有 autosave 路径但不得产生与本 task 重复的孪生
- [ ] AC4: PUT /:id 变更 skill_groups 或 task_type → 409（SW-BP9）；变更其他字段正常
- [ ] AC5: DELETE draft → 家目录 reap（非 draft 状态保留家目录）
- [ ] AC6: skill_groups 中的 skill 不写入 authoring_resources（避免双重注入，R5）

## Verification Method
**Verification type**: integration test（真 DB + 文件系统）

**Verification steps**:
```bash
cd packages/server && pnpm vitest run src/__tests__/tasks-v3-routes.test.ts
```
沿用 tasks-routes.test.ts 模式：POST 创建 → GET 响应断言 + SELECT tasks 断言 task_spec.skill_groups + readdir 家目录断言 skills/（R3 三方交叉）；PUT 改组→409；DELETE→readdir 不存在；GET skill-groups→含测试安装的组（经 ResourceManager API 装 fixture 组）。

**Pass criteria**: All verification steps PASS
**Failure handling**: Max 3 fix attempts, then mark SKIP with reason
