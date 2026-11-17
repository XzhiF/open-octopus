# 08 · 分期 + 验证 + 风险

## 分期（依赖序）
- **P-1 原型对齐（已完成·用户审阅门禁）**：原型按调整清单改（projects/ 文案、封存可重开、迭代派生、消耗口径、八列看板、验收经裁决、作业/trace 窗、自决开关、focus 态）。用户确认后才进 P0。
- **P0 设计文档集 + 数据模型/DAO/服务骨架**：design/ 九文档；schema.sql 四表+链接列；db/types.ts；cabin-dao.ts(+ALTER)；createAllDAOs/dao/index 注册；shared/types/cabin.ts；cabin-service.ts 骨架；derive-cabin-view.ts 纯。AC：schema 旧库幂等；DAO CRUD+乐观锁单测绿；derive 纯函数测试过。
- **P1 创建+初始化编排+API**：CabinInitService(门禁1–6+持久化+SSE)、cabin-orchestrator preset、routes/cabins 全端点、index.ts 挂载。AC：create→init→active；config.json.repos[] 使 resolveRepoDir/resolveWorktree 零改动；init 失败 retry 幂等。
- **P2 兄弟壳+chat 底座+S1/S2/S3**：routes/app-shell/route-components、CabinShell/Provider/Rail/ChatHost、NewHero/InitGateCard/Overview、cabin-api/use-cabins。AC：/cabin/:id 渲染；向导→init 流式→座舱 attention。
- **P3 仓库/工作树 S5+任务 S6+作业派发/trace(C2/C6/C9)**：CabinModulesLayer、Repos/Worktrees、Tasks+cabin_id 过滤、cabin_jobs/events、CabinCommService(wake 绑主会话)、dispatch/note/resume 工具、CabinJobs/TraceWindow。AC：clone→worktree；派发→跑→变更/验收；trace 留痕；round-diff 复用。
- **P4 迭代+知识 S7+交互模型(C4/C5/C7/C8)**：iterations CRUD+派生、Knowledge、完整 attention+AttentionQueue、自决+autonomy+mandate、usage+UsageWindow+chip、priority+focus+claim 排序。AC：进度派生；串行一次一条；explicit 自决/inferred 确认；消耗防双算；提优先+focus 抢占。
- **P5 设置 S8+汐音+archive/dormant+打磨**：Settings、CabinCrew+肖像+prefs、wake/archive/reopen、dormant 自动阈值(C11)、tuning/audio。AC：dormant→wake 自愈；archive 软封存/reopen；汐音心情端到端。

## 复用映射（精要）
WorkspaceService/WorkspaceGit/gitOps/cloneProject · round-evidence/archiving/ArchiveIngest · TasksService/TaskThreadService/deriveTaskView · InitService 幂等 · chat-event-bridge · ChatPane/ChatArea/TuiTranscript · app-window/task-modules-layer/WorkspaceExplorerDock · KcCard/useKcFindings/FindingOpsService · subagent_runs/subagent-window · agent_events/harness_events/interaction_messages · llm_calls/llm_calls_costed/sessionUsage/usage-window · tasks.trigger/concurrency gate · 原型 crewState/xySay/AudioEngine。

## 验证
- 单元(vitest)：deriveCabinView(attention 矩阵/等谁/迭代进度，表驱动)；CabinInitService 状态机(幂等 retry/skip-done)；CabinDAO(旧库 ALTER/乐观锁/findByPath 唯一)。`pnpm --filter @octopus/server test`。
- 集成：create→init→task→archive 用 e2e-harness lib；断言 config.json.repos[]、resolveRepoDir/resolveWorktree、门禁 active、cabin_id 级联。遵循 matt-e2e 反假跑。
- 交互模型：attention 排序；jobs→events 留痕→派生不双写；usage 防双算对照手算；priority/focus 抢占；autonomy 分支。
- Playwright：e2e/cabin-shell.spec.ts 全旅程；复用 e2e/helpers/desktop.ts。
- Dev：`pnpm dev`(web3001/server3000；--isolated)。

## 风险登记（13+补）
1 主线竞争(per-repo 串行) · 2 级联仅 delete(G1 补新表) · 3 init 失败恢复 · 4 dormant(C11 已定) · 5 multi-org(C12 已定) · 6 原型冲突已改 · 7 消耗双算 · 8 优先级饥饿(额外 slot 上限) · 9 串行靠提示+UI 兜底 · 10 mandate 重开 revalidate · 11 wake 绑主会话(G2) · 12 异构降级(subagent 无 mid-run) · 13 汐音非独立 agent。

## 开放项（v2）
跨 org per-repo · 自动沉淀增强 · 自动 dormant 阈值调优 · focus slot 精细配额。