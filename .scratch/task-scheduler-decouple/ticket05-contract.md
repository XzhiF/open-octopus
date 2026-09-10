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
5. **`GET /api/scheduler/jobs?job_type=job` 可用**:`job` 行现在能经 API 创建/更新/筛选
   (`createJobSchema` 以前本地写死 `['workflow','agent']`,票02 加了类型却没通到 API)。
   乱值 = 不加过滤(以前是把任意字符串原样塞进 WHERE)。
6. **`task_trigger_failed` 上了契约**:`{task_id, reason, trigger_mode}`(原来服务端发的是 `action`,装的却是 trigger_mode)。语义 = **到点但根本起不来**(phase spec 删了 / 没绑 workflow / 工作区建不出来),游标照样退休(否则 broken 任务每分钟撞并发闸)。它**不折进 `task_status`**:没有状态变化(任务仍 ready),它是"什么都没发生"的通知 —— 没有 UI 出口时,用户看到的就是一张永远停在「已入队」的卡,原因只在日志里。**运行中被抑制的那次触发不发此事件**(那不是失败,`task_execution` 已经在讲这一轮)。
7. **task-lifecycle 的 job 行**:系统内置 `builtin-task-lifecycle`,`job_type:'job'`,
   seed 幂等(enabled 与 cron 由用户改,seed 只修 handler 指针)。调度页要能看见/暂停它,
   **不能删**;它不该显示为裸 uuid。

## 不变的东西

- 看板 10s 轮询 + 各 SSE 事件的存在(票03 已把 `task_execution` 订阅接上)。
- v4 phase/round 派生(`deriveTaskView`)、验收账本、K3(机器不写 v4 卡片状态)。
- `POST /api/tasks/:id/trigger` 的 ready-only 人工闸;`abort` 同步停引擎。
- cron / agent 两类作业的全部既有行为。

## web 侧待办(交给前端)

- `lib/tasks-api.ts` 删本地镜像类型,改 `import type { Task, TaskExecutionBadge, TriggerMode } from '@octopus/shared'`。
- 看板/弹窗 badge:`error_summary` 要有出口(红行悬浮/展开显示原因);composite 卡展开显示 `children[]`(标签用 `name`)。
- 调度页:类型筛选含 `job`;内置 job 行显示"上次触发/耗时/可暂停",无裸 uuid。
- SSE payload 字段名跟进:`scheduled_at` → `next_fire_at`;不要在 task_status 上读 `origin_type`。
- `task_trigger_failed` 要有出口(toast 或角标显示 `reason` 一行即可)。
- `e2e/helpers/task-domain-helpers.ts` 等 6 个 spec 属于票06,本票不动(除非类型改名导致编译不过)。
