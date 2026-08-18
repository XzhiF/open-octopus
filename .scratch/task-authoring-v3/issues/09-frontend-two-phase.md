# 09 — 前端两阶段流：TemplatePicker + 编写骨架 + goal/ac 卡

## What to build
TaskModal 重构为两阶段（US1-6/14/D12/D15）。交互参照原型 VariantL（`app/tasks/prototype/page.tsx`，代码重写不复制）：模板页选任务类型 + Skill 组多选（🔒 提示、多选整合提示）+ org/projects；创建序列 = 先建会话后建任务；编写页顶栏锁定 badges + 预设弹窗（仅 org+projects）；右侧 goal/ac 卡：ghost 占位 → SSE 浮现 → 直编（spec-field source=user）→ 逐条确认（持久化）→ 入队门禁。

## Blocked by
04 — 创建扩展 + skill-groups 路由 · 05 — spec-field gates

## Status
ready-for-agent

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
