# 11 — core-pack composition workflow 模板 + task-author SKILL 内容

## What to build
core-pack：composition workflow 模板（coordinator-ws 无 projects）—— **G10：Loop over subunits**（每 iteration 一个 `task_dispatch` 节点，subunit[i] 经 input_values 喂入）+ 后置 swarm/moa 聚合节点（读 loop 累积 `$taskDispatchNode.output`）。task-author SKILL.md 内容（scheduler API + task_spec schema + task_spec→WorkflowConfig 物化 curl recipes）。`octo-workflow-dev`/`octo-workflow-test` skill 覆盖 task_dispatch 节点。

## Blocked by
02, 09

## Status
ready-for-agent

## Acceptance Criteria
- [ ] composition 模板 `validate-workflow.js` 0 errors（Loop + task_dispatch + moa，depends_on 链完整）
- [ ] Loop over subunits 收敛（break_when 满足）
- [ ] moa 聚合节点 depends_on task_dispatch loop
- [ ] task-author SKILL 含 API + schema + 物化指引
- [ ] octo-workflow-dev/test 覆盖 task_dispatch

## Verification Method
**Type**: manual + simulate
**Steps**: `node .claude/skills/octo-workflow-dev/scripts/validate-workflow.js <template>`（0 errors）；`octopus workflow simulate <template> --json`（happy path green，mock task_dispatch）；manual 检 SKILL 内容。
**Pass**: validate 0 errors + simulate green。**Fail**: max 3 then SKIP。
