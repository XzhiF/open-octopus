# 0021 — 任务 ⇄ 调度器切开：调度器回归 workflow/agent/job 三类作业，任务生命周期交给一个内置 job

## 状态

Accepted（2026-09-10，取代 2026-09-09 初稿）· 实现 `.scratch/task-scheduler-decouple/spec.md` · 分支 `feat/scheduler-decouple`
票01（v41 加列）+ 票02（`job` 类型骨架）+ 票03（原子翻转，v42 删列）+ 票04（composite 子单元 = child executions）+ 票05（读模型与调度页回归作业视图）已落地；票06（e2e + 手测清单）未完。
落地后的**行为契约**分两份，测试与前端以其为基线、而非以本 ADR 反推：`ticket03-contract.md`（数据形状与任务侧新行为）、`ticket05-contract.md`（在线类型与读模型字段）。

初稿提出的 `cron_jobs` + `scheduler_runs` 双新表方案**已废弃**（见「被否方案」最后一条）：本 ADR 的终态**不新增任何表**。

## 背景

任务"入队 → 触发"的真实实现是：`readyTask` 给任务预先固化一条私有 `schedules` 行（内部称**信封**，`origin_type='task'`，停放 `status='draft'`），"触发"= 把这条行翻成 `queued` 并写 `scheduled_at`。`tasks` 表本身没有任何触发字段。

于是 `schedules` 这张表同时承担三件不相干的事：**定时作业定义**（cron/agent）、**一次性运行实例**（status/claimed_at/attempt）、**任务私有信封**（origin_type/origin_id/origin_role）。第二、第三件是 v37/v38/v39 陆续加上去的，代价全部落在任务生命周期上：

- 任务代码直接写三张调度表，并把信封 `config` 同时当**冻结 phase 绑定**和**当前跑到第几轮的游标**（`dispatchPhaseRound` 读改写 `workflow_chain[0]` + `_phase_index/_round_index`）；
- 「一个任务同时只跑一个实例」靠 ~10 处 `findSchedulesByOrigin` 守卫 + 借用 `schedule_executions` 的 partial UNIQUE 索引当串行闩锁；
- 停放/撤回/级联软删/`orphan-reaper`/reopen「不删旧行会泄漏重复」构成一整个只服务于隐藏对象的生命周期层；
- 双状态机靠 `ScheduleStatusListener` 手工镜像，失衡漏成用户可见错误：「未找到已入队的执行计划，请重新入队」；
- 概念污染双向：2026-08-29 为了让运行中任务在调度 UI 可见而去掉 origin 过滤（决定记在 `routes/scheduler.ts:203` 注释），任务信封从此混居「系统调度」列表；
- 周期触发 structurally 不可能（task-origin 行 `cron_expression` 恒 null，信封是一次性实例）。

根因：**触发定义被寄存在运行载体里，而运行载体又被寄存在作业定义表里**。

## 决策

1. **调度器职责回归作业**。`schedules` 只做一件事：作业定义，`job_type ∈ {workflow, agent, job}`。v42 删掉绑定任务的四列（`origin_type/origin_id/origin_role/assoc_meta`）与信封的一次性到期列（`scheduled_at`）。
   **保留 `status` + `claimed_at`** —— 这两列不是任务遗留，而是泵对自己作业的 run-state：`abortJob` 的「只有 in-flight 可中止」守卫与 `checkStaleClaimed` 的 10 分钟崩溃回收都读它。票03 删掉信封领取循环后它们一度**没有任何写入者**（守卫恒 400、sweep 恒不命中），故写入点回归到唯二知道"一次触发开始/结束"的地方：`dispatchExecution` 置 `running`+`claimed_at`，`onExecutionComplete` 置 `done`/`failed`+清 `claimed_at`。把 run-state 彻底迁到 `schedule_executions` 是另一次改动（有自己的风险面），不在本 ADR 范围。
   `schedule_executions` / `schedule_workspaces` 保留 —— 它们本来就是"某作业某次触发"的历史。
2. **新增第三种作业类型 `job`：可执行体是注册在系统里的一段 TS 代码**（按 handler 名解析），复用作业定义的全部既有机制：cron 表达式、`enabled`、`timeout_seconds`、`consecutive_failures` 自动停用、`schedule_executions` 运行历史、系统调度页的可见性与手动触发。泵不为此变特殊 —— 它只是多了一类 executor：`JobTypeExecutor` 查 handler 注册表并调用。
3. **系统内置一个 `job`：`task-lifecycle`**。它是全系统**唯一被允许同时认识任务与执行**的单元，独占任务的调度职责：扫 `tasks.next_fire_at` 到点 → 起 → 监听执行状态 → 推进 phase/round 与验收派生 → 超时/失败重试 → 孤儿与滞留回收 → 并发闸。任务侧代码与作业侧代码都不再互相持有。
4. **触发定义是任务的属性**，落在 `tasks`（v41 已落）：`trigger_mode('manual'|'once'|'cron')`、`trigger_at`、`cron_expression`、`cron_timezone`、`trigger_enabled`、`next_fire_at`（唯一到期游标）、`last_fired_at`；部分索引 `idx_tasks_due`。扫描通过任务域的 `TaskDAO.findDueTriggers()`，作业侧不直接读 `tasks`。
5. **一次任务运行就是 `executions` 那一行本身**，靠 v41 的 `executions.task_id` 直连（取代原来经 `schedules` 的裸 SQL join 桥）。`status='pending'` 即"已排队待起"，内置 job 在闸内领取。v4 轮次与 composite 子单元都写成带 `task_id` 的执行行，子单元用引擎既有的 `parent_id/child_index` 嵌套模型 —— 因此**不需要第三张表**。
6. **两条不变量下沉为 DB 约束**：`ux_exec_task_active`（partial UNIQUE over 根执行，`task_id`）= 「一个任务同时只有一个实例」；冲突即"已触发/本轮在飞"，取代 ~10 处守卫与借来的索引闩锁。写法定为 **`status NOT IN (终态)`** 而非 `IN (活跃)`：执行有五个存活状态（pending/running/paused/pending_approval/pending_resume，审批与交互挂起仍持有工作区），未来新增状态必须默认**占住**槽位；白名单会在有人加第六个存活状态的那天静默允许双起。滞留非终态的行由内置 job 的对账回合解决，不是放第二个实例的理由。
7. **并发闸必须跨两类计量**。今天全局 cap=3 的口径是 `schedule_executions` 里 active 的 distinct `schedule_id`；任务运行改记 `executions` 后，单看前者会让任务绕过 cron 作业在守的上限。合并成一个 `countActiveWork()`：在飞的作业触发 + 在飞的任务执行行。落地时钉死三条口径（都在 `count-active-work.test.ts`）：
   - `job_type='job'` 的触发**不计数** —— 内置 job 每分钟一跑，计入就永久吃掉 3 个槽里的 1 个；
   - 任务侧算**根与子全部**（一个在飞的子单元确实占着一个工作区与引擎，旧口径下它是独立 schedule 行），但 **`pending` 不算** —— 排队中的行占的是"身份槽"（由 `ux_exec_task_active` 守），不是算力槽；把排队计入会让闸自锁（三个 armed 任务读成"已满"，于是谁都起不来）；
   - 谓词仍写 `NOT IN (终态)`，与闩锁同向 fail-closed。
8. **状态推进用事件回调 + tick 对账双输入**：执行完成/异常时同步回调内置 job（零延迟，等价今天的 `emitScheduleStatus` + listener），每轮 tick 再做一次幂等对账（抓崩溃、重启、漏事件）。对账逻辑与孤儿回收同源，不额外花钱。
9. **命令由路由层协调**：`abort`/`cancel trigger`/`advance` 在 route 里同时调任务侧与 `task-lifecycle` job（同步停引擎，用户可感知行为不变）。任务域不 import 调度 DAO —— 由一条门禁单测长期守（`services/tasks/**` 禁出现 `schedules` 字样与调度 DAO import）。
10. **`trigger_source='requirement'` 这个字符串派生退休**：`WorkflowExecutor.isRequirement` 的四处读点（状态推进 / done 收尾 / retention 豁免 / task-home collect）改为显式判"这条执行是否绑任务"（`execution.task_id != null`）或由 job 侧自己决定，不再有从 `origin_type` 造词的中间层。

## 被否方案

- **把 `schedules` 拆成 `cron_jobs`（定义）+ `scheduler_runs`（实例）两张新表**（本 ADR 初稿，S1 一度按此落地并写了 42 个契约测试）。被否：它解决的是"定义与实例混在一张表"，而真正的痛点是"任务被塞进作业表"。用户口径要求**回归最原来的设计**，且 `executions` 已经天然是"一次运行"的载体（有 status/workspace/var_pool/duration/phase_index/round_index），再造一张 run 台账就是把同一职责换个名字再存一遍。删除发生在方案确认当轮。
- **只修概念泄漏（数据模型不动，UI 隐藏 + 改错误文案）**：绑定是结构性的 —— `tasks` 没有触发列，任何"定时"都必须经信封表达，隐藏只是把耦合藏更深，周期触发仍无解。
- **彻底删掉运行记录、让泵直接扫 tasks 起 executions**（用户最初表述的字面读法）：被否的正是"泵里长出一段任务专属逻辑"这个形状。本 ADR 用内置 job 满足同一个诉求而不再加一层 if。
- **把定时作业也收敛成任务**：独立产品决策，另案。

## 后果

正面：`readyTask` 不再产生任何调度行；「请重新入队」这类错误失去存在条件；周期触发免费得到；系统调度页重新只是作业列表（三类），任务不再以作业身份混入；调度器代码里"任务"这个概念整体消失，换成一个具名 job；未来的系统内务（归档扫描、retention、repo 同步清理）都能以 `job` 类型挂进去，而不是继续散落 `setInterval`。

代价：约 35+ 测试文件与 6 个 e2e spec 按新契约重写；`WorkflowExecutor` 的任务专属逻辑（v4 工作区复用、phase seed/collect、composite 聚合、task-home collect）要从"作业执行器"里整体搬进 job —— 这是本次最大的一块搬运，也是最高风险点。票03 实测：搬运之后 `WorkflowExecutor` 只剩"跑一个 workflow 作业"，其构造参数（taskDAO / statusListener）与 `isRequirement` 分支一并删除。

另两条代价在票03 才浮现，记录以免被后人当作顺手改动：
- **composite 子单元被迫同期改**。子单元原先是子 schedule 行，超并发时靠 `checkQueuedTasks` 领取；该循环随信封一起删除后，排队中的子单元将永无领取者。故 `TaskDispatchPort` 一并改名换形（`dispatchChildSchedule→dispatchChild`、`ScheduleHandle{schedule_id}→ChildHandle{child_id}`），子单元成为 `executions` 行（`parent_id`=派发方、`task_id`=父任务），父回填改为**派生**（parent_id + 父的 running 节点），`parent_task_dispatch` 配置内嵌标记与 `setResumeParentCallback` 手工接线同时消失 —— 重启安全由两张行保证，不再靠往 config 里塞关联。这吃掉了原属票04 的主干。
- **周期任务的"跑完回到 ready"**（见上），是打开 cron 之后才出现的状态机问题。

落地中新增的两条决定（原方案未写）：

- **周期任务跑完不停在「完成」**。v41 前这是结构性的（信封跑完就 done，且 `trigger` 只接受 ready），"周期触发"因此根本不可能；打开之后新问题变成：一轮结束若把任务钉在 done/failed，它的下一次到点就再也扫不到（到期扫描要求 `status='ready'`）。所以 `cron` 任务的终态语义改为**回到 ready + 游标跳到下一次发生时刻**（错过多轮只补一次，不逐分钟追补），`once`/`manual` 才落 done/failed；v4 任务不自动回位（它停在待验收，人是闸）。看板上这会表现为周期任务的卡片从"执行中"回到"已入队"而不是"完成"——运行结果在执行行与 `task_execution` SSE 上，不丢。
- **内置 job 的 handler 由 composition root 注入**（`registerAndSeedBuiltinCodeJobs(dao, org, handler)`），注册表为此开了 `rebindCodeJobHandler`：普通注册拒绝同名换函数（那是接线 bug），但内置 job 每次启动绑的都是新闭包，拒绝会让第二次 seed 打死调度器。未注入时 handler 自报"未接线"而非静默成功。

待观察：`executions.status` 的终态清单若与 `ux_exec_task_active` 的 NOT IN 清单漂移，会往"过度保守（滞留占槽）"方向失效，由对账回合兜；反之若有人把存活状态误加进终态清单，双起风险回来 —— 票 03 的并发用例是硬门槛。

## 票03→票05 落地时补的决定

九条不在原方案里、且每条都有"不记就会被改回去"的风险：

- **读模型的唯一真相在 `@octopus/shared/types/task.ts`**。票03 换掉数据形状时，为不阻塞前端，web 侧临时本地镜像了 trigger 列与执行 badge，并留注释说"shared 的 `Task` 还带着 schedule_status/scheduled_at"。票05 收口：`Task` 自己声明 `trigger_*` 七列 + `execution: TaskExecutionBadge`，`schedule_status`/`scheduled_at`/`ScheduleStatusListener`/`OriginType*`/`TriggerSource`/`OriginRole` 一并删除。**镜像不是省事，是两个真相**：只有把旧列从 shared 里删掉，前端才不可能再"顺手"读回信封语义。
- **红行的原因写在行上，不新开列**。`executions` 没有 error 列（节点失败留在 `node_executions`），票03 之后每条失败写路径（对账回收、用户中止、启动失败、领取失败、composite 聚合）原先只把原因打进日志，于是卡片变红而无话可说。决定：统一并入 `var_pool.error`（与 `retireLaunch` 同键），读模型只在**终态失败行**投影成 `error_summary`，绿行不显示遗留键。新开列是更大的改动，且没有多保存任何信息。
- **子单元的标签在行上**：`executions.name = subunit.name` 取代 `schedules.origin_role='subunit'`。fan-out 的判据是 `task_id` 非空且 `parent_id != '0'`（引擎自己的链式子行不带 task_id）。detail 与 `/executions` 挂 `children[]`，看板 badge 不挂 —— `undefined`（没加载）与 `[]`（确实没有）必须是可区分的，否则列表行会渲染"无子单元"。
- **丢唤醒只对"引擎还活着"的父执行自愈**。子完成回调只在该子进程期内发一次，抛错即父永远停在 `pending_task_dispatch`；`recoverStuckDispatchParents` 在 reconcile 里问"这个暂停节点还欠着子执行吗"并唤醒。**父的引擎也已不在本进程时刻意不救**（没人能接收 resume，谎报恢复比不恢复糟），那条行归滞留回收。`RecoveryManager` 不覆盖此场景：它重启被中断的引擎，而暂停的父不是被中断，是在等一个已经不存在的等待者。
- **DB 时间戳有两种方言，年龄判断必须按 UTC 解无标记串**。DAO 写 `toISOString()`（带标记），SQLite 的 `datetime('now')` 与表 DEFAULT 写的是**无标记的 UTC**，而 `Date.parse` 按本地时区读它 —— UTC+8 部署上，刚出生 1 秒的行看起来老了 8 小时，回收会在起跑后一分钟杀掉在飞实例（票04 的测试先撞见，因为它的 mock 走 SQL 时钟）。故 `dbTimeMs()` 统一：naive ⇒ UTC。这也是"测试夹具要尽量像生产"反过来成立的一次证据：夹具与生产的差异，把生产里潜伏的 bug 提前暴露成红。
- **`job` 类型要通到 API**。票02 给 `JobType` 加了 `'job'`，但 `createJobSchema` 里仍写死 `z.enum(['workflow','agent'])` —— 类型在联合里、门却没开，内置 job 之外没有任何 `job` 行能经接口创建；同理列表路由把 `?job_type=` cast 成两个值，cast 不是校验（任意串原样进 WHERE）。票05 改为单一 `jobTypeSchema` 供三处共用，query 参数改 `pickEnum` 校验、乱值=不过滤。
- **每一次终态写入都欠一条 `task_execution`**，中止与排队退役也不例外。票05 的 payload 里有 `reason` 却没有出口：`abortTask` 只写行不发票，看板要等下一次 10s 轮询才知道发生了什么，而轮询出来的读模型没有 `reason` 可给（只有这个事件带）。决定收成单一出口 `emitExecutionTransition(row, status, reason?)`，与「红行的原因写在行上」配对：行上有 `var_pool.error`、线上有 `reason`，两处同一句话。
- **创建时就要求 handler 已注册**（票06 补）。`validateConfig` 只管形状（`{type:'job', handler}`），存在性没人管，于是名字打错的 `job` 行是"每分钟红一次的死行"：pump 每分钟 fire、registry 每分钟拒、`consecutive_failures` 一路涨，看上去像作业坏了，而不像创建时敲错一个字。改在名字被敲下的那一端（`assertHandlerRegistered`，create 与 update 两处共用，400 里报出注册表现有名字）。同 §13-2 的口径：**能力收口写在服务端，不写在某个表单里**。
- **跨接缝的行类型只能有一处定义**。作业的 `duration_ms` 从没到过 wire，因为 `schedule_executions` 里一直是有的，而 DAO 的相关子查询取三列、`scheduler-service` 本地又手抄一个 `interface ScheduleRow` 声明同样三个 `last_exec_*` —— 加第四列两处都不报错、也没有测试会红（断言只看自己那三样）。收成为 DAO 导出的 `ScheduleRowWithLastExec`（service 侧只做别名）+ 一个共享的 `LAST_EXEC_SELECT` 常量，让"列表"与"单条 GET"不可能各长一半。

