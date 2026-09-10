# Spec — 任务 ⇄ 调度器所有权切开 (task-scheduler-decouple)

> 决策记录:ADR-0021(2026-09-10 版)· 分支:`feat/scheduler-decouple` · 创建:2026-09-09
> 前置:开发阶段,存量数据可直接清除,**无迁移、无兼容层**
> 架构:调度器职责回归 `workflow`/`agent`,新增 `job` 类型;任务生命周期由一个**内置 job** 独占。**不新增任何表。**

## 1. 问题

任务"入队 → 触发"的真实实现:`readyTask` 给任务预先固化一条私有 `schedules` 行(内部称**信封**,`origin_type='task'`,停放 `status='draft'`),"触发"= 把这条行翻成 `queued`。`tasks` 表本身没有任何触发字段。

于是 `schedules` 一表三职:作业定义 / 一次性运行实例 / 任务私有信封。后两职(v37→v39 陆续加)把代价全压在任务生命周期上:

| # | 症状 | 证据 |
|---|---|---|
| P1 | 任务代码写三张调度表,信封 `config` 兼任"冻结 phase 绑定 + 当前第几轮游标" | `tasks-service.ts:2048`(dispatchPhaseRound 重写 `workflow_chain[0]`/`_phase_index`/`_round_index`) |
| P2 | 定时时间无处安放,只能寄存信封 → 绑定是结构性的 | `schedules.scheduled_at`,`tasks` 无对应列 |
| P3 | 双状态机手工镜像 + 内部实体甩给用户 | `schedule-status-listener.ts`;`tasks-service.ts:1761`「未找到已入队的执行计划,请重新入队」 |
| P4 | 一整个生命周期维护层只为隐藏对象存在 | `locateParkedEnvelope`、reopen「不删旧行会泄漏重复」、delete/abort 级联软删、`orphan-reaper.ts` |
| P5 | 周期触发 structurally 不可能 | task-origin 行 `cron_expression` 恒 null |
| P6 | 概念双向污染 | `routes/scheduler.ts:203`:2026-08-29 为让运行中任务可见去掉 origin 过滤 → 信封混进系统调度列表 |

根因:触发定义寄存在运行载体里,运行载体又寄存在作业定义表里。

## 2. 目标与非目标

**目标**
1. 调度器只干一件事:按定义到点跑作业,类型 `workflow` / `agent` / **`job`**(TS handler)。它不认识"任务"。
2. 任务自己持有"什么时候该跑"(`tasks.trigger_*`),"跑成什么样"是一次 `executions` 行。
3. 全系统唯一同时认识两边的单元 = 内置 job `task-lifecycle`,它独占任务的启动 / 状态推进 / 重试 / 超时 / 并发 / 孤儿回收。
4. 任务域代码里 `schedules` 这个词消失(门禁单测守)。

**非目标**:不改引擎 7 执行器与 YAML 语义;不重做工作区"调度管理"tab 的交互(它只是继续当 `workflow`/`agent` 作业的管理面);不动 `job_type='agent'` 的执行路径;不新建表。

## 3. 架构

```
调度器（不认识任务）
  schedules            作业定义 · job_type ∈ workflow | agent | job
    ├─ workflow/agent → 既有 WorkflowExecutor / AgentExecutor
    └─ job            → JobTypeExecutor：按 config.handler 名查注册表，调 TS 函数
  schedule_executions   某作业某次触发的历史（三类共用，不变）
  scheduler-engine      泵：node-cron 注册、领取、超时、stale、失败计数 —— 逻辑不变

内置 job：task-lifecycle（唯一的双边单元，代码在 services/tasks/）
  tick  +  执行完成回调（双输入，见 §5.3）
  ① tasks.next_fire_at 到点 → 冻结 launch payload → 插 executions(task_id, status='pending')
  ② 并发闸内领取 pending → 建/复用工作区 → 起引擎
  ③ 执行终态 → 推 tasks.status、派生 awaiting_review、seed/collect 产物、开下一轮
  ④ composite 子单元 = 同 task 的 child executions（引擎既有 parent_id/child_index）
  ⑤ 回收：死任务的在飞执行、滞留 pending、超时、连续失败退避
```

任务侧只有两类数据:`tasks`(WHAT + WHEN)与 `executions`(每次运行,`task_id` 直连)。

## 4. Schema v41(票 01 已落部分 + 待落部分)

**已落(纯加法,旧代码零改动)**

```
tasks       + trigger_mode 'manual'|'once'|'cron' / trigger_at / cron_expression
            / cron_timezone / trigger_enabled / next_fire_at / last_fired_at
            INDEX idx_tasks_due(next_fire_at) WHERE deleted_at IS NULL AND status='ready'
                                          AND trigger_enabled=1 AND next_fire_at IS NOT NULL
executions  + task_id     INDEX idx_exec_task(task_id, created_at DESC)
                          INDEX idx_exec_task_pending(task_id, created_at) WHERE status='pending'
workspaces  + task_id     INDEX idx_ws_task(task_id)
UNIQUE  INDEX ux_exec_task_active ON executions(task_id)
        WHERE task_id IS NOT NULL AND parent_id='0'
          AND status NOT IN (终态)
```

**待落(票 03,与泵翻转同批)**

```
schedules   − origin_type − origin_id − origin_role − assoc_meta   （绑任务的列）
            − status      − claimed_at − scheduled_at              （只有信封用到的运行列）
            job_type CHECK 扩到 ('workflow','agent','job')；cron_expression 恢复 NOT NULL?
              —— 否：`job` 与 workflow 一样可被手动触发，仍允许无 cron 的定义行
schedule_workspaces 任务用途 → workspaces.task_id 直连；作业用途原样保留
```

`ux_exec_task_active` 两条刻意的写法:
- **只约束根执行**(`parent_id='0'`):composite 一个任务并发跑多个子单元是设计,不是漏洞;子单元级不双跑由 job 自己按 DAG 管。
- **`NOT IN (终态)` 而非 `IN (活跃)`**:执行有五个存活状态(`pending/running/paused/pending_approval/pending_resume`,审批与交互挂起仍持有工作区),未来新增状态默认**占槽**。白名单会在有人加第六个存活状态那天静默允许双起。滞留由对账回合处理,不是放第二实例的理由。

## 5. 边界与不变量

1. **任务域 → 调度域:零引用**(无 import、无表名、无列名)。命令(`arm` / `取消定时` / `abort` / `advance`)由**路由层**协调:route 同时调任务侧与 `task-lifecycle` job。
2. **冻结 payload**:启动那一刻由任务侧算好配置快照写进 `executions.input_values`/var_pool(沿用 v4 现有物化),之后任务 spec 再改不影响在飞的一轮。今天这个职责在信封 `config` 里,搬进执行行即自然归位。
3. **状态推进 = 事件回调 + tick 对账**:引擎完成/异常时同步回调 job(等价今天 `emitScheduleStatus` + listener 的零延迟),每轮 tick 再幂等对账一次(抓崩溃/重启/漏事件)。对账与孤儿回收同源。
4. **并发闸跨两类**:`countActiveWork()` = 在飞作业触发(`schedule_executions` active distinct `schedule_id`)+ 在飞任务根执行。三处消费点(engine 领取前、executor 复检、composite 预检)必须共用它,否则任务能绕过 cron 在守的上限。
5. **`trigger_source='requirement'` 退休**:`WorkflowExecutor.isRequirement` 四处读点(状态推进 / done 收尾 / retention 豁免 / task-home collect)改判 `execution.task_id != null`,不再有从 `origin_type` 造词的中间层。

## 6. 票序(每张结束仓库全绿)

| 票 | 内容 | 绿的条件 |
|---|---|---|
| **01 ✅** | v41 加法:schema 加列/索引 + `ux_exec_task_active` + `TaskDAO` 触发面(`armOnce`/`armCron`/`disarmTrigger`/`setTriggerEnabled`/`findDueTriggers`/`markFired`) | 已完成。`task-trigger-dao.test.ts` 18 测试(含闩锁五存活态/终态释放/根-子区分/未知状态占槽)+ `db-schema` 金数更新。**全量红数与 HEAD 逐条一致(37)** |
| **02 ✅** `job` 类型骨架 | `job_type='job'` 全链路打通:`codeJobConfigSchema`(只存 handler 名 + args,**代码不入库**)+ `code-job-registry.ts`(未注册即抛错并回显已注册清单)+ `CodeJobExecutor`(AbortSignal 超时、config 解析在 try 内、每条失败路径都终态写行)+ `builtin-jobs.ts` 内置 `task-lifecycle` seed(确定性主键 `builtin-<handler>`、**enabled=0**、只修 handler 指针不回滚用户改动、占位 handler 自报"未实装(票03)")+ `concurrency.ts` 把三份各自 parseInt 的 `MAX_PARALLEL_WORKSPACES` 收成单源 + `countActiveWork()` 并表计量,三处消费点全部改用 | 已完成。31 测试(code-job 11 / builtin-jobs 9 / count-active-work 13)。两条**测出来的事实**:① `idx_sched_execs_unique_active` 已保证一个作业只有一条 live fire,故 DISTINCT 计量是双保险;② `job_type='job'` 的 fire **必须排除在并发闸外**,否则内置 job 每分钟一跑永久吃掉 3 槽之一。`TERMINAL_EXECUTION_STATUSES` 单一真相源 + 金测钉住它与 `ux_exec_task_active` DDL 完全一致(SQL 不能 import 常量,这是唯一防线) |
| **03 ✅** 一次原子翻转 | 四职责 job `task-lifecycle` 实装(① due-scan 插 pending 执行 ② 闸内领取并 start ③ 引擎回调同步 finalize ④ reconcile 回收滞留);`readyTask` 停造信封;`trigger/cancel` 改写 `tasks.trigger_*` + 新增 `POST /:id/trigger/schedule`/`unschedule`;任务侧 6 处 finder + 3 表写全删(`services/tasks/**` 调度引用归零);`WorkflowExecutor` 的 isRequirement/v4 复用/phase seed-collect/composite 四块搬空;`TaskScheduleStatusListener` 与 `orphan-reaper.ts` 删除;泵的 `checkQueuedTasks` 领取循环删除(已无生产者);v42 删 `origin_type/origin_id/origin_role/assoc_meta/scheduled_at`;任务域 materializer 迁回 `services/tasks/task-materialize.ts` | 见 §12。**硬门槛已过**:`task-lifecycle.test.ts` 45 测试含双起守卫(latch + guarded claim + 重叠幂等)、跨类闸、cron 续算、对账回收 |
| **04 ✅** composite + 验收 | 子单元 = child executions(`parent_id`+`task_id`)、`TaskDispatchPort`→`dispatchChild`/`ChildHandle{child_id}`、resume 改为**派生**(parent_id + 父的等待节点，两种持久化都认:`node_executions.status='pending_task_dispatch'` 或 task_dispatch 节点仍 running)、超并发留 pending 由 job 领取(`alreadyClaimed` 收口重复 start)、`parent_task_dispatch` 标记与 `setResumeParentCallback` 删除、父失败聚合(子 failed → coordinator 自判 completed 仍折 failed)、**丢唤醒 tick 自愈**(`recoverStuckDispatchParents`，只在父引擎仍在本进程时救)。 | 已完成。`composite-dispatch.test.ts` 5 测试(coordinator 形状 / 子完成唤醒父 / 失败子也唤醒 / 超并发子被领回并带 resume 接线 / 丢唤醒自愈 + 两条负向)、`tasks-v3-dispatch` 全绿 |
| **05 ✅** API/UI | 读模型收进 shared:`Task` 自带 `trigger_*` 七列 + `execution` badge(删 `schedule_status`/`scheduled_at`/`ScheduleStatusListener`/`OriginType*`/`TriggerSource`/`OriginRole`);badge 加 `name`(子单元标签，取代 origin_role)/`error_summary`(红行原因，写侧每条路径落 `var_pool.error`)/`children`(detail 与 `/executions` 挂，看板不挂);SSE `task_trigger.scheduled_at`→`next_fire_at`、`task_status` 去 origin_type/schedule_id、`TASK_EXECUTION_EVENT` 上契约;`jobTypeSchema` 单源 —— `createJobSchema` 原本写死 `['workflow','agent']`，票02 加了类型却没开门，现 `job` 行可经 API 创建/筛选，列表 `?job_type=` 由 cast 改校验。 | 契约见 `ticket05-contract.md`。shared `task-domain-schema` 39 绿、server `tasks-routes` 18 绿(新增读模型 2 条)、`task-lifecycle` 51 绿(新增原因落行 6 条)、`scheduler-routes` 23 绿(新增 job_type 过滤 1 条)、`orchestration-strategy` 15 绿;web 半张票见票05 前端项 |
| **06** e2e | 6 个 spec 从"查 schedules API/表"改"查任务执行列表";补端到端故事:草稿→入队(断言 `schedules` 无任务行)→定时 T+1min→自动起→转 running→abort 立停 | 6 spec 绿 + §8 手测清单 |

## 7. 风险

1. **任务专属逻辑搬家**(最高危):`WorkflowExecutor` 里 isRequirement 分支 / v4 工作区复用 / phase seed-collect / task-home collect 搬进 job 时语义漂移 → 先把四处 `isRequirement` 读点列全并加表驱动测试,再搬;搬一步测一步,不攒批。
2. **终态清单漂移**:闩锁是 `NOT IN (终态)`,漏列会让槽位过度保守(滞留占槽,靠对账解),错列存活态进终态则双起风险回来 → 票 03 的并发用例 + 一条"两个执行器同时领取同一 pending 行"的断言。
3. **跨类并发闸**:`countActiveWork()` 若漏改一处消费点,上限失真(任务绕过或作业饿死)。
4. **内置 job 被用户删/关**:seed 需可重入(每次启动幂等 upsert),且 UI 只给"暂停",不给删除。

## 8. 验证

`pnpm --filter @octopus/server test`(门是 vitest;`tsc --noEmit` 基线 722 error,非门)· e2e `pnpm --filter @octopus/web-app test:e2e`。

手测(`pnpm dev`):① 草稿→入队后 `schedules` 表**零条任务行**、`tasks.status='ready'`;② 定时 T+1min 不点任何东西到点自动起;③ cron `* * * * *` 的 ready 任务连续两起、上一轮未结束时 UNIQUE 抑制重复;④ abort 立即停引擎、槽位释放、无滞留;⑤ 系统调度页只见作业(含内置 `task-lifecycle` 一行,可见其上次触发与耗时),任务不再以作业身份出现;⑥ 重启 server,待触发定时/周期任务照常到点,内置 job 幂等重建。

## 9. 票 01 落地附记(实测踩到的四颗雷)

**排期修正**:原计划"票 01 建 `cron_jobs`+`scheduler_runs` 两张新表并在同票 drop 旧三表"。方案在实现中途被 ADR-0021 的 `job` 类型设计取代 —— 两张新表与其 42 个契约测试已在 2026-09-10 删除(`executions` 本就是一次运行的天然载体)。旧三表相关列的删除与泵翻转同票(票 03),因为它们在票 02 之前仍被 engine/executor/tasks/V1 `WorkspaceScheduleService` 四方读写,先删必把仓库留在启不来的状态。

1. **`migrateTasksStatusCheckV40` 用硬编码列清单重建 `tasks`** —— 在 `ensureColumnsForExistingTables` 里新加的 tasks 列会被它随后的 swap 吃掉(v40 re-entrancy 测试实测 `no such column: next_fire_at`)。票 01 已把 v41 列拆成独立 `ensureColumnsV41(db)`,在 `migrateTasksStatusCheckV40` **之后**调用。**以后往 tasks 加列一律放这个位置。**
2. **`SQLITE_CONSTRAINT` 前缀 ≠ UNIQUE** —— 拿它判"重名/已有活跃实例"会把 NOT NULL、FK 违约静默改写成业务冲突。判据要收到 `SQLITE_CONSTRAINT_UNIQUE`。
3. **`schema.sql` 是单脚本顺序执行** —— `tasks` 建表在 Agent Tables 分隔之后,给它的索引必须写在它后面(`idx_tasks_due` 已挪至 Tasks indexes 段)。
4. **`tsc --noEmit` 不是本仓库的门**(HEAD 基线 722 error:`@types/better-sqlite3` 缺失引发 TS7016 连锁 + 若干联合类型收窄)。门是 `vitest`。别追类型噪声,也别拿"tsc 干净"当完工标准。
5. **server 测试里的 `@octopus/shared` 解析到 `dist/`,不是 `src/`** —— 往 shared 加新导出后若不 `pnpm --filter @octopus/shared build`,运行时拿到 `undefined`(票 02 实测:`TERMINAL_EXECUTION_STATUSES.map` 直接炸,`codeJobConfigSchema.parse` 同样会炸)。**改 shared 必重建再测 server**。纯类型导出(`type JobType`)被擦除所以看不出来,更容易骗过本地验证。

**既有红(stash 对照确认与本次无关,票 01 前后逐条一致)**:9 文件 / 37 测试 —— `clone-file-mgmt`、`harness-integration`、`prompt-assembler`、`scheduler-routes`(2 条 G7/task-author clone session,requirement 自动建 session 路径已在 SG1b/F3 移除而测试未跟)、`archive-routes`、`repos-routes`、`config-manager`、`archive-service`、`detector-pipeline`。**后续票的绿判定基线 = 37 红不变。**

## 11. 验证基线(票 01–03 实测,后续票照此判绿)

- **server**(`npx vitest run --root packages/server`):票03–05 后仍 **36 红 / 9 文件** = archive-routes 10 · clone-file-mgmt 10 · config-manager 4 · harness-integration 4 · prompt-assembler 3 · detector-pipeline 2 · archive-service 1 · subsystem-adapter 1 · repos-routes 1(票01/02 基线是 37 红,少的那条是 scheduler-routes 的 G7 遗留,该文件在票03 按新契约重写后全绿)。判绿口径:**这 9 个文件之外的任何红都是本次引入**;文件内红数变化需要逐条解释。
- **engine**:**4 红 / 4 文件**,全部与本次无关且已逐条核因 —— swarm-host-agent TC-037(模型 fallback)、outputs-resolver 字面量、pr-workflows + octopus-wf-e2e-tester 两个 collection 错误(`core-pack/workflows/octopus-dev-s1-pr-flow.yaml` 文件不存在,环境缺件)。task_dispatch 三份测试(child_id/childHandle 改名后)17/17 绿。
- **shared**:**4 红**(model-alias 1 + clone-git 3),环境红,与本次无关。
- **web-app**:**9 红 / 5 文件**(app/system、harness-floating-panel ×3、knowledge-ui ×3、question-card ×2、execution-summary 的 AI 用量条),数值本身不稳定 —— `components/tasks/__tests__/execution-summary.test.tsx > AI 用量统计条` 在 **HEAD(无本次改动)重跑时也偶发失败**(实测同机两次:9 红、8 红),属既有隔离/顺序 flake,**不是本重构引入**。判绿口径:红数 ≤9 且不出现 `tasks-v4-*`/`task-board`/`tasks-api`/`scheduler-*` 家族新红。
- **改 `packages/shared` 后必须 `pnpm --filter @octopus/shared build`**,否则 server/web 测试拿到的新导出是 `undefined`(§9 第 5 条)。


## 12. 票 03 落地附记(实测雷,票 04–06 必守)

1. **`countActiveWork()` 的三条口径必须分开记,不能"顺手统一"**:job 的 fire 不计数、任务侧根**与子**都计数、但 `pending` 不计数。第三点尤其反直觉 —— 它与 `ux_exec_task_active` 用同一张表却**故意不同**:闩锁管身份(排队中也算占着这个任务),闸管算力(排队中没占机器)。把两处"统一成一个清单"会让闸自锁(三个 armed 任务读成已满,谁都起不来)。
2. **删掉一个循环前必须查它是否还是别的写入者。** `checkQueuedTasks` 删后 `schedules.status/claimed_at` 再无写入者,`abortJob` 守卫恒 400、`checkStaleClaimed` 恒不命中 —— 三处都不报错,只是功能静默消失。补回点在 `dispatchExecution`/`onExecutionComplete`(唯二知道一次触发开始/结束)。
3. **删掉一个方法的所有调用者后,它自己就变成不可运行的死雷。** `wake()` 原来 `checkQueuedTasks().catch(...)`;领取循环删后唯一调用方(`tasksService.setWakeScheduler`)也删了,而把它改成 `reload().catch(...)` 会写成一个**同步函数上挂 .catch** 的 TypeError —— 因为没有任何调用者,单测与全量都抓不到。结论:改完一个入口就把它的调用方 grep 一遍,**没人调用的入口直接删**,不要留"以后可能用"的壳。
4. **esbuild 不做类型检查,重命名参数会漏成真 bug。** `computeTaskWsLaunchParams` 的 `scheduleId/triggerSource` 改成 `instanceKey/naming` 后,`WorkflowExecutor` 仍按旧名传参:运行期 `naming` 为 undefined → 命名静默走 cron 分支,以及一处 `assocBranchSuffix` 残留直接是 ReferenceError。**改过一个函数签名就对该文件跑一次 `tsc | grep <file>`**(全库 tsc 有 700+ 历史 error,不能当门,但按文件过滤够用)。
5. **测试里改 `process.env.HOME` 必须存还**。它在同一 worker 内泄漏给后续文件,表现为"单跑全绿、全量偶发红",是本次最难查的一类。
6. **`Test Files N failed` 里的"2 红"多半是 collection 错误**(导入即挂),不是两个断言失败。判红先 `npx vitest run --root packages/server <file>` 单跑一次再定性,否则会去修根本不存在的断言。
7. **批量脚本改多个文件时,每个文件都要单独写盘并 grep 复核。** 本次一次 schema.sql 的删列在"一个脚本改两文件、只在末尾写最后一个"里被静默丢弃,后续 tsc 全绿(因为没人读那些列),直到 idempotent 测试报 `no such column: origin_type` 才发现 —— DDL 改动没有编译器兜底,只有 `PRAGMA table_info` 断言有。
8. **`DROP COLUMN` 前先 `DROP INDEX`**:SQLite 拒绝删除被索引引用的列,而失败若被 try/catch 当"非致命"咽掉,列会静默留下。v42 迁移的顺序(先 `idx_schedules_origin`/`idx_schedules_due`,再逐列 drop)由 `schema-migration.test.ts` 的 graft-旧库用例钉住。
