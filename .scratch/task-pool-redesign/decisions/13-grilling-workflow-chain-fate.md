# 13 — 现有 workflow_chain（顺序、单 ws）去留？

Type: grilling
Status: resolved
Blocked by: None (05 resolved)

## Question

05=B 用 composition workflow + `task_dispatch`（多 ws）编排骨子。现有 PR #50 的 `workflow_chain`（`config.json` 数组，`handleChainComplete`/`triggerChildStep`/`resolveNextChainStep`，顺序、单 ws 内 engine-execution 父子）怎么办？

研究 01 确认：`workflow_chain` = 在**同一 ws 内**顺序跑 N 个 workflow（engine-execution 父子，非子 schedule）。这正好被 engine 的 **`sub_workflow`**（by-name 同 ws 引用，inline/linked，I/O mapping，`depends_on` 顺序）覆盖。

### (A) 废弃 workflow_chain ★推荐
- `sub_workflow`（同 ws 组合）+ `task_dispatch`（多 ws 组合）覆盖所有编排场景。
- 移除 `handleChainComplete`/`triggerChildStep`/`resolveNextChainStep`（story-walker #4 修过的脆弱路径）——统一编排在 engine 层，不再 scheduler/engine 两套。
- 迁移：现有 `workflow_chain` config → 表达成 composition workflow（`sub_workflow` 节点链 / `task_dispatch`）。

### (B) 保留为"简单顺序同 ws"快路径
不需写 composition workflow YAML，`config.json` 数组即可。低摩擦，但 scheduler/engine 两套编排并存（DRY）。

### (C) 折叠：`task_dispatch` 支持 same-ws 模式
统一进 composition，`task_dispatch` 加 same-ws 选项。

## Recommendation

**(A) 废弃**。`sub_workflow` + `task_dispatch` 已覆盖；`workflow_chain` 是 scheduler 层对 engine `sub_workflow` 的重复，且 PR #50 那套半接的 chain 代码脆弱（story-walker #4 修过）。统一编排在 engine 层（DRY）。是 ADR-0008 的直接推论（不另开 ADR，记入 spec Decisions）。

## Answer
**(B) — keep workflow_chain as the simple sequential same-ws fast path.** User chose (B) (overrode the (A) recommendation).

`workflow_chain` (config.json array, no YAML needed) stays for low-friction simple sequential same-ws cases. Coexists with: composition workflow + `task_dispatch` (multi-ws orchestrated) and `sub_workflow` (same-ws by-name, in a workflow). Doc when-to-use: simple seq same-ws → `workflow_chain`; composite multi-ws → composition; same-ws compose-in-workflow → `sub_workflow`. The story-walker #4 fixed chain code (`triggerChildStep`/`resolveNextChainStep`) stays as the fast-path mechanism.
