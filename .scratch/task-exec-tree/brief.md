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

## 验货台 tab 化（v2.2，2026-09-16 用户 UI 回灌）

用户三连击：①弹窗宽度不够、右列按钮文字被截；②没有全屏/拖动/调大小（「跟任务草稿窗一样」）；③切 tab 点点点后界面卡死。裁决：**「把这个界面作为 tab 页放到红框的这个『任务执行控制台』里面，类似『流程|活动|产物』这些 tab 一样」**。

### 方案 = 退役弹窗，收编为控制台 tab

- **AcceptanceSurface**（新 `components/tasks/acceptance/acceptance-surface.tsx`）：原 AcceptanceModal 全部数据流/三栏 UI 平迁，去 `open` 门（挂载即活）；根锚点保留 `data-acceptance-modal`/`data-testid=acceptance-modal` + `data-acceptance-col-*`，**e2e（task-phase-acceptance / lifecycle）选择器零改写命中内嵌面**。`ImpactApprovalList` 搬 `acceptance/impact-approval-list.tsx`。`acceptance-modal.tsx` 删除。
- **控制台 tab**（task-run-console）：有待验收轮即亮 `[▶ 执行控制台 | 🔍 验货台 P{p}·R{r}]`；判决条「完整三栏证据面 ↗」改「验货台核对实物 →」= 切 tab；条内 🔍 钮同效。**通过/中止 → onDecided 弹回控制台 tab；打回不弹**（回显卡+影响清单留在原地）。tab 不随派生态消失硬撤（防 seam 被踢没）。
- **三个抱怨的对账**：①宽度 = 继承控制台视口百分比宽（默认可调）+ 右列 320px + 通过/打回/中止钮 `whitespace-normal` 换行不截断（实测两视口 scrollWidth/clientWidth 零截断）；②拖/缩/全屏 = 父窗自带（chrome 契约原样），弹窗层 3→2；③卡死 = headless 复现 rAF 全程 <160ms 无 CPU 冻结，实锤的是多层 modal 叠加的交互死锁面 + **核对 tab 懒载死锁**（旧 specLoading 进 deps → setSpecLoading(true) 触发 effect 自重跑，cleanup 抢在响应前 cancelled=true，永卡「读取契约结构…」；tab 化后此景=用户所述「切一下 tab 就卡」）。改 `specFetchedForRef` once 门（不进 deps），实测 `ac-matrix-us` 上屏 = spec.md 真到手。
- **看板「验收」按钮**：不再开独立弹窗 → `startOnAcceptance` 直达 TaskModal 验货台 tab（TaskModal→TaskRunConsole 透传）。

### 验证记录（v2.2）

- web 全量 580 绿 / **6 失败 = 既有基线原样**（harness×3+knowledge×3，system-pages 文件级）；console 14（新增：证据链接切 tab / 切回 / 条内钮 / startOnAcceptance 直达 ×2 视口用例合并计 2）、surface 23 全绿——含一处**旧测试自带 race**（同步 querySelector 抓 patch 行，旧弹窗版侥幸微任务序绿）改 waitFor 内查询。
- 真浏览器双视口（1460×930 + 1280×720 桌面 Chrome e2e 同档）矩阵全绿：直达 tab ✓、截断 0 ✓、sub-tab 狂点×5 lag <35ms ✓、核对 tab US 块+全局对账渲染 ✓、文件开合+重进 tab ✓、**关控制台后 body pointerEvents=auto / overlay=0 / 看板可点 ✓**（`html overflow:hidden` 为 app-shell CSS 恒值，非 remove-scroll 泄漏，fresh load 对照钉死）。console errors 两视口零。截图 `tmp/tab-check/`。
- 遗留小刺（知情不修）：判决条「✕ 打回」现在只切 tab，反馈面板需在验货台内再点一下「打回（写反馈）」展开（省一个 intent 透传 prop，行为可接受）。

## v2.3 续座（同日用户两轮回灌）：两栏版面 + 紧凑账目口径 + 卡拖拽根治

**用户线索**：「卡死」实为**鼠标划选文字后界面死锁**。headless 复现划选（长文/拖出窗外/textarea，含查看器内三轮来回划选）rAF 全程 <30ms 无冻结 —— 弹窗层收掉后此路已净；顺藤摸到真正的死锁体质：**拖窗/缩窗/分栏线把 move/up 挂 document，窗口外松手或失焦时 `pointerup` 永不到达 → 监听器残留，此后每个 move 都在搬窗/改尺寸 + `userSelect:none`/cursor 泄漏**（体感即「动不了」）。三处同病根一并硬防：task-modal 拖窗+八向缩（`buttons===0` 即收兵 + `pointercancel` 兜底）、authoring-workspace 分栏线（同 + `mouseleave`）、harness-floating-panel 拖/缩（`buttons===0`）。

**两栏版面（用户裁决：三栏把中列挤窄）**：验货台改 `grid-cols-[minmax(0,1fr)_360px]` 两行右栏 —— 实物|核对|叙述 主面吃满剩余宽（1460 视口下 691px，父窗可拖更大）；执行摘要（上，max-h 46% 滚动）+ 动作区（下）合并右侧栏。DOM 序不变（摘要→主面→动作），窄屏 max-lg 折叠纵向。钮文字截断实测 0。

**紧凑账目口径（用户圈定 cost-tab 风格、明令去掉工具调用）**：`AggInline`（execution-summary 新出口）= `∑处理量 ↑入 ↓出 ⚡缓存读 🗡️缓存写 · N 次请求 · $费用`。替换四处旧文案：phase-surface `aggLine`（轮次行/LIVE 卡/交付报告「94 calls · $6.28 · ↑654 ↓76.7K」怪串整体退役）、TaskAiUsageCard 数值行、导航条 token 段（dim 传深色 token class）、rail「次调用→次请求」。真任务回灌渲染 `∑5.8M ↑654 ↓76.7K ⚡5.4M 🗡️263.3K · 94 次请求 · $6.28` ✓。

验证：web 全量 580 绿 / 6 失败=既有基线原样；tsc 触及文件零新增错（残余 1 条 draft-batches 与 children-prop lint 均既有）；两栏+口径浏览器实测截图 `tmp/tab-check/E-layout-*.png`。

## 验货台 v2.4（2026-09-16，二单 DateUtils 实单回灌）

**右列滚动治理（用户：「这里滚动条。。太扯淡的」）**：执行摘要去 `max-h-[46%]/overflow-y-auto` 改自然高全展示（摘要行 `truncate`→`min-w-0 text-right break-words`，Workflow code→break-all，根治 flex min-width:auto 撑破 360px 引出的横向滚动条）；动作区保留 `overflow-y-auto` 仅作溢出兜底（内容短，实测无滚动条）。根因二：`AggInline` 根 span 带 `shrink-0` 且内部不换行（为深色导航条防挤压加的那颗，把 359px 摘要列撑到 419px）→ 改 `min-w-0 flex-wrap gap-y-0.5`，bar 处的防挤压交回调用方 `className="shrink-0"`。SectionCard 头 right 容器加 `min-w-0 flex-wrap justify-end`。实测：摘要/动作/主面 横向纵向滚动条全零，账目在卡内两行折好。

**打回反馈弹窗化（用户：「直接弹窗，我输入，而不是现在展开，写得太别扭」）**：右列 `rejectOpen` 内联面板整体迁入贴纸 Dialog（`[data-reject-dialog]`，sm:max-w-[540px]，与任务草稿同皮肤）——大输入框 autoFocus rows6、路由二分 radio、取消/打回确认（空反馈 disabled）照旧。按钮从 toggle 改单向 setTrue。**锚点迁移**：面板 portal 到 body 后 `[data-acceptance-modal]` 后代选择器断链 → e2e 两 spec 的 `[data-reject-*]` 全部改页级 `[data-reject-panel] [data-reject-*]`（9 处）；vitest screen 级查询无感。

**二单实单记录**：API 直建 v4 任务配方 = POST /api/tasks（task_spec.format=v4 + phases[specPath/workflowRef/inputValues.batch_dir="${phase.batch_rel}"] + acceptance_verify）→ PUT home-file 写 spec.md → POST ready → **POST trigger（ready 不自动点火，手动触发）**。坑：种子只写 spec.md 不写 issues/*.md → 流内 fail-fast 止损（0 烧钱），安全守护 Agent 自动按 spec「Ticket DAG」表转录三票落盘 → 打回一轮即全绿。教训：**API 建单要在 ready 前把 issues/ 一并 PUT 落盘**。验证：web 全量 580 绿/6 失败=基线；打回弹窗 jsdom+真浏览器双实测（开/输/禁→启/取消，未提交）。

**v2.5 右栏单滚动壳（用户：「动作区还有个上下的滚动条。单独的。很恶心」）**：v2.4 的动作区“溢出兜底滚”在矮窗口仍出条 → 版面从 grid 双行改 `flex + order`：摘要与动作合进同一个 360px 滚动壳（DOM 序 右栏→主面，order-1/order-2 还原视觉；max-lg 用 flex-col-reverse 主面上）。壳 `overflow-y-auto` 但内容装得下时浏览器不出条 —— 1460×930 实测 rail scrollHeight 737 == clientHeight 737，全画面每区零滚动条。data-acceptance-col-summary/-actions 锚点原样（e2e 不破），23+14 单测绿、全量 580/基线6、tsc 净。
