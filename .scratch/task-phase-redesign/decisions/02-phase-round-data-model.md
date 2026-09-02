# 02 — Phase/Round 数据模型

Type: grilling
Status: resolved
Blocked by: ~~01~~（resolved）, ~~03~~（resolved）

## Question

phase/round 存哪：新表 task_phases/task_rounds vs 复用 schedules？一 phase = 一 schedule 还是 phase 表 + 每 round 一条 schedule/execution 记录？phase.workflow_ref 与 task 级 workflow_ref 的关系（task 级是否废除）？与现有 tasks 表/version 乐观锁/spec-field SSE 的联动。

## Answer

裁决 A（最小新增面），见 map D12：

| 实体 | 归宿 |
|---|---|
| Phase 定义 `{index,name,slug,spec_path,workflow_ref,input_values}` | `task_spec.phases[]`（JSON，同 subunits 模式；复用 spec-field/SSE/version/spec.json 快照协议；status **不落库**，service 层派生） |
| Round | 非实体：executions 行 + `phase_index/round_index` 列 |
| 人工决定 | **唯一新表** `task_phase_acceptances(task_id, phase_index, round_index, decision, feedback, decided_at)`——append-only 账本；phase 通过=存在 accepted 行，打回史=rejected 行序列 |
| Task↔ws | tasks 表加 `workspace_id` 列 |
| 调度 | 一 task 一 schedule 信封（ready 物化，origin=task 不变）；每 round = 该信封下新 execution；现有 `(schedule_id) WHERE status IN (triggered,running)` 唯一索引天然强制同 task 串行，phase 串行模型零额外代码 |
| task 级 workflow_ref | coding 停用（绑在 phases[i] 上）；列保留供 generic/v2 |

代价（已接受）：SQL 直查 phase 维度不可得（service 聚合）；换来四套现成链路（spec-field/SSE/乐观锁/快照）零重造。
