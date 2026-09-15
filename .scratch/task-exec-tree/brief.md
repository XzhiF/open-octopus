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

（2026-09-16 更新：phase 2 终态后已执行，a04aab5a → parent=38127532 链成 ✓；
用户重启 3001，v44 生效，前端执行树关联渲染确认。）

## 验收证据面（续座：中列接批次目录）

树修好后暴露的下一层问题：待验收三栏证据面中列「产物核对」对 v4 任务恒空 ——
它读 `GET /:id/artifacts`（artifacts/ 目录扫描），而真正证据（round-report /
handoff / code-review / spec / issues / e2e-data / probe）全在
`{home}/.scratch/<date>/<slug>/` 批次目录，collect 每轮回流但面板从来看不到
（旧注释自称「登记可见 v4.1 接缝」，实为接错数据源）。

改动（无 schema 变更，SCHEMA_VERSION 保持 44）：

- server `task-home-service`：home-file **读门**从 `.md`-only 放宽到 `.scratch/**`
  任意文件（mode "read"），新增 512KB 上限（`MAX_HOME_FILE_READ_BYTES`，超限 413
  TOO_LARGE）；写门（PUT/mode "file"）守卫原样。`listHomeDir` 加 `includeAll`
  （跳 dotfile；`batchTree` 不动 — 作者态依赖其 md-only 形状）。
- server `routes/tasks.ts`：`classifyError` TOO_LARGE→413；`GET /:id/home-file`
  的 list 分支识别 `&all=1`。
- web `lib/tasks-api`：`listHomeDir(taskId, dir, {all})`；镜像上限常量。
- web `ArtifactViewerDialog`：新增 `homeEntry` 模式（getHomeFile 取内容，
  403/404/413 降级文案分支；entry 模式两个既有消费方零改动）。
- web `acceptance-modal` 中列重写：批次定位 **specPath 优先**
  （`isRelativeScratchSpec`+`batchDirOf`，与 server `phaseSpecDir` 同语义），
  绝对/缺失回退 `getBatchTree` slug 匹配；`round-report.md` 顶部内嵌
  MarkdownPreview；mtime ∈ round 时间窗 [started_at??created_at, completed_at]
  打「本轮」徽章（seed/collect 双向保留 mtime 是判据成立的前提）；二进制/超限行
  「不可预览」置灰但可见（.db 存在性=证据）；SSE task_artifacts_update 改指批次重拉。

验证：server `tasks-home-file` 18 绿（G3 403→404 契约变更钉 + E1-E3/L1-L3 新覆盖）、
`tasks-batch-tree` 7 绿；server 全量 35 失败 = main 既有红群逐项一致，无新增；
web `components/tasks` 137 全绿（acceptance-modal 中列用例重写 + 状态面 5 例 +
artifact-viewer-dialog 新套件 4 例）；web 全量 6 失败 = 既有基线（stash 对照吻合）。

## 验证记录

- 副本演练：UPDATE 后 `a04aab5a.parent=38127532`，树成型 ✓
- 服务端全量 vitest：与 main 基线逐项一致（35 个失败均为既有环境/快照问题），无新增失败
- 运行中的 3001 服务未受影响（dist 重建为内容哈希，进程内旧代码继续跑，重启后生效）
