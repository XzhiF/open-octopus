# 11 — 复合任务 N 子工作空间在 /tasks 看板怎么展示？

Type: grilling
Status: resolved
Blocked by: None (05 resolved)

## Question

05=B：复合任务 = N 子 schedule（各 own ws）+ 聚合节点。看板怎么展示这 N 个子？

### (i) 父卡 + drill-down ★推荐
复合任务在看板是 **1 张父卡**（按聚合状态落 running/done 列）。点开 → 展开 drawer/modal：composition DAG 图 + N 子卡（每子 ws + workflow_ref + status）+ 聚合节点状态。
- 看板保持干净（任务为单元，1 任务 1 卡）；详情按需。
- 父卡聚合状态：任一子 running → 父 running；全部 done + 聚合完成 → 父 done。
- 匹配 05=B "任务是 wrapper" 模型。

### (ii) 扁平：每子 ws 1 张卡
N 子各 1 卡，标 link 到父。平铺可见，但看板卡数膨胀（大项目 N×M 卡）。

### (iii) 分组栈：父 + N 子嵌套成栈
列内父卡下嵌套 N 子卡。中间态，介于 (i)(ii)。

## Recommendation

**(i) 父卡 + drill-down**。看板以任务为单元（1 任务 1 卡），N 子详情按需展开（composition DAG + 子状态 + 聚合）。父卡聚合状态由 SSE `schedule_status` 推（父 + 各子）。匹配 "任务是 wrapper"。

## Answer
**(i) — parent card + drill-down.** User chose (i).

1 task = 1 card on the board (aggregate status in running/done). Click → drawer/modal: composition DAG + N child cards (each ws + workflow_ref + status) + integration node. Parent aggregate status: any child running → parent running; all done + integration complete → parent done. SSE `schedule_status` pushes parent + each child. Board stays clean (task = wrapper unit).
