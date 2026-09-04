# 05 — dispatchPhaseRound + 同 task 复用 workspace

## What to build
新 dispatch 入口 `dispatchPhaseRound(task, phaseIdx, roundIdx, feedback?)`：有 `tasks.workspace_id` → 复用 ws 起新 execution（照 triggerChildStep:873-880 写法）；无 → createFromSpec 首建并回写绑定。配套排雷：ws 同名目录 rmSync 覆写→显式报错；task-origin ws retention 豁免（done 前不删）；executions 写 phase_index/round_index；branch 锚点 per-task（phase 不换支）。

## Blocked by
02, 04

## Status
done

## Acceptance Criteria
- [x] AC1: 第二次 dispatch 后 workspaces 表计数=1、ws 目录内容未重建（文件 mtime/inode 断言防 rmSync 回归）— tasks-v4-ws-reuse.test.ts `dispatches phase 2 on the BOUND ws`（ws count=1 + ino 恒定 + marker 文件存活 + executions 打标 (1,1)/(2,1)/(2,2)）+ `re-claim ... NO second createFromSpec`（execute() 复用分支 (1,2)）
- [x] AC2: 同信封并发第二触发被 active 唯一索引拒绝（返回可解释错误）— `AC2: concurrent second dispatch...`（TaskStatusConflictError「同一信封已有进行中的执行 — active 唯一索引…」+ 不泄漏槽位 + 裸 insert 双发 SQLITE_CONSTRAINT 直证索引）
- [x] AC3: 首建 ws 名不带 per-trigger 时间戳后缀语义变化外的重名覆写（新规则：仅首建拼名）— `throws on an existing same-name dir and PRESERVES its contents`（workspace.ts rmSync→显式 throw、内容保留、无第二行）；复用路径根本不取名不建目录（AC1 断言）
- [x] AC4: retention 扫描跳过未 done 的 task-origin ws — `AC4: retention exemption...`（maxRetain=0 全候选：bound-ws 存活 / 未绑定 ws 删除 / task→done 后下一轮回收）

## Verification evidence (2026-09-03)
- `npx vitest run tasks-v4-ws-reuse tasks-trigger-mutex` → 24✓
- 邻域 14 套（tasks-v3-*/tasks-v4-gate/workspace-service/workflow-executor-dispatch/composite/chain-complete/task-dispatch/scheduler-executors/service/engine/tasks-routes）→ 163✓/3skip
- 全量 server 套件失败集 diff（含/不含本票改动，stash 往返）= **逐条一致，零回归**；9 个失败文件均为基线/票 13 并发噪音（task-author 资产、harness、snapshot）
- ⑥ abort 对齐：`abort releases the slot but KEEPS the binding; the next dispatch runs on the same ws`✓（binding/文件/现场存活，槽位释放，再派发同 ws）
- dispatchPhaseRound 签名（票 07 消费）：`async dispatchPhaseRound(taskId, phaseIdx, roundIdx, feedback?): Promise<{scheduleId, schedExecId, executionId, workspaceId}>` — TasksService 上；roundIdx 由调用方（验收账本）决定；feedback→chain[0].input_values.feedback（fix-feedback-rN.md 文件=票 08 seed 职责）

## Verification Method
**Verification type**: integration test

**Verification steps**:
1. `packages/server/src/__tests__/tasks-v4-ws-reuse.test.ts`：双 round 触发 → ws/executions 行断言；模拟同名冲突报错路径
2. retention 单测：done 前/后豁免开关行为
3. `pnpm -F @octopus/server test -- tasks-v4-ws-reuse`

**Pass criteria**: 全绿
**Failure handling**: Max 3 fix attempts, then mark SKIP with reason

## Exploration

**Analog studied**: `triggerChildStep`(workflow-executor.ts:873-937) = "同 ws 起新执行" 复用写法（getExecutionService(wsId) → service.create(wsId,{workflow_ref,triggered_by,input_values}) → registerExternalCallbacks → fire-and-forget start）。ws 首次创建 = execute() 步骤 5-8（createFromSpec → insertScheduleWorkspace → updateExecutionWorkspace）。测试 harness 先例：workflow-executor-dispatch.test.ts（stub registry + stub WorkspaceService）、tasks-v4-gate.test.ts（v4 信封 fixture 结构）、workspace-service.test.ts:126-136（process.env.HOME=fakeHome → createFromSpec 真落盘 tmp）、tasks-trigger-mutex.test.ts（私有方法直调 `(engine as any).checkQueuedTasks()` 先例）。

**数据结构对齐（票 04 diff 已读）**：信封 config = `{format:'v4', phases:[{index,name,slug,specPath,specDir,workflowRef,inputValues}], workflow_chain:[{workflow_ref, input_values}]}`；chain[0]=phase1。`executions.phase_index/round_index`（v40 列，ExecutionDAO.insert/updateExecution 已支持）；`tasks.workspace_id`（v40，TaskRow 类型已带）。

**改动文件**（全在 ownership 内）：
1. `packages/server/src/services/workspace.ts` createFromSpec:330-332 — 同名 rmSync → 显式 throw（暗雷#3）
2. `packages/server/src/services/scheduler/task-ws-name.ts` — 注释更新：时间戳仅首建拼名（复用分支不取名）
3. `packages/server/src/services/scheduler/executors/workflow-executor.ts` execute() — v4 task-origin：`tasks.workspace_id` 有 → 跳过 createFromSpec 绑该 ws（#1）；无 → 首建 + 回写绑定（raw UPDATE，不 bump version，abortTask 同款系统事件写法）；create 后打标 phase/round（首执行 (1,1)；round=ws 内同 phase 已有 tagged 执行数+1）；enforceRetention — task-bound 且 task 未 done 豁免（#5）
4. `packages/server/src/services/tasks/tasks-service.ts` — 新增 `dispatchPhaseRound`（信封 chain[0] 改写 → insertTriggeredExecution（唯一索引=串行闸）→ 既有 ws 上 service.create+start → 打标 → 终态回调 finalize 释放槽位）；abortTask/abortChildSchedule 段加对齐注释（'cleaned'=运行槽位关闭，非现场作废；binding 不清）
5. 新测试 `packages/server/src/__tests__/tasks-v4-ws-reuse.test.ts`

**关键取舍**：
- **复用/回写仅对 `config.format==='v4'` 的 task-origin 简单信封生效** — v3/generic/composite 的 tasks.workspace_id 恒 NULL → 行为字节不变（集成回归底线；K13 v3 退役不改造）。
- **dispatchPhaseRound 走直接 create+start（照 triggerChildStep），不走 poller re-claim** — 唯一索引 insert 冲突=同步可解释错误（AC2）；execute() 的复用分支兜底 crash 后 re-claim（信封已被改写指向新 phase，打标键 `_phase_index/_round_index` 存 chain[0].input_values 管理键，恢复路径一致）。
- **④ 分支锚点**：K5 一 task 一信封 ⇒ scheduleId 恒定 ⇒ branch_prefix=`taskpool-{scheduleId}` per-task 天然成立；phase/round 执行跳过 createFromSpec ⇒ initWorktreesFromSpec 不跑 ⇒ 不换支零改动。已查证无 per-phase 换支代码路径。
- **⑥ 已核**：'cleaned' 唯一消费方=findRetainedWorkspaces 的反向过滤（completed/failed 才进 retention 候选）；无任何代码据 'cleaned' 删 ws 或清 binding。ws 唯一程序删除口=enforceRetention（由⑤豁免卡住）。
- **禁碰**：shared/db/derive-task-view/readyTask gate 段/core-pack。task-dao 无 workspace_id 方法 → raw UPDATE via getDb()（既有模式，不改 db/）。

**Status（进行中记录）**：基线绿 — tasks-trigger-mutex 16✓；tasks-v3-dispatch/gates + workflow-executor-dispatch + scheduler-executors + composite-dispatch 55✓/3skip。
