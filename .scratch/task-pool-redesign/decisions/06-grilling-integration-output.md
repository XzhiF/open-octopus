# 06 — 复合任务的整合产物是什么？

Type: grilling
Status: resolved
Blocked by: None (05 resolved)

## Question

05=B 定了 composition workflow 末尾有聚合节点。它产出什么？即"整合、编排有效果"的"效果"是什么形态。

### (i) 可配（integration_goal 声明）★推荐
`task_spec.integration_goal` 声明形态，composition workflow 末尾节点匹配：
- **synthesis（默认）**：`swarm-moa` 聚合 N 子结果 → 任务级综合报告（status + 摘要）。子任务若产代码则各自 PR。
- **merge**：合并 N 子工作区/分支 → 一个 combined PR/MR。
- **both**：先 moa 综合 + merge 交付。
复用 engine `moa`（synthesis）+ 一个 merge 节点（merge）。任务池本质是调度，默认 synthesis 最贴合。

### (ii) 固定 = synthesis（moa 报告）
所有复合任务整合 = moa 综合报告，不合并代码。最简，但不支持"一个交付 PR"场景。

### (iii) 固定 = combined PR
所有复合任务整合 = 合并分支成单一 PR。重，假设子任务都产代码。

## Recommendation

**(i) 可配**。默认 synthesis（moa，复用现成、调度中心、低风险）；merge 为 opt-in（子任务产代码时）。`integration_goal` 声明在 `task_spec`，composition workflow 末尾节点匹配。匹配你"整合、编排有效果"——效果形态随任务而变，不是一刀切。

## Answer
**(i) — configurable integration_goal.** User chose (i).

`task_spec.integration_goal` declares form; composition workflow's final node matches: **synthesis (default)** = `swarm-moa` aggregates N child results → task-level report (status + summary); **merge** = combine N child branches → combined PR/MR; **both** = moa synthesis + merge delivery. Reuses engine `moa` + a merge node. Default synthesis (scheduling-centric, low-risk); merge opt-in (when children produce code).
