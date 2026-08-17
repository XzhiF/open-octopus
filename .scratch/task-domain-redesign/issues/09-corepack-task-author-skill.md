# 09 — core-pack: task-author SKILL.md 重写

## What to build
`.claude/skills/task-author/SKILL.md` 重写：教 agent 调 `/api/tasks` + `update_task_spec_field` 工具（不再 curl `/api/scheduler/jobs`）；task_spec schema curl recipes 改指向 /api/tasks；加 `load_resource_for_authoring` 用法（现场加载已安装非-cwd 资源）；加 authoring_resources vs resources(workspace) 区分指引。composition-task.yaml subunit_count 注入（SG5 配合）。

## Blocked by
03 (tasks service), 05 (spec-field tool)

## Status
ready-for-agent

## Acceptance Criteria
- [ ] AC1: SKILL.md 教 /api/tasks + update_task_spec_field（无 /api/scheduler/jobs 引用）
- [ ] AC2: load_resource_for_authoring 用法文档
- [ ] AC3: authoring vs workspace 资源区分指引

## Verification Method
**manual checklist + integration**: grep SKILL.md 无 /api/scheduler/jobs；mock task-author 按 SKILL 调 /api/tasks+spec-field→draft 建+字段绑。Pass: 路由对+字段绑。
