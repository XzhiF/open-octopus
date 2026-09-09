# 0021 — 任务 ⇄ 调度器切开：调度器回归 workflow/agent/job 三类作业，任务生命周期交给一个内置 job

## 状态

Accepted（2026-09-10，取代 2026-09-09 初稿）· 实现 `.scratch/task-scheduler-decouple/spec.md` · 落地 v41 schema 加列部分已在 `feat/scheduler-decouple`

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

1. **调度器职责回归作业**。`schedules` 只做一件事：作业定义，`job_type ∈ {workflow, agent, job}`。删掉绑定任务的四列（`origin_type/origin_id/origin_role/assoc_meta`）和只被信封用到的运行列（`status/claimed_at/scheduled_at`）。`schedule_executions` / `schedule_workspaces` 保留 —— 它们本来就是"某作业某次触发"的历史。
2. **新增第三种作业类型 `job`：可执行体是注册在系统里的一段 TS 代码**（按 handler 名解析），复用作业定义的全部既有机制：cron 表达式、`enabled`、`timeout_seconds`、`consecutive_failures` 自动停用、`schedule_executions` 运行历史、系统调度页的可见性与手动触发。泵不为此变特殊 —— 它只是多了一类 executor：`JobTypeExecutor` 查 handler 注册表并调用。
3. **系统内置一个 `job`：`task-lifecycle`**。它是全系统**唯一被允许同时认识任务与执行**的单元，独占任务的调度职责：扫 `tasks.next_fire_at` 到点 → 起 → 监听执行状态 → 推进 phase/round 与验收派生 → 超时/失败重试 → 孤儿与滞留回收 → 并发闸。任务侧代码与作业侧代码都不再互相持有。
4. **触发定义是任务的属性**，落在 `tasks`（v41 已落）：`trigger_mode('manual'|'once'|'cron')`、`trigger_at`、`cron_expression`、`cron_timezone`、`trigger_enabled`、`next_fire_at`（唯一到期游标）、`last_fired_at`；部分索引 `idx_tasks_due`。扫描通过任务域的 `TaskDAO.findDueTriggers()`，作业侧不直接读 `tasks`。
5. **一次任务运行就是 `executions` 那一行本身**，靠 v41 的 `executions.task_id` 直连（取代原来经 `schedules` 的裸 SQL join 桥）。`status='pending'` 即"已排队待起"，内置 job 在闸内领取。v4 轮次与 composite 子单元都写成带 `task_id` 的执行行，子单元用引擎既有的 `parent_id/child_index` 嵌套模型 —— 因此**不需要第三张表**。
6. **两条不变量下沉为 DB 约束**：`ux_exec_task_active`（partial UNIQUE over 根执行，`task_id`）= 「一个任务同时只有一个实例」；冲突即"已触发/本轮在飞"，取代 ~10 处守卫与借来的索引闩锁。写法定为 **`status NOT IN (终态)`** 而非 `IN (活跃)`：执行有五个存活状态（pending/running/paused/pending_approval/pending_resume，审批与交互挂起仍持有工作区），未来新增状态必须默认**占住**槽位；白名单会在有人加第六个存活状态的那天静默允许双起。滞留非终态的行由内置 job 的对账回合解决，不是放第二个实例的理由。
7. **并发闸必须跨两类计量**。今天全局 cap=3 的口径是 `schedule_executions` 里 active 的 distinct `schedule_id`；任务运行改记 `executions` 后，单看前者会让任务绕过 cron 作业在守的上限。合并成一个 `countActiveWork()`：在飞的作业触发 + 在飞的任务根执行。
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

代价：约 35+ 测试文件与 6 个 e2e spec 按新契约重写；`WorkflowExecutor` 的任务专属逻辑（v4 工作区复用、phase seed/collect、composite 聚合、task-home collect）要从"作业执行器"里整体搬进 job —— 这是本次最大的一块搬运，也是最高风险点。

待观察：`executions.status` 的终态清单若与 `ux_exec_task_active` 的 NOT IN 清单漂移，会往"过度保守（滞留占槽）"方向失效，由对账回合兜；反之若有人把存活状态误加进终态清单，双起风险回来 —— 票 03 的并发用例是硬门槛。
