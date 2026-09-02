# 03 — Workspace 与执行生命周期（research）

Type: research
Status: resolved

## Question

摸清 workspace 现状以支撑"一任务一 workspace、跨 phase/round 复用"的设计：

1. createFromSpec 的创建时机与参数（当前每次 trigger 新建 ws？）
2. worktree/分支生命周期：命名（task:{title}-MMDD-HHmmss、branch taskpool-{org}）、abort/完成后的清理时机（异步 rm）
3. 同一 ws 跑多次执行在现有代码里是否已可能（schedule ↔ execution ↔ workspace 的关系基数）
4. 多 project task 的 worktree 布局；端口/dev-server 分配
5. 复用一 ws 跨 N 次执行需要动的文件清单（scheduler-service / workflow-executor / workspace.ts / 前端深链）

## Answer

### 结论先行

**「一个 workspace 跑 N 次执行」在 DB、ExecutionService、手动路径、chain 机制四个层面已经是现成能力；缺的唯一一环是 scheduler 任务链路（WorkflowExecutor）写死了"每次 trigger 新建 ws"。** 复用的改动集中在 executor 加一个"ws 已存在则绑定复用"分支 + task 表加 workspace 绑定，不动数据模型主干。

### 现状事实

**1. 实体关系（基数天然支持 1:N）**
- `executions.workspace_id` → ws:executions = 1:N，且有现成查询 `execution-dao.ts:18 listByWorkspace`
- `schedule_workspaces` 关联表：schedule:ws = 1:N（每次触发插一行，workflow-executor.ts:266-276）
- `schedules.workspace_id` 列存在（手工创建的 ws 内 schedule 用；task 物化的信封不用，靠每次新建）
- 部分唯一索引 `idx_sched_execs_unique_active (schedule_id) WHERE status IN ('triggered','running')`（schedule-run-dao.ts:89-95）：**同一 schedule 同时只允许一个 in-flight 执行，终态后可再触发**——phase 串行模型（验收后才放行下一轮）与之天然兼容

**2. 同 ws 多执行已有两个现成先例**
- **手动执行**：`routes/execution.ts:102` `svc.service.create(workspaceId, {workflow_ref, input_values,...})` —— 工作空间页对同一 ws 反复跑任意工作流，无任何限制
- **chain 步骤**：`workflow-executor.ts:853-930 triggerChildStep` —— `workflow_chain` 的 root→child→child 在**同一 ws** 内串跑多个工作流（create+start，parent_id/child_index 关联），完成后 enforceRetention。这是"一 ws 多执行"最接近目标形态的既有代码
- `getExecutionService(wsId)` 按 ws 懒加载缓存（execution-service-registry.ts:33-60），从 DB 行重建，**服务重启后照拿**

**3. 但任务执行路径写死 1 执行 = 1 新 ws**
- 类注释与实现：workflow-executor.ts:86-90 "Each trigger creates a new workspace"；execute() 步骤 6（:232-247）无条件 `createFromSpec`，无复用分支
- ws 目录名 `task:{标题}-MMDD-HHmmss`，时间戳唯一化——task-ws-name.ts:8-11 注释明确"同一任务重复触发必须各自落盘"；且 `createFromSpec` 对同名目录 **先 rmSync 再建**（workspace.ts:325-329）：新模型里 ws 名不再 per-trigger，此覆写逻辑是暗雷
- worktree/分支：每 project 一个 worktree 于 `ws/projects/`，分支 `taskpool-{scheduleId}-{ts}` 在 createFromSpec 时一次性生成（workspace-git.ts:150-161），之后无切支概念——**同 ws 复用分支天然连续（后一 phase 直接在前一 phase 的 commit 上叠加），这点零改动**；但若 phase=独立 schedule 信封，branch_prefix 含 scheduleId 会每 phase 换支，需改 per-task 或绑 ws 后沿用其分支

**4. 生命周期与清理**
- completed 后 ws **不删**：enforceRetention 只删该 schedule 下超出 `max_retain`（默认 10，shared/types/scheduler-job.ts:189）的旧 ws（workflow-executor.ts:640,938-955）；task 一次一信封通常 1-2 次执行，够不着阈值 → ws 实际永久保留
- 手动删除：`workspace.delete()`（workspace.ts:415-447）= **先 archiveSvc.archiveWorkspace（失败则抛、拒删）** → DB cascadeDelete → fs.rm 异步
- ⚠ ArchiveService 的"归档"是 **DB 记录快照**（execution/workspaces archive 表 + token/cost 聚合，archive-service.ts:32-70），**不是文件归档**——文件无归档，删 ws 即灭。票 08 的"产物合并归档"没有现成落点，但 delete 前那道 archive-gate 是可借力的卡口
- abort：tasks-service.abortTask（:1260-1330）→ G4 清理（schedule_executions 标 failed + schedule_workspaces 标 cleaned + best-effort cancel），**ws 不删**，留看现场——与新模型"round 打回后可复用/可检查"兼容，但 'cleaned' 标记语义需与"可复用 ws"对齐

**5. 其他**
- ws 无系统级端口/dev-server 分配设施（server 层无 port 管理代码，branch-port.mjs 是 octopus 自身开发脚本）；并发闸 `MAX_PARALLEL_WORKSPACES=3`（env 可调，workflow-executor.ts:20,162-176）
- 多 project：projects[] → 逐 repo `repos/index.md` 解析 worktree（workspace-git.ts:27-60），空数组=coordinator-ws（composite 专用）
- config.json 里 `workflow_chain.slice(1)` 存剩余链（workspace.ts:367）——"phase 序列 = chain"这条偷懒路线在数据层已通，但 chain 是自动串行、无人工验收闸，语义不同（见票 01/04）

### 改动面清单（目标：首次 trigger 建 ws → phase/round 复用 → 归档后清理）

| # | 文件:行号 | 一句话改动方向 |
|---|---|---|
| 1 | workflow-executor.ts:232-247 | execute() 前置查询：任务已有绑定 ws → 跳过 createFromSpec，直接 getExecutionService(ws).create/start（照 triggerChildStep:873-880 的复用写法）；无 → 新建并回写绑定 |
| 2 | task-dao / tasks 表 | 加 `workspace_id` 列（task→ws 绑定唯一权威；现仅能经 schedules→schedule_workspaces 间接回溯，多信封后更不可靠） |
| 3 | workspace.ts:325-329 | 同名 rmSync 覆写逻辑改为显式冲突报错（ws 从"一次性"变"常驻"后此行为是数据毁灭路径）；task-ws-name 时间戳仅在首建时拼 |
| 4 | workspace-git.ts:161 / scheduler-service.ts:195-293 | 分支锚点从 per-schedule 改 per-task（phase 信封换 scheduleId 不换分支）；物化 config 携带 task 绑定信息供 executor 查 |
| 5 | workflow-executor.ts:938-955 enforceRetention | task-origin ws 豁免 retention（或闸条件改"task 已归档"），防 max_retain 误删带未合并产物的现场 |
| 6 | tasks-service.ts:1260-1330 abortTask | ws 保留语义确认 + 'cleaned' 标记与"复用 ws"对齐（round 打回 ≠ 现场作废） |
| 7 | execution.ts:102 路径 / routes/tasks.ts | 新增"对任务 ws 发起一次 phase/round 执行"的 dispatch 入口（可复用 manual create，需过 gate 与 ws 校验）|
| 8 | archive-service.ts / workspace.delete | 归档 gate 处为票 08"文件合并"预留 hook（现仅 DB 快照，文件归档缺位）|
| 9 | 前端 | 深链 `/workspaces/{ws}?execId=` 与 ws 执行列表**已支持多执行，零改动**；任务卡侧按 phase/round 分组属票 01/02 UI 范围 |
