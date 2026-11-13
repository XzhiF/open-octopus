# 00 · 工作舱 Cabin 总览

> 入口文档。实现基准 = 本 design/ 文档集 + 计划 `slow-glade-hawk.md`。原型 UX 参照 `../index.html`。

## 是什么
Cabin = **绑定目录、长期存活**的开发座舱。一个 cwd 目录 = 一个舱。层级 **Cabin ⊃ Workspace(任务执行环境) ⊃ Worktree**；克隆仓库仍叫「仓库」。AI-native：一切由持久主对话（orchestrator）驱动，作业坞/面板只是监督面。

生命周期：`draft → initializing → active ↔ dormant → archived ⇄ active(重开)`。**archived 非终态**（C1）。

## 三个已定决策
1. **全量一次设计**，按依赖分阶段执行（P-1–P5，见 08）。
2. **前端 = 桌面内嵌 + 兄弟壳兜底**（2026-11-13 按 index.html 原型调整）：工作舱的创建/切换在桌面壳内完成——左栏「工作舱 · 任务 · 会话」三段常驻，新建走对话区 `pendingCabin` hero，进舱只切对话上下文，URL 始终停在 `/`；`/cabin/:cabinId` 的 `CabinShell` 保留为深链兜底。复用 chat 优先桌面原语（ChatPane/ChatArea/TuiTranscript + 作业坞 + 浮窗 + DesktopHeader）。
3. **磁盘 = 复用 workspace 契约**：舱目录即长期 workspace，`projects/<repo>` worktree + `config.json.repos[]`。不新建 `repos/`+`.worktrees/` 字面布局 → round-evidence/archiving 零改动复用。

## 关键设计澄清总表（C1–C12）
| # | 约束 | 已确认分叉 | 详设 |
|---|------|-----------|------|
| C1 | 舱=长期任务，归档可重开 | 软封存全保留；delete 才级联 | 01/08 |
| C2 | 执行任务=复用现有任务，舱只调度 | tasks.cabin_id 关联+agent 可知 | 02 |
| C3 | 舱主 chat=组织调度者，不亲自干活 | 角色提示词软约束 | 02 |
| C4 | 用户↔舱=单线程串行队列 | transcript 即收件箱，无新队列表 | 03 |
| C5 | 调度者有界自决 | explicit 自决/inferred 评估；off/observe/auto | 02 |
| C6 | agent 间交互要有 trace | cabin_jobs+cabin_job_events；复用子代理形式 | 04 |
| C7 | 消耗完整统计 | llm_calls_costed 派生；子代理单列防双算 | 05 |
| C8 | 作业优先级聚焦 | cabin_jobs.priority+focused_job_id | 06 |
| C9 | 主控↔doer 通信机制 | 统一语义层+异构传输；wake 绑主会话 | 04 |
| C10 | 汐音交互反馈 | orchestrator 拟人面，非独立 agent | 07 |
| C11 | dormant 触发 | 自动阈值+手动（守卫三条件） | 08 |
| C12 | multi-org | v1 单 org/舱 | 01 |

## 与现有实体接缝
- 复用：WorkspaceService（attach/create/ensureWorktreesForReuse）、WorkspaceGit（initWorktreeOne/writeSpecWorktreeMeta）、gitOps（syncToDefaultBranch/worktree*）、cloneProject、TasksService/TaskThreadService/deriveTaskView、archiving-service/ArchiveIngestService、round-evidence-service、findings/FindingOpsService、chat-event-bridge、subagent_runs、llm_calls/llm_calls_costed。
- 新增：cabins/cabin_iterations/cabin_jobs/cabin_job_events 四表、CabinDAO/CabinService/CabinInitService/CabinCommService/deriveCabinView、cabin-orchestrator preset、routes/cabins、前端 cabin/ 组件集。

## 种子场景（演示）
Aurora 结算平台 `~/cabins/aurora`：3 仓（gateway/ledger/web）、3 迭代 M1/M2/M3、并行 worktree、attention 四态（待验收/待回答/待裁决/审批）。

## 范围边界
本阶段实现 Cabin 全旅程；multi-org 跨 org、自动沉淀增强等留 v2（见 08 开放项）。

## 文档导航
01 数据模型 · 02 调度者 · 03 串行收件箱 · 04 通信+trace · 05 消耗 · 06 优先级聚焦 · 07 前端 · 08 分期+验证。