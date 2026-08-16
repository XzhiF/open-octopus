# 03 — server TaskDispatchPort impl + 跨边界 pause-resume 桥

## What to build
server：TaskDispatchPort 具体 impl，注入 ExecutorFactoryContext（createSessionFn 先例，executor-config.ts:147）。`dispatchChildSchedule(subunit)` → 创建子 schedule（distinct schedule_id 避 idx_sched_execs_unique_active）+ createFromSpec 独立 ws + 跑 sub-workflow_ref。子 schedule 完成（handleChainComplete 或新 child-complete 回调）→ resume 父 task_dispatch 节点 + 传 output_mapping。concurrency cap（MAX_PARALLEL_WORKSPACES）在 port 层处理。

## Blocked by
02

## Status
ready-for-agent

## Acceptance Criteria
- [ ] port.dispatchChildSchedule 创建独立子 schedule + ws（不撞 unique_active）
- [ ] 子完成 → resume 父节点 + output 流入
- [ ] 并发超 cap → 子 schedule 排队（不 fatal）
- [ ] 无 in-memory Promise 泄漏（pause-resume 持久化，进程重启可恢复）

## Verification Method
**Type**: integration
**Steps**: composition wf 含 1 task_dispatch → mock 子 schedule 立即完成 → assert 父 resume + 下游聚合节点收到 $taskDispatchId.output；模拟进程重启 → assert 恢复。
**Pass**: assert PASS。**Fail**: max 3 then SKIP。
