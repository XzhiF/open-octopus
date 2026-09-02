# 06 — 产物单向环：seed 下行 / collect 上行 / SSE 推送

## What to build
seed：round 开跑时物理拷贝 `{home}/.scratch/<date>/<slug>/ → ws/.scratch/<date>/<slug>/`（home 覆盖 ws 同名；实现挂 dispatchPhaseRound 内，照 copyTaskWorkflowsToWs）。collect：execution 终态回调回收 ws 该 slug 目录中执行侧改过的文件回 home，emit `TASK_ARTIFACTS_UPDATE_EVENT`；新增 SSE 事件 `phase_status_update`（phase 派生态变化时推）。写权纪律：spec* 文件 home 权威、issues/报告 ws 权威（collect 只上行执行侧 mtime 更新者）。

## Blocked by
05

## Status
done

## Acceptance Criteria
- [x] AC1: round1 开跑后 ws 内存在 seed 文件且内容=home 版；round2 前改 home spec-r2 → 开跑后 ws 反映新内容
- [x] AC2: 执行侧改 issues Status 终态后 home 同名文件更新，且 SSE `task_artifacts_update` 在事件流可收到
- [x] AC3: collect 不回传 home 权威文件（执行侧乱改 spec.md 不覆盖 home）
- [x] AC4: ws 后续被删，home 产物完整（防丢兜底断言）

## 实现备注 (2026-09-03)
- 验证：`packages/server/src/__tests__/tasks-v4-artifact-loop.test.ts` 4/4 绿；scoped 回归 `tasks-v4-artifact-loop + tasks-v4-ws-reuse + tasks-v3-*` = 105/105 绿；v3 envelope 无 seed/collect 负例已断言（底线）。
- collect 终态挂载=两条已有链路：`WorkflowExecutor.handleChainComplete`（首触/claim 轮，v4 打标门控）+ `TasksService.finalizePhaseRoundExecution`（dispatchPhaseRound 轮）。seed 挂 execute v4 分支（service.create 前，resolvePhaseRound 前移复用）+ dispatchPhaseRound 内。
- 票面提到的新 SSE `phase_status_update` 未在本票发射：全库无常量无消费者，其触发点（phase 派生态变化）属票 07 acceptance/deriveTaskView 链路 — 移交 07 定义契约一并发射。
- mtime 纪律：seed/collect 双向保留源 mtime，未改文件 re-collect 恒 no-op（避免假「更新」触发 SSE）。

## Verification Method
**Verification type**: integration test（真 fs tmp + SSE 监听）

**Verification steps**:
1. `packages/server/src/__tests__/tasks-v4-artifact-loop.test.ts`：seed→模拟执行写文件→collect 三段式；事件用 SSE bus 订阅断言
2. `pnpm -F @octopus/server test -- tasks-v4-artifact-loop`

**Pass criteria**: 全绿
**Failure handling**: Max 3 fix attempts, then mark SKIP with reason

## Exploration

**类比**: `copyTaskWorkflowsToWs`（workflow-executor.ts:31-51，home→ws 物理拷贝先例，调用点 execute step 10，非致命 try/catch）。信封 phases[] 的 specPath/specDir 由票 04 gateV4Phases 物化（绝对路径，tasks-service.ts:1055-1063）。wsPath 经 `getExecutionService(workspaceId).wsPath`（execution-service-registry，ws-reuse 测试已 mock 该口）。home = `TaskHomeService.homePath(id)`（os.homedir() 派生，HOME 覆盖可行）。SSE 订阅口 `sse.subscribe('taskpool', fn)`。

**终态回调选型**: 不选 TaskScheduleStatusListener（dispatchPhaseRound 路径根本不经过它，且注入 fs 依赖需改 wiring 文件=越权）。选票 05 的 finalizePhaseRoundExecution（dispatch 轮次）+ WorkflowExecutor.handleChainComplete 末端（首触/claim 轮次的已有终态链路）——两处都按「v4 打标执行」（executions.phase_index 非空 / isV4）门控，v3/generic/composite 零字节变化。

**需改文件**:
- 新 `services/tasks/task-artifact-sync.ts`（seedPhaseToWorkspace / collectFromWorkspace / batchRelPath）
- `services/scheduler/executors/workflow-executor.ts`：execute v4 分支 service.create 前 seed（resolvePhaseRound 扩展返回 phase 对象并前移复用）；handleChainComplete enforceRetention 前 collect+emit
- `services/tasks/tasks-service.ts`：dispatchPhaseRound service.create 前 seed；finalizePhaseRoundExecution opts +taskId/phaseIdx，末端 collect+emit TASK_ARTIFACTS_UPDATE_EVENT
- 新测 `__tests__/tasks-v4-artifact-loop.test.ts`

**写权纪律**: spec*.md home 权威（collect 见 home 同名即跳过）；其余文件（issues/报告）mtime 更新或新文件回 home；seed=home 全量覆盖 ws 同名（K16 编辑下一轮 seed 生效）。
