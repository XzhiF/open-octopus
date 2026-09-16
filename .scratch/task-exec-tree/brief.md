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

## 验货台 v2（验收=验货）+ 真任务 web 走查（2026-09-16 续座）

用户裁决：**「验收 = 验货，不是读汇报」**——面板此前 100% agent 自述，v2 把平台持有、从未被看的独立事实接进来。

### 落地构成（server 4e7c40e7 / web b3baa8db / 收尾 5492efa9·4ef285b0·4753723b）

- **实物**（中列默认 tab）：`RoundEvidenceService` round-diff——`executions.start/end_commit_id`（GitOperations launch/终态捕获）圈真实区间，服务端按 task 解析、web 永不见 SHA，过期三态诚实（no_workspace/no_commits/worktree_gone），patch 懒拉 512K 截断。
- **当场复检**：`acceptance_verify`（任务级 spec-field：command/cwd?/timeoutS 5..1800s）经引擎同款 BashExecutor 在**活工作区**现跑；task_verify/_log SSE 流式，终态盖章，verdict .md 落批次目录（叙述区即见）。**绝不自动跑**——▶ 是唯一入口，威胁模型=工作流 bash 同信任级。
- **核对**：`lib/acceptance-matrix` 三方对账（spec 票 × 报告声称 × diff 实物路径），纯解析零 AI，降级不猜。
- **叙述**：v1 批次直读证据面整体降级收容于此。
- 收尾三件：①b3baa8db 两处新增红（复检用例 expect 括号错位；verify 时长裸拼接犯 C4 门→formatDuration）。②**真任务回灌矩阵纠偏**——真实 round-report 是「票|状态|判据结果」3 列表、路径只在全局 Changed Files 段，旧列识别串位+备注恒空 → 0/3 全错标「说了没做」；改列互斥指派 + 裸文件名词干锚（票号 slug 不参与）+ silent 态 + **报告×diff 全局对账**（幻影申报/未上报）。③**过程回放**——活动流此前只吃开窗后 SSE 增量、事后打开恒「暂无事件」（用户三轮反馈「执行过程看不到」实锤）；现 agent-events 节点边界（start/end）压缩成回放行垫入，live 追加其上。

### 真任务走查（靶=octopus-demo-java-common，用户令：别拿 open-octopus 开刀，太重）

任务 `aae32573`「MaskUtils 脱敏工具」：draft→批次 spec/issues 按契约落盘→绑定 built-in/matt-spec-dev→ready gate→trigger→真执行 24m51s/94 calls/$6.28→awaiting_review。走查 12 项全绿（截图 `tmp/walkthrough-shots/`）：三 tab、patch 懒拉、复检 ▶ 实跑 mvn test **PASSED 盖章 + verdict 落盘（叙述 11→12）**、回放 8 行上屏、矩阵 1/3 票级锚 + 全局 4/4 一致、轮次 ↗ 深链节点流程图可达。用户逐一复核：**执行过程 / 批次产物 / 代码 diff，web 端都看得到**。**「验收通过（进入归档）」未点——本轮验收留给用户本人在 :3000 看板执行。**

### 验证记录（v2 续）

- server 全量：**40 失败 = main 当日逐项一致**（v1 记的 35 已过时；含 v2 新增 round-diff 6 + verify 9 全绿）。
- web 全量：6 失败 = 既有基线（harness×3+knowledge×3）；新测试矩阵 15 / console 12（含回放用例）/ acceptance-modal 36 全绿；tsc 触及文件零错。
- Turbopack quirk（dev-only）：改 ac-matrix-panel/lib 后 modal 路由可能仍发旧 chunk（矩阵假 0/3），touch `acceptance-modal.tsx` 即恢复；构建产物无此问题。

### 已知接缝（v2.1 候选，未做）

1. `acceptance_verify` 任务级、起草无出生地（task-author 不产）——现靠验货台自配；应降 phase 级 + 从 E2E 票验证步骤生成初值。
2. 票级锚依赖报告备注写文件路径；matt-spec-dev 现状备注不写 → 主要靠全局对账。抬票级锚率需 ship 段纪律「判据结果带路径」（SKILL 侧，别处改）。
3. 矩阵判定与「验收通过」无联动：FAIL 盖章/幻影申报不拦决策、决策也不附证据快照。
4. 归档（ws 销毁）后 diff 三态过期，verdict .md 是唯一留存实物证据；diff 摘要快照未做。
