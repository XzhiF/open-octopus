# 07 · 前端（兄弟壳 + 8 屏 + 汐音）

> Vite+React Router v7 手写路由表；状态 Context+useReducer+hooks（无 redux）；Tailwind v4+shadcn+pop 色板。兄弟壳复用 chat 优先桌面 ~80%。

## 兄弟壳接线
- lib/routes.tsx 加 CabinRoute(kind:'cabin', path:'/cabin/:cabinId', componentKey:'cabin-shell') + matchAppRoute。
- components/providers/app-shell.tsx 在同一 provider 栈内分支：`{isCabin ? <CabinShell cabinId/> : <Desktop/>}`。
- lib/route-components.tsx 加 lazy import。共享 chat-session/window providers。

## 桌面内嵌（2026-11-13，按 index.html 原型）
上一版只有兄弟壳：桌面首页看不到工作舱段，新建还要跳到 `/cabin/new`。现在主入口收进桌面：
- `components/cabin/cabin-mode.tsx`：`CabinModeProvider` 持 `activeCabinId / drafting`（active 落 localStorage），`openCabin / startDraft / cancelDraft / exitCabin` 全部不改路由。
- `ConversationHome` 在同一对话区三态切换：普通 ChatTab → `CabinDraftPane`（新建 hero）→ `CabinDesktopHost`（舱上下文）。
- `CabinDesktopHost` 复用 CabinProvider/CockpitProvider/CabinChatHost；**不渲染第二条舱条**（2026-11-14 用户口径：舱名/状态/路径与顶栏下方的图标行属冗余）。退出回普通对话放在左栏「作战舱」段标题右侧的小箭头（`cabin-section-exit`）；DesktopHeader、桌面浮窗、分屏仍归 Desktop。
- ChatTab 加性 `cabinBridge`：左栏出现「工作舱」段（状态圈 + 新建项），并在 `drafting` 时用 `CabinDraftPane` 替换对话区。
- `CabinNewForm` 从 CabinNewHero 抽出，页面（/cabin/new 深链兜底）与内联 hero 共用表单。
- 舱内 chat 列按原型 787-790 对齐：历史左对齐 860（`[data-tui-col]`）、输入条跨过 252px crew gutter 且右侧收 96（`[data-tui-dock]`），立绘左右留白相等（38/38）。
- 🐙 菜单「新建工作舱」= `startDraft()` + `push('/')`；`/cabin/:cabinId` 兄弟壳保留为深链兜底。

## CabinShell 布局
DesktopHeader(复用顶栏) + **原 ChatSidebar**(工作舱·任务·会话三段；新建菜单含高亮「新建工作舱」) + chat 底座 + 作业坞舱模块段 + 浮窗层 + CabinCrew(汐音,P5)。
**没有独立左轨**（原型左侧就是生产侧栏加工作舱段；P2 初版自造左轨替换侧栏，被用户审阅打回重做）。模块导航在悬浮作业坞（原型 DOCK_MOD/DOCK_PRIMARY），点模块开浮窗（.win chrome：灯组 close/min/max + 居中标题）。

## 状态与 chat 底座
- CabinProvider：Context+useReducer；持 CabinDTO/attention/iterations/init/repos/worktrees + 浮窗开合/最小化/焦点序；SSE subscribeSSE('cabin:<id>') + 列表轮询折叠。
- **CabinChatHost**（舱 chat tab）宿主单个 ChatPane(pane='left',split=false,focused)，sessionId=cabin.main_session_id；shared 由现有 hooks 组装（useChatSessions/useChatTasks 全量——原任务/会话保留/useWorkspaces/useOrgs/useRunningAgents）；左侧 ChatSidebar 加 cabins/activeCabinId/onSelectCabin/onCreateCabin 加性 props；command 路由 select-task/select-session；layerRoot。复用 ChatArea/TuiTranscript/useAgentChat/chatStream 不变。开任务发 select-task→现有 per-task TaskModulesLayer+WorkspaceExplorerDock 出现。
  - **舱主对话不是一个会话**（2026-11-13 用户反馈：它出现在左栏会话列表里，看起来和某个会话在同步）：服务端 `AgentSessionDAO.listSessions` 与任务线程同一规则，SQL 层排除 `cabins.main_session_id`；入口只有左栏「工作舱」行。ChatPane 需要它的 workspace/title（SSE wake 订阅、作业坞标题）时，CabinChatHost 按 id 单独取一次，只并进喂给 ChatPane 的 shared.sessions，不进左栏列表。
  - **作业坞与舱隔离**（2026-11-13 用户要求，为后续舱大迭代定界）：舱模块段（cabinModules/cabinMoreModules）只在「舱主对话」上注入；舱内从跳转点打开任务线程/别的会话时，ChatPane 不再拿舱模块，坞退回桌面原样（文件/活动/子代理/调试/消耗 + 任务段）。层级与内容分开：`dockElevated` 让坞始终压在舱浮窗层上，与坞里有什么无关。桌面 ChatTab 从不传这些 props，成熟功能的坞完全不动。
- 作业坞舱模块段：WorkspaceExplorerDock 加性 props cabinModules/cabinMoreModules（ChatPane 透传 dockCabinModules/dockCabinMoreModules）；舱模式 dock z-50 压在浮窗层 z-40 上（原型 dock z-65 > win-layer z-60）。
- CabinModulesLayer（P3 已落地，替换 P2 CabinWindowLayer）：原型 openWin/drag/resize 全几何移植——CabinProvider 持 {x,y,w,h,min,max,placed}+winOrder 焦点序；首帧居中+级联落位（WIN_SIZE 对照原型 1342）；标题栏 pointer-capture 拖拽、右下 resize（下限 360×240）、max 铺满/min 隐藏；顶栏 winstrip（DesktopHeader extraStrip 加性 prop）最小化角标+点击恢复。任务级窗不重造：ChatPane 内置 TaskModulesLayer（app-window 几何），舱 dock「变更/验收」→ select-task module 复用。

## 8 屏（复用 vs 新增）
- S1 新建向导 CabinNewHero：composer+选目录 chip(browseDirectories)+开始→POST /api/cabins→导航。复用 ChatArea 空态。
- S2 初始化 CabinInitGateCard：门禁项 pending/run/done/err+去修，作 TuiTranscript dispatch 分支；复用 ask/decision 卡。
- S3 座舱 CabinOverview：attention-first+stat grid+迭代线+舱生命周期条(休眠/封存/重开)。
- S4 对话：ChatPane 底座本身。
- S5 仓库&工作树 CabinRepos/CabinWorktrees：仓库卡(主线/远端/commit/拉取)+worktree 列表+分支图。复用 TASK_STATUS_META。
- S6 迭代&任务 CabinIterations+CabinTasks(复用 task-board/TaskView 按 cabin_id 过滤)。
- S7 知识 CabinKnowledge：薄包装复用 KcCard/useKcFindings+wiki；findings 读时 repo scoping(G4)。
- S8 设置 CabinSettings：name/path/requirements/mainline/cockpit prefs/autonomy/archive/dormant。复用 settings-view+原型 tuning。

## 交互模型 UI
CabinAttentionQueue(串行收件箱 person-first+priority，一次一条) · CabinJobs(统一作业+priority+focus) · CabinTraceWindow(job_events 时间线+下钻) · CabinUsageWindow(复用 usage 骨架+byJob) · 自决确认卡(inferred/observe 复用 decision 卡)。

**P3 已落地**（components/cabin/modules/）：CabinQueue（attention 派生 comms 行 + UI 局部 routingId 单线程路由/优先排队/处理下一条，kind 映射 cabin_job_events）· CabinJobs（listJobsView 派生 status/transport + 提优先 bump + 聚焦 focused_job_id + trace 下钻过滤）· CabinTrace（getCabinTrace 时间线 + 作业过滤 + task→select-task / subagent→复用 SubagentWindow 内联）· CabinRun（running 任务卡，phase 派生节点，无动作按钮）· CabinChanges（GET /:id/changes = round-diff scope=task 跨仓聚合 + per-repo + 任务行下钻 ChangesWindow）· CabinAcceptance（待验收优先任务选择 + 复用 AcceptanceWindow）· CabinRepos（git 富化卡 + clone 对话框 + pull）· CabinWorktrees（行 + bgraph + 触发映射任务/cwd 复制）· CabinIterations（派生 iterline + 成员 tcard）· CabinTasks（八列 kanban，failed/aborted 独立态，新任务绑 cabin_id）。模块数据 10s 常驻轮询（恢复/聚焦也拿活态）。
**P3 后端**：CabinCommService（dispatch 建真实任务+作者线程+首回合授权 wake / note 不授权 / resume；入站 report/attention/handback 自动登记 job）· bridge G2 舱主会话覆写（卡/wake/引导全汇聚 main_session_id）· octopus-cabin MCP 工具集（cabin_list_tasks/dispatch_task/list_jobs/job_trace/note_job/resume_job）+ 每回合派生舱摘要注入 · tasks?cabin_id 过滤 + 创建绑 cabin_id/iteration_id。

## 汐音 CabinCrew（C10）
orchestrator 拟人化视觉面，非独立 agent、不另决策；对白=surfaced 输出/事件。
- 心情状态机(移植 crewState 纯派生)：mood≠auto 手动覆盖→瞬时 setMood(~2.6s 回落)→initializing boot→attention.person>0 alert→running>0 working→streaming thinking→failed/blocked worried→dormant sleep→else idle；完成 happy/cheer 瞬时。
- 反馈四通道：视觉(9 形态肖像+状态图标+attention 徽章+glow)/对白(xySay 打字机可点击关闭)/声音(AudioEngine 可静音)/点击(hub 菜单/聚焦主对话)。
- 事件→反馈映射(SSE 折叠驱动 useCabinCrew)：dispatch→working+xySay；attention→alert+chime；complete→cheer+sparkle；init done→happy；dormant→sleep；streaming→thinking。
- cockpit_prefs{theme,mood,glow,grid,blur,float,charScale,sound,autonomy} 移植 S8。肖像 base64→web-app/public/cabin/。

## API client + hooks
lib/cabin-api.ts(仿 tasks-api) · hooks/use-cabins/use-cabin/use-cabin-attention/use-cabin-iterations(仿 use-workspaces)。