# 票05 落地后的契约(web / 前端测试的重写基线)

ADR-0021 票05 —— 读模型与调度页面。判断标准同票03:**按此契约决定断言该变成什么**,
不是"怎样让它变绿"。若某条断言按契约只能改弱,那是产品 bug,报出来。

## 唯一的类型来源:shared

`@octopus/shared` 的 `types/task.ts` 现在是任务读模型的唯一真相,**web 不要再本地镜像**:

| 符号 | 含义 |
|---|---|
| `Task` | 任务在线形状 = 行的全部字段 + `trigger_*` + `execution` badge。**`schedule_status` / `scheduled_at` 已删**(它们是信封行的镜像)。 |
| `TriggerModeSchema` / `TriggerMode` | `'manual' \| 'once' \| 'cron'`。注意 `'queued'/'claimed'/'draft'` 不在其中 —— 那些是**信封行状态**,不是"何时"。 |
| `TaskExecutionBadge` | 一次运行:`id/status/workflow_ref/name/phase_index/round_index/workspace_id/started_at/completed_at/created_at/error_summary/children?` |
| `TASK_EXECUTION_EVENT` | `"task_execution"` + `taskExecutionSsePayloadSchema`(票03 只有字面量,票05 上了契约) |
| `taskStatusSsePayloadSchema` | 只剩 `{task_id, status}`。`schedule_id` / `origin_type` 没了。 |
| `taskTriggerSsePayloadSchema` | `{task_id, action, next_fire_at}`。**字段改名**:`scheduled_at` → `next_fire_at`;action 枚举 = 服务端真会发的那 5 个:`scheduled/unscheduled/cancelled/paused/resumed`(立即触发不发此事件,它走 task_execution) |
| `jobTypeSchema` / `JobType` | `'workflow' \| 'agent' \| 'job'`。scheduler 列表的 `?job_type=` 与 createJob 输入共用它。 |

已彻底删除的 shared 符号(引用即红):`OriginTypeSchema`、`OriginType`、`TriggerSource`、
`ScheduleStatusListener`、`OriginRole`。

## 新事实(要断言的)

1. **`trigger_enabled` 是 boolean**(不是 0/1),`trigger_mode` 是枚举成员。库里脏值 → 读模型
   落 `manual`(fail-closed:读不懂的触发永不自己起轮)。
2. **`error_summary`**:红行为什么红。写侧每条路径都落 `var_pool.error`(票05 起):
   对账回收(失去引擎进程/工作区不可用)、用户中止(「用户中止」)、启动失败(引擎消息)、
   领取后启动失败、composite 聚合(「N 个子单元执行失败」)、finalize 兜底取失败节点 error。
   读侧只在**终态失败行**露出(`failed/aborted/completed_with_failures`),绿行永不显示遗留键。
3. **`children`**:composite 一轮的子单元运行挂在根下。判据 = `task_id` 非空且 `parent_id != '0'`
   (引擎自己的链式子行没有 task_id,所以不算 fan-out)。detail 与 `/executions` 会带,
   **看板 badge 不带**(`undefined` vs `[]` 就是"有没有加载过 fan-out"的答案,UI 不能对列表行渲染"无子单元")。
4. **子单元的名字在行上**:`dispatchChildRun` 现在把 `subunit.name` 写进 `executions.name`。
   取代 `schedules.origin_role='subunit'` 的就是这个字段 —— 不要再找 role。
5. **`job` 类型通到 API**:`GET /api/scheduler/jobs?job_type=job` 可用,`POST/PATCH /jobs` 也接受
   `job_type:'job'`(`createJobSchema` 以前本地写死 `['workflow','agent']` —— 票02 加了类型却没开门,
   `job` 行只能靠 seed 存在)。列表的 `?job_type=` 由 cast 改 `pickEnum` 校验:乱值 = 不过滤
   (cast 是把任意字符串原样塞进 WHERE)。类型枚举单源 `jobTypeSchema`。
6. **`task_trigger_failed` 上了契约**:`{task_id, reason, trigger_mode}`(原来服务端发的是 `action`,装的却是 trigger_mode)。语义 = **到点但根本起不来**(phase spec 删了 / 没绑 workflow / 工作区建不出来),游标照样退休(否则 broken 任务每分钟撞并发闸)。它**不折进 `task_status`**:没有状态变化(任务仍 ready),它是"什么都没发生"的通知 —— 没有 UI 出口时,用户看到的就是一张永远停在「已入队」的卡,原因只在日志里。**运行中被抑制的那次触发不发此事件**(那不是失败,`task_execution` 已经在讲这一轮)。
7. **task-lifecycle 的 job 行**:系统内置 `builtin-task-lifecycle`,`job_type:'job'`,
   seed 幂等(enabled 与 cron 由用户改,seed 只修 handler 指针)。调度页要能看见/暂停它,
   **不能删**;它不该显示为裸 uuid(真机 name 已是「系统 · 任务生命周期」)。
8. **存量 DB 迁移后 `schedules` 只剩真作业**(票06 手测⑥在开发者本机 DB 副本上实测):
   v42 不只 DROP COLUMN,还删 `origin_type='task'` 的信封行(先删 `schedule_executions`
   子行,并把 `source_schedule_id→origin_id` 搬进 `workspaces.task_id`)。**断言口径**:
   迁移/启动后"没有任何一行属于某个 task",而**不是**"总数为 N" —— 内置 job + 该 org
   既有作业数随环境变。

## 不变的东西

- 看板 10s 轮询 + 各 SSE 事件的存在(票03 已把 `task_execution` 订阅接上)。
- v4 phase/round 派生(`deriveTaskView`)、验收账本、K3(机器不写 v4 卡片状态)。
- `POST /api/tasks/:id/trigger` 的 ready-only 人工闸;`abort` 同步停引擎。
- cron / agent 两类作业的全部既有行为。

## web 侧待办 —— 收账(2026-09-11)

逐条核过实现与用例,六条全部落地,不再挂账:

- ✅ `lib/tasks-api.ts` 本地镜像类型已删,类型自 `@octopus/shared` import(`Task` /
  `TaskExecutionBadge` / `TriggerMode`)。
- ✅ `error_summary` 有出口:`components/tasks/execution-summary.tsx` 渲染红色运行原因
  (用例 `execution-summary.test.tsx`);composite 展开显示 `children[]`,标签用 `name`
  (用例 `task-modal-composite.test.tsx`)。
- ✅ 调度页:类型筛选含 `job`;内置行显示「上次触发 · 耗时」+ 可暂停、无删除、无编辑
  (`scheduler-table.tsx` + `scheduler-table.test.tsx` 9 例,`isBuiltinJob` 是产品判据不是
  测试私货)。**耗时这列是今天补的**:数字一直在 `schedule_executions.duration_ms` 里,但
  `SchedulerExecutionSummary` 只有三个字段,DAO 的相关子查询与 service 里手抄的
  `interface ScheduleRow` 各三样、谁也没加第四样 —— 已收成单一 `ScheduleRowWithLastExec`
  (见 spec §8c)。
- ✅ SSE 字段名:`scheduled_at` → `next_fire_at` 已跟;web 里对 `origin_type` /
  `scheduled_at` 的引用只剩注释(解释它们为何没了),没有活代码读它们。
- ✅ `task_trigger_failed` 有出口:`lib/task-board.ts` + `app/tasks/page.tsx` 消费
  `reason`(用例 `task-board.test.ts`)。
- ✅ 票06 的 e2e 迁移另账:`task-domain-{simple,composite,crash-abort}.spec.ts` 已跟上
  五列看板与「触发真的起一轮」,新增 `task-trigger-loop.spec.ts`(见 §8b 与其提交)。

**一条曾被记成"缺口"的,其实是决定**:内置 job 的 cron 在 UI 里不可编辑。`SchedulerForm`
只能表达 workflow/agent 两类 config,给 `job_type='job'` 行开表单 = 提交时把 handler 指针
盖成 agent 形状;所以菜单里对 job 行不渲染「编辑」,由 `scheduler-table.test.tsx` 钉住。
要改 cadence 目前只能走 `PUT /jobs/:id`(路由允许改 cron,只拒 config)。
