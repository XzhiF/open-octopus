# 02 — engine task_dispatch executor + pause-resume await

## What to build
engine 包：`TaskDispatchExecutor`（implements NodeExecutor）+ `TaskDispatchConfig`（executor-config.ts，含注入的 TaskDispatchPort）+ executor-factory switch case "task_dispatch"。节点 execute 调 `port.dispatchChildSchedule(subunit)` → **pause-resume**（复用 interaction/approval 基建，节点持久化"等待子 schedule"，不阻塞 event loop）；resume 回调 applyOutputsMapping 写 `$taskDispatchId.output`（sub-workflow.ts:247-255 先例）。

## Blocked by
01

## Status
ready-for-agent

## Acceptance Criteria
- [ ] task_dispatch 节点 Zod parse + executor-factory 返回 TaskDispatchExecutor
- [ ] execute 调 port.dispatchChildSchedule + pause（不 throw、不阻塞 loop）
- [ ] resume 回调 applyOutputsMapping 写 nodeResults（下游可读 $taskDispatchId.output.key）
- [ ] 构建期验证：resume API 支持 server-内部触发（非仅人 SSE）——若不支持，记 ADR 补丁

## Verification Method
**Type**: unit + integration
**Steps**: unit — mock TaskDispatchPort，assert dispatch + pause + resume + output mapping；integration — mock 子 schedule 完成 → assert 父节点 resume + output 写入。
**Pass**: assert PASS。**Fail**: max 3 then SKIP。
