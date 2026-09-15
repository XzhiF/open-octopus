# task-exec-tree — 任务执行树

> 2026-09-15 · 分支 `octopus-feat-task-exec-tree` · schema v44

## 问题

任务看板的 v4 任务每一轮 (phase/round) 都建成独立 root (`parent_id='0'`)，
工作区执行树（外层视图）里散成 N 个孤立节点。设计意图是**一个任务 = 一棵树**：
第 1 轮是根，后续轮次挂在上一轮之下。

实例：task `91c5a975` / exec `a04aab5a`（phase 2, running）parent 缺失。

## 改动（代码）

链式规则：`armTask` 起新一轮时，若任务已有实例（终态、同一 workspace）且本轮带
phase 标记 → `parent_id = 上一实例 id`。v3 / composite 协调器等无标记启动保持 root。

判据换轨（核心不变式）：

| 语义 | v43 判据 | v44 判据 |
|------|----------|----------|
| 任务实例（闩锁/badge/历史/reconcile） | `parent_id='0'` | `parent_id='0' OR phase_index IS NOT NULL` |
| composite 子单元臂 | `parent!='0' AND task_id` | `parent!='0' AND task_id AND phase_index IS NULL` |

落点：

- `db/schema.sql` + `schema.ts` v44：`ux_exec_task_active` 谓词放宽到实例（含 fail-closed
  双活预检，冲突则拒绝重建并告警，不炸启动）。
- `execution-dao`：`findLatestTaskRoot(s)/listTaskRoots/listLiveTaskRootsNotIn` →
  `*TaskInstance(s)*`；`findTaskRound` 去 parent 过滤；`listTaskChildRuns` 补 `phase IS NULL`；
  dashboard CTE root/child 两侧同步换轨。
- `task-lifecycle-service`：`isSubunitArmRow()` 统一 arm-vs-instance 判据
  （launchQueued / finalizeLaunch）；armTask 计算 chainParentId（same-ws 守卫：ws 重建则另起新树）。
- `tasks-service.deriveView`：去 `parent_id='0'`（phase 标记即身份）。
- `ExecutionLifecycle`：`$parent/$ancestor` 继承与 YAML defaults 合并只认真子流
  （parent 且无 phase 标记）——链式轮次启动行为与当 root 时逐字节一致。
- `routes/execution.ts`：chain auto_execute 自动接线跳过 task 行（任务树归 lifecycle job 领，
  链引擎不得抢启动队列中的轮次）。
- `token-usage-dao`：工作区健康/趋势/告警/成本六处 root 过滤 → 实例谓词（链式轮不漏统计）。
- 测试：task-lifecycle 新增 9 条（链式建树 / 闩锁 / badge 跟链尖 / launch 走任务路径 /
  臂与轮区分 / v44 迁移幂等 / 跨 ws 起新树 / v3 不链）。

## 数据修复

`fix-data.sql`（同目录）。只动终态散根，按 (task, workspace) 分段，幂等。

★ 时机：必须在新代码重启后执行。当前全库唯一待链行 = 正在运行的 `a04aab5a`：
旧服务器 finalize 现读 `parent_id`，改链在飞的行会让它误走子单元分支
（collect / 待验收 / 任务镜像全丢）。终态行提前改链会让旧 deriveView 查不到本轮
（验收 409）。顺序：phase 2 跑完（旧代码按 root 正确收尾）→ 重启 → `sqlite3 ~/.octopus/db/octopus.db < fix-data.sql`。
若期间旧代码又起了 phase 3（散根），脚本重跑一次一并收编。

## 验证记录

- 副本演练：UPDATE 后 `a04aab5a.parent=38127532`，树成型 ✓
- 服务端全量 vitest：与 main 基线逐项一致（35 个失败均为既有环境/快照问题），无新增失败
- 运行中的 3001 服务未受影响（dist 重建为内容哈希，进程内旧代码继续跑，重启后生效）
