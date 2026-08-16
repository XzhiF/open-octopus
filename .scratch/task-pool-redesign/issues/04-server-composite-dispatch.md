# 04 — server composite dispatch（coordinator-ws + N 子 schedule + 聚合）

## What to build
composite 任务 dispatch：coordinator-ws（createFromSpec 无 projects）run composition wf → task_dispatch fan-out N 子 schedule（各 createFromSpec 独立 ws + sub-workflow_ref，vars/skills 各自）→ engine DAG/Loop 编排 → 末尾 swarm/moa 聚合节点（读 $taskDispatchId.output，integration_goal 驱动 synthesis/merge）。父 schedule 聚合状态：任一子 running→父 running；全 done+聚合→父 done；任一子 failed→父 failed。

## Blocked by
03

## Status
ready-for-agent

## Acceptance Criteria
- [ ] composite dispatch → coordinator-ws + N 独立子 ws + 聚合节点
- [ ] 父卡聚合状态正确（running/done/failed）
- [ ] 同 wf 不同 vars = Loop over var-sets（D7）
- [ ] 聚合节点收到各子 output

## Verification Method
**Type**: integration
**Steps**: composite config（3 subunits，integration_goal=synthesis）→ dispatch → mock 子完成 → assert DAG 顺序 + 聚合 output + 父 status=done；一子失败 → assert 父 failed。
**Pass**: assert PASS。**Fail**: max 3 then SKIP。
