# 06 — 产物单向环：seed 下行 / collect 上行 / SSE 推送

## What to build
seed：round 开跑时物理拷贝 `{home}/.scratch/<date>/<slug>/ → ws/.scratch/<date>/<slug>/`（home 覆盖 ws 同名；实现挂 dispatchPhaseRound 内，照 copyTaskWorkflowsToWs）。collect：execution 终态回调回收 ws 该 slug 目录中执行侧改过的文件回 home，emit `TASK_ARTIFACTS_UPDATE_EVENT`；新增 SSE 事件 `phase_status_update`（phase 派生态变化时推）。写权纪律：spec* 文件 home 权威、issues/报告 ws 权威（collect 只上行执行侧 mtime 更新者）。

## Blocked by
05

## Status
ready-for-agent

## Acceptance Criteria
- [ ] AC1: round1 开跑后 ws 内存在 seed 文件且内容=home 版；round2 前改 home spec-r2 → 开跑后 ws 反映新内容
- [ ] AC2: 执行侧改 issues Status 终态后 home 同名文件更新，且 SSE `task_artifacts_update` 在事件流可收到
- [ ] AC3: collect 不回传 home 权威文件（执行侧乱改 spec.md 不覆盖 home）
- [ ] AC4: ws 后续被删，home 产物完整（防丢兜底断言）

## Verification Method
**Verification type**: integration test（真 fs tmp + SSE 监听）

**Verification steps**:
1. `packages/server/src/__tests__/tasks-v4-artifact-loop.test.ts`：seed→模拟执行写文件→collect 三段式；事件用 SSE bus 订阅断言
2. `pnpm -F @octopus/server test -- tasks-v4-artifact-loop`

**Pass criteria**: 全绿
**Failure handling**: Max 3 fix attempts, then mark SKIP with reason
