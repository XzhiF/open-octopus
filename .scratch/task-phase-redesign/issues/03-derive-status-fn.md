# 03 — 状态派生纯函数 deriveTaskView（唯一真相）

## What to build
server 层纯函数：输入 task+executions+acceptances → 输出 `{taskStatus, phaseViews[{status, rounds[{exec, state}], acceptedRound}]}`。不变量：v4 task 永不返回 failed；round 终态(成/败)→无该轮 acceptance 记录时 phase=awaiting_review；accepted 行→phase accepted；exec 在跑→running。

## Blocked by
01（TaskPhase 类型）

## Status
done

## Exploration

**Analog studied**: none exists for state derivation (tasks-service only mirrors persisted `task.status`; #54 病根 = 镜像竞态, hence K3 派生不存). Conventions taken from: `acceptance-dao.ts` (ledger row ordering phase/round/decided_at/id — derive must be order-independent and re-sort defensively), shared `taskSpecSchema`/`TaskPhase` (票 01, format==='v4' discriminator), `db/types.ts` v40 columns (`ExecutionRow.phase_index/round_index`, `TaskPhaseAcceptanceRow`).

**Exec status vocabulary** (shared `ExecutionStatusSchema`, workspace.ts): terminal = completed | completed_with_failures | failed | rejected | cancelled | skipped; in-flight = pending | running | paused | pending_approval | pending_resume; unknown → treated in-flight (conservative: never fabricate awaiting_review from an unrecognized status).

**Key gap found**: shared `TaskStatusSchema` does NOT include `awaiting_review`/`archiving` (DB CHECK v40 does; shared edit is outside 票 03's lane). → derive defines its own `DerivedTaskStatus` union; taskStatus output typed `TaskStatus | DerivedTaskStatus`; legacy passthrough mirrors `task.status` verbatim (v3 `failed` stays legal — K3 no-failed is v4-only).

**Files to create (ownership)**: `packages/server/src/services/tasks/derive-task-view.ts` + `__tests__/derive-task-view.test.ts` ONLY. No edits to tasks-service/scheduler/dao (票 04 concurrent).

**Decision matrix pinned** (task rules, priority top-down): aborted > done (persisted 终态镜像) > any in-flight phase exec → running > last phase accepted → archiving > any phase awaiting_review > ready. Phase rules: acceptedRound ≠ null → accepted; any in-flight round → running; latest round terminal & its decision null → awaiting_review; else pending (covers not-started + rejected-latest pre-dispatch window). draft→ready in derived view (board 草稿 column reads persisted status, 票 11).

**Exports for 票 07**: `deriveTaskView(task, executions, acceptances) → {taskStatus, isV4, phaseViews[{index,name,slug,workflowRef,status,rounds[{exec,state,decision}],currentRound,acceptedRound,awaitingRound}]}`; input Picks (`DeriveTaskInput` etc.) let 07 pass full DB rows; `awaitingRound`/`currentRound` serve its 409 round-match check.

## Acceptance Criteria
- [ ] AC1: 参数化单测覆盖全状态矩阵（≥12 组合：跑中/成/败 × accepted/rejected/无 × 首/中/末 phase）
- [ ] AC2: 不变量断言：输出枚举中 taskStatus ∈ {ready,running,awaiting_review,archiving,done,aborted}，永不为 failed
- [ ] AC3: 纯函数零 IO（不 import dao）

## Verification Method
**Verification type**: unit test

**Verification steps**:
1. `packages/server/src/services/tasks/__tests__/derive-task-view.test.ts` it.each 状态表
2. `pnpm -F @octopus/server test -- derive-task-view`

**Pass criteria**: 全绿且覆盖率报告该文件分支 ≥95%
**Failure handling**: Max 3 fix attempts, then mark SKIP with reason
