# 票03 落地后的新契约(测试重写基线)

这份文件是 ADR-0021 票03 的**行为基线**:重写既有测试时照此判断「断言应该变成什么」,
而不是「怎样让它变绿」。若某条断言按此契约应改写成更弱的形式,那是产品 bug,报告它。

## 数据形状

| 事实 | 旧位置 | 新位置 |
|---|---|---|
| 任务何时该跑 | 私有 `schedules` 行(status='draft' 停放 / queued + scheduled_at) | `tasks.trigger_mode / trigger_at / cron_expression / cron_timezone / trigger_enabled / next_fire_at / last_fired_at` |
| 一次运行 | `schedules` 信封行 + `schedule_executions` + `executions`(经 join 桥) | `executions` 一行:`task_id` 直连,`status='pending'` = 已排队,`parent_id='0'` = 根 |
| 一任务一实例 | ~10 处守卫 + 借 `schedule_executions` 的 partial UNIQUE | `ux_exec_task_active`(partial UNIQUE over 根执行,谓词 `status NOT IN (终态)`) |
| 工作区属于谁 | `workspaces.source_schedule_id → schedules.origin_id` 反查 | `workspaces.task_id` |
| composite 子单元 | 子 `schedules` 行(origin_role='subunit')+ config 里的 `parent_task_dispatch` 标记 | 子 `executions` 行(`parent_id` = 派发方执行,`task_id` = 父任务),父回填**派生**自 parent_id + 父的 running 节点 |
| 任务状态推进 | `TaskScheduleStatusListener` 镜像 schedules.status | task-lifecycle job 自己写(launch→running,终态→done/failed;v4 不写 K3) |
| 孤儿 | `orphan-reaper.ts` 扫 origin_id 指不到活任务的 schedules 行 | job 的 reconcile 扫 executions 活行 + `hasLiveEngine` 假 |

## 已删的东西(不要再断言它们存在)

- `schedules` 列:`origin_type / origin_id / origin_role / assoc_meta / scheduled_at`(schema v42;`status` `claimed_at` **保留**,是泵自己的 run-state)
- `ScheduleConfigDAO`:`findSchedulesByOrigin / findRootSchedulesByTaskIds / findQueuedSchedules / claimParkedTaskSchedule / cancelTriggeredTaskSchedule / findFailedChildSchedules`
- `SchedulerEngine`:`checkQueuedTasks()`(整个领取循环)、`auxiliaryTick` 里的 reaper 调用、origin_type='task' 的失败终态提升、`emitScheduleStatus` 里的任务镜像
- `TaskScheduleStatusListener`(文件删除)、`orphan-reaper.ts`(文件删除)
- `WorkflowExecutor`:`isRequirement` 及所有 requirement/v4/composite 分支(ws 复用绑定、phase seed 下行、phase/round 打标、tasks.status 镜像、v4 collect 上行、`buildCompositeInputValues`、`resolveTaskSpecFromOrigin`、`resolvePhaseRound`、`taskDAO` 构造参数)
- `SchedulerService`:`enqueueJob`、`createJob/updateJob` 的 `task_spec` 物化支、`resolveCompositeTaskSpec`、`findCompositeChildren`、`buildDagFromTaskSpec`、listJobs 的 trigger_source/origin 过滤
- 路由:`POST /api/scheduler/jobs/:id/enqueue`;`GET /api/scheduler/jobs?trigger_source=&origin=`
- 共享类型:`SchedulerJob.trigger_source / origin_type / origin_id / source_chat_session_id`;`ScheduleStatus` 去掉 `'draft'`;`CreateJobInput.trigger_source`;`TaskDispatchPort.dispatchChildSchedule`→`dispatchChild`;`ScheduleHandle{schedule_id}`→`ChildHandle{child_id}`
- `TasksService`:字段 `scheduleDAO/runDAO/wakeScheduler`、`setWakeScheduler`、`locateParkedEnvelope`、`prebuildIsV4Simple/prebuildTaskWorkspace`(逻辑移入 job)、`finalizePhaseRoundExecution`、`collectPhaseRoundArtifacts`、`abortChildSchedule`、`cancelExecutionLinks`、`enrichRootSchedule`、`latestExecutionRef`、`extractWorkflowRef`
- DTO:`TaskDTO.schedule_status / scheduled_at`(换成 `trigger_*` + `execution` badge);`TaskDetailDTO.children`(换成 `executions[]`);`AcceptanceDispatch.schedule_id`

## 新行为(要断言的)

1. **`readyTask`** = gate + `status: draft→ready`。**不建任何 schedules 行**。断言:`SELECT COUNT(*) FROM schedules` 为 0。
1b. **`armTask` 领 `ready` 或 `running`,拒其他**(票03 复核修正)。v4 一轮结束时刻意**不改** `tasks.status`(K3:待验收是派生态,机器转移不上卡片),于是 acceptance 的 rejected / autoAdvance 与 advance 三支全部发生在卡片写着 `running` 的时候 —— 若 arm 只领 `ready`,整条 v4 流程会在派发处 409 死掉。人工入口 `POST /:id/trigger` 保留自己更严的 ready-only 判断,所以这不是放松「触发」;done/failed/aborted/archiving 仍然不能起轮(重跑 = 重新入队)。同理:**机器观测到的结束**(启动失败 / 对账回收滞留行)一律经 `finishTaskOutcome`,它对 v4 直接返回。
1c. **槽位一释放就续领**:`finalizeLaunch` 末尾 `launchQueued(1)`,排队中的任务不等下一个 cron 分钟;`claimLaunch` 是 guarded UPDATE,重复 drain 不会双起。

2. **`triggerTask(id, at?)`**(async):
   - `at` 缺省/过去 → `lifecycle.armAndLaunch` 当场建工作区 + 插 `executions(pending)` + 在并发闸内 start;任务 `status='running'`。
   - `at` 未来 → 只 `armOnce(id, at)`,状态留 `ready`,`next_fire_at=at`。到点由内置 job 起(测试可直接 `tick()`)。
   - 已有活实例 → 409(`reason='in-flight'`),消息含「已有进行中的实例」。
   - 工作区建不出来 → 409(预建语义保留:按钮按下就知道,不等一分钟)。
3. **`cancelTaskTrigger(id)`**:`pending` 行被 retire(`abortTask` 走 retired)+ `disarmTrigger` + 状态回 `ready`;若已 start → 409。
4. **`abortTask(id)`**:`lifecycle.abortTask` 停自己的实例(活的走 engine cancel + 行置 `aborted`;排队的直接 retire),然后 tasks.status='aborted'。**不碰 schedules**。
5. **`deleteTask`**:软删任务,**无 cascade**(没有信封可清)。
6. **`reopenTask`**:守卫是「没有活实例」(`currentInstance` 非终态即拒),不再是信封状态;**无 softDelete**。
7. **`dispatchPhaseRound(task, phase, round, feedback, opts)`** → 委托 `lifecycle.armTask({phaseIndex,roundIndex,...})` + 立即领取。返回 `{executionId, workspaceId}`(**无 scheduleId/schedExecId**)。phase/round 落在执行行列上,不再改写任何 config。
8. **job tick 周期语义**:一次任务起完 → `next_fire_at=NULL`(once 燃尽);cron 任务跑完 → 状态回 `ready` + 游标跳到下一次(**不落 完成**,否则周期任务死锁);运行期间到点的触发被抑制(latch)。
9. **并发闸**:`countActiveWork()` = 活的作业 fire + 活的任务执行行(根+子都算,`pending` 不算,`job_type='job'` 的 fire 不算)。
10. **内置 job**:`builtin-task-lifecycle` 行 seed **enabled=1**;handler 由 composition root 注入(`registerAndSeedBuiltinCodeJobs(dao, org, handler)`),未注入时自报「未接线」而不是静默。
11. **子单元 resume**:`TaskDispatchService.dispatchChild` → `dispatchChildRun`,建 `executions(parent_id, task_id)`;超并发时留 pending 由 job 领取;完成时 `resumeParentFromChild` 派生 parent + 其 running 节点 → `resumeTaskDispatch`。断言里不要再找 child schedule。

## 不变的东西(别顺手改)

- v4 验收/phase 模型、`deriveTaskView`、`task_phase_acceptances` 账本、归档 K11、seed/collect 的 home↔ws 单向环、ADR-0018 打回二分路由与 `prev_handoff_paths` 注入、任务 ws 一 task 一工作区(K4)、phase/round 不换支。
- cron / agent 两类作业的触发链路(node-cron 注册、超时、连败退避、schedule_executions 历史、手动 triggerManual、abortJob、retention)。
