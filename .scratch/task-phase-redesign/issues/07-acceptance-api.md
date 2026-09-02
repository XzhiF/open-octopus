# 07 — acceptance API：通过/打回/auto_advance/入 archiving

## What to build
`POST /api/tasks/:id/acceptance {phase_index, round_index, decision, feedback?}`：写账本（校验当前派生态=awaiting_review、round 匹配最新，否则 409）→ accepted 且 autoAdvance∧i<n → dispatchPhaseRound(i+1,1)；accepted∧i=n → task 进 archiving 并触发归档（票 08 接线，此处可先置状态）；rejected → 反馈产物化 `fix-feedback-r{N}.md` 入 slug 目录并 dispatchPhaseRound(i, round+1)。GET /:id 返回 phases 视图（票 03 派生）。

## Blocked by
03, 05, 06

## Status
done

## Acceptance Criteria
- [x] AC1: accepted 行落账 + 返回体 next_action=dispatched(next_phase) 或 archiving
      （tasks-v4-acceptance > AC1：账本恰一行 accepted/feedback NULL、phase i+1 round 1 落同一 ws
      并打标、next_action='dispatched'；末 phase → 'archiving' + 持久态 archiving + 票 08 hook 命中、
      不派发、completed_at 仍 NULL）
- [x] AC2: autoAdvance=false 时 accepted 不自动开跑，next_action=awaiting_manual_trigger
      （账本仍落行；stub create 零调用；phase2 保持 pending；持久态对齐派生 'ready'）
- [x] AC3: rejected → feedback 文件生成、round+1 执行开跑、账本两行可追溯
      （fix-feedback-r1.md 落 home 批次目录且被同次 seed 带进 ws；round=账本 rejected 行数+1；
      reject→reject→accept 链验证 r2/r3 轮号与 3 行账本 + rounds[] 历史）
- [x] AC4: 非 awaiting_review 态调用 → 409；重复 accepted 同 (phase,round) → 409（已选 409 并测试）
      （另覆盖 round 不匹配 / phase 不存在 / 非 v4 → 409、未知任务 404、body 非法与 rejected 缺
      feedback → 400、派发失败时账本保留）
- [x] AC5: spec-field 支持 field=phases（乐观锁 version bump）
      （整数组 PUT 替换、version 1→2→3、spec_field_update SSE、空数组/非法 slug → 400 且不写库；
      与票 13 SKILL 的 `field=phases` 教学对齐）

## Verification Method
**Verification type**: integration test

**Verification steps**:
1. `packages/server/src/__tests__/tasks-v4-acceptance.test.ts`（真 DB + stub dispatch 到 in-process 执行）
2. `pnpm -F @octopus/server test -- tasks-v4-acceptance`

**Pass criteria**: 全绿
**Failure handling**: Max 3 fix attempts, then mark SKIP with reason

## Exploration

**类比研究对象**：`dispatchPhaseRound`（票 05，tasks-service.ts:1411）+ 其测试
`tasks-v4-ws-reuse.test.ts`（registry stub / 真 DB / tmp HOME 三件套）；路由侧类比
`triggerTask` / `abortTask` 的「状态写走 raw UPDATE、不 bump version」系统事件写法，
以及 `tasks-v4-gate.test.ts` 的 Hono + 注入 TaskHomeService(tmp baseDir) 夹具。

**需改文件**（全部在本票 ownership 内）：
- `packages/shared/src/types/task.ts` — TaskStatusSchema 补 `awaiting_review`/`archiving`
  （widening，DB v40 CHECK 已有，票 03 登记欠账）；TaskSpecFieldSchema 补 `phases`；
  `validateSpecFieldValue` 加 `phases` 分支（taskPhaseSchema 数组、整组 PUT 语义）；
  新 `PHASE_STATUS_UPDATE_EVENT` + `phaseStatusUpdatePayloadSchema` + `TaskPhaseStatusSchema`
  （SSE 常量既有模式 = shared/types/task.ts，票 11/12 从 shared 导入）。
- `packages/shared/src/__tests__/task-domain-schema.test.ts` — 期望集扩两态 + phases 字段。
- `packages/server/src/services/tasks/tasks-service.ts` — 新 `acceptance()`、
  `getTask` 嵌入 derived 视图、`updateSpecField` 的 `phases` 分支、listTasks 状态扫描补两态、
  `beginArchiving` + `setArchivingHook`（票 08 接线点，本票只置态）。
- `packages/server/src/routes/tasks.ts` — `POST /:id/acceptance`。
- 新测 `packages/server/src/__tests__/tasks-v4-acceptance.test.ts`。
- **不改**：derive-task-view.ts（票 03）、task-artifact-sync.ts（票 06）、db/、workflow-executor、web。

**选定函数**：验收校验与返回体用 `deriveTaskView(task, execs, accs)`（票 03 唯一真相，
不重实现矩阵）；用 `phaseView.status==='awaiting_review' ∧ awaitingRound===round_index` 做 409 判定
（**phase 级**而非 task 级 — 见下方活体交互）；账本 `AcceptanceDAO.insert/listByRound/listByPhase`；
重试轮号 = 插入后「该 phase rejected 行数 + 1」（prompt 指定）；派发 `dispatchPhaseRound(taskId, i(+1), r, feedback?)`。
executions 取数（deriveView）= 任务的 **schedules 链**：
`executions WHERE phase_index IS NOT NULL AND id IN (SELECT se.execution_id FROM schedule_executions se
JOIN schedules s ON s.id=se.schedule_id WHERE s.origin_type='task' AND s.origin_id=?)`。
初版按 `tasks.workspace_id` 取数，被 AC4「ws 被带外删除」用例证伪（round 会集体隐身 ⇒ 人再也无法验收/推进），
故改走 S2 归属链（首触发路径 workflow-executor.ts:458 与 dispatchPhaseRound 都写 se.execution_id）；
child loop/swarm 执行 phase_index 为 NULL → 天然排除。

**发现的活体交互（本票处置）**：
1. 首 phase 的 round 走真实 claim→`WorkflowExecutor.handleChainComplete`→
   `TaskScheduleStatusListener` 镜像，会把 tasks.status 持久写成 `done`/`failed`
   （后续 round 走 dispatchPhaseRound，不碰持久态）。故 409 校验必须读 **phase 级派生态**
   （phaseViews 不受持久 done 影响），且 acceptance 引起新 round 开跑时把持久态归一为
   `running`（否则 `abortTask` 从 done 会 409，round 无法中止）；autoAdvance=false 归一 `ready`
   （与 derive 的「accepted 中段等待下一轮 → ready」一致）。
2. TaskStatusSchema widening 后 `packages/web-app/lib/task-board.ts:40`
   `TasksByStatus = Record<TaskBoardStatus, Task[]>` 的字面量不再穷尽 → **web typecheck 会红**，
   由票 11（新「待验收」列）闭合；server/shared 无同类穷尽点（已 grep 确认）。
3. autoAdvance=false 后「人工起下一 phase」今天没有可用入口：`POST /:id/trigger` 只认 parked draft
   信封，且把它改 async 会破 v3 同步测试契约（票 04/05 已定）。本票按 AC2 只返回
   `next_action=awaiting_manual_trigger`，入口留待票 08/11 裁决（不越界发明端点）。

## 契约（供票 11/12 消费）

**POST /api/tasks/:id/acceptance**  body `{phase_index:number≥1, round_index:number≥1,
decision:"accepted"|"rejected", feedback?:string}`（rejected 必填 feedback，缺 → 400）
→ 200 `{ task: <GET /:id 同形状（含 derived）>, acceptance_id: <账本行 id>,
next_action: "dispatched"|"archiving"|"awaiting_manual_trigger",
dispatch?: { schedule_id, execution_id, workspace_id, phase_index, round_index } }`；
（「下一个 phase」按 phaseViews 的**位置**取，不是 index+1 — 作者重排过编号也走得通。）
404 任务不存在；409 派生态非 awaiting_review / round 不匹配 / 该轮已验收（重复提交）/ 非 v4；400 body 非法。

**GET /api/tasks/:id** 新增 `derived` 字段 = `deriveTaskView` 输出原样
`{ taskStatus, isV4, phaseViews:[{ index,name,slug,workflowRef,status,rounds:[{roundIndex,exec,state,decision}],currentRound,acceptedRound,awaitingRound }] }`
（v3 为 `{taskStatus:<持久态>, isV4:false, phaseViews:[]}`）。

**SSE `phase_status_update`**（channel `taskpool`，常量 `PHASE_STATUS_UPDATE_EVENT`）
payload `{ task_id, phase_index, status: "pending"|"running"|"awaiting_review"|"accepted", round_index }`。
发射点（仅 acceptance 引起的转换）：accepted → `{i,'accepted',r}`；随后 autoAdvance 派发 → `{i+1,'running',1}`；
rejected 派发 → `{i,'running',r+1}`。末 phase accepted 另发 `task_status{status:'archiving'}`。
round 终态 → awaiting_review 的发射**不在本票**（WorkflowExecutor/finalize 属票 06，未添加）。
