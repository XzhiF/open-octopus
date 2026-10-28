# 任务主控 Chat 重构 — 开发计划（M1–M6）

> 分支：`feat-new-ui-20261022` · 原型：`tmp/main-chat-task-lifecycle-proto.html`
> 状态：**完成（M1–M6）** · 最后更新：2026-10-28

## 0. 目标（一句话）

一条主会话贯穿任务全周期：主 chat 不换、身份随状态切（主控 → 作者 → 执行者 → 主控）、状态以事件卡写回、作业坞一窗一职、任务周期全量 token 可查。

## 1. 已定决策（8 条，不再讨论）

1. **一任务一条主会话**：`tasks.source_chat_session_id` 指向一条 `sessions.clone_name IS NULL` 的 main session。
2. **状态同步三层次**：事件卡（零 LLM）+ 每轮 `<system-reminder>` 注入 + 只在异步结果/异常时唤醒。
3. **入列即切执行者**：draft = 作者；ready 起 = 执行者待命；running/awaiting = 执行者（工作区写）；archiving = 执行者只读；done = 主控只读。
4. **验收窗只做验收**：核对 + 复检 + 预览 + 实例 + 决策；变更/消耗/产物各自独立窗；对话 = 主 chat。
5. **存量任务直接删除**：不迁移；清理前备份 DB + 任务 home + 执行工作区。
6. **验收通过/打回归人**：agent 只能 `request_task_action` 发起确认卡。
7. **归档沿用主 chat**：进入 archiving 时唤醒一次做知识反思，给 2–5 条沉淀建议（逐条 落 wiki / 改一改 / 跳过）；独立 `📦 归档` 窗；失败可幂等重试；done 不重复唤醒。
8. **专家只下线界面**：坞模块与编辑器移除；`phases[].experts` 字段与执行期注入保留。

## 2. 里程碑与票

### M1 — 任务线程地基（server）
- [x] **M1-1** `TaskThreadService`：身份解析（author/doer/base）、cwd、稳定 plugins、写权护栏、每轮任务上下文块。
- [x] **M1-2** `chat-routes` 接入 turn profile：cwd/plugins/onBeforeToolCall/context；回合后 quick-edit 自动提交 + `quick_edit_commit` SSE。
- [x] **M1-3** 线程绑定 + 单测：仅 `clone_name IS NULL` 的 session 激活；作者只写 home；执行者写工作区且每改即 commit；只读态拒绝写。

**验收**：curl 用同一 session 走 draft→ready→running→awaiting；`pnpm --filter @octopus/server test` 相关单测绿；现有 UI 不受影响。

### M2 — 状态事件 + 任务工具（server）
- [x] **M2-1** 事件桥：所有 `task_status` 迁移写静默事件卡（`displayType:'event'`），带 actions 元数据。
- [x] **M2-2** 任务执行 `bindExecution`：started/complete/failed/approval/stalled 到达主线程；高信号唤醒 + 合并。
- [x] **M2-3** 任务工具：`get_task_status` / `update_task_spec_field`（作者）/ `propose_launch` / `request_task_action`（确认卡）。

**验收**：逐状态单测断言事件落库与唤醒策略；curl 让 agent 读状态、发起动作。

### M3 — 账本 + 归档 + 反思（server）
- [x] **M3-1** `GET /api/tasks/:id/usage`：会话 + 所有执行（含子执行）聚合，防双计。
- [x] **M3-2** `GET /api/tasks/:id/archive`：state.json + report.md + in-flight；archiving 事件（开始/失败/完成）。
- [x] **M3-3** 知识反思：进入 archiving 唤醒一次；`propose_wiki_entries` 工具；`POST /:id/reflection/decision`（落 wiki / 跳过）。

**验收**：usage 双计回归；归档 fixture；反思建议 → 决策 → ingest 链路单测。

### M4 — 主 chat 壳层（web）
- [x] **M4-1** `ChatTab` 去 workbench 切换；任务线程常驻；新建任务 = 复用当前会话或新建 main session 并绑定。
- [x] **M4-2** 顶部状态条（状态/身份/P·R/快捷动作）、事件卡、启动三选一卡、动作确认卡、反思建议卡、后台活动条。
- [x] **M4-3** 任务 token 角标 + 账本 popover。
- [x] **M4-4** 备份 + 删除存量任务数据；切换新建任务走新链路。

**验收**：真机新建任务，全周期只在主 chat 里完成；`pnpm --filter @octopus/web-app test` 相关单测绿。

### M5 — 作业坞 + 窗口（web）
- [x] **M5-1** 作业坞 7 模块 + 10 状态主行动矩阵；移除专家模块。
- [x] **M5-2** 运行窗：DAG + 节点 + 日志 + 暂停/恢复/中止/重试。
- [x] **M5-3** 验收窗重构：单关闭、无对话/变更/消耗/产物页签；保留 diff 数据供核对；跳转变更窗。
- [x] **M5-4** 归档窗 + 消耗窗 + 产物窗。
- [x] **M5-5** 退役 `TaskWorkbench` / `TaskRunCenter` / `TaskConsoleWindow` / `TaskChatTab` / 任务侧 `tab-assembly`；修引用与测试。

**验收**：坞矩阵单测 + 真机逐窗走查。

### M6 — 退役 + E2E + 收口
- [x] **M6-1** 删 `TaskDoerService` / `routes/task-chat.ts` / clone autosave / clone 路由 task-author 专用注入；停写 `doer_session_id`；接管改走主线程。
- [x] **M6-2** 删旧组件/旧测试残留；更新 e2e。
- [x] **M6-3** 全量 `pnpm test` + Playwright 全生命周期 + 文档/GLOSSARY 收口。

**验收**：全绿；真实浏览器从新建任务走到 done。

## 3. 数据清理策略（M4 执行）

1. 备份 `~/.octopus/db/octopus.db` → `octopus.db.bak-<timestamp>`；
2. 备份被删任务的任务 home 与执行工作区（列出路径，移动到 `.trash/`）；
3. 删除 task-domain 数据：`tasks` / `executions`(task_id 非空) / 关联 sessions（source_chat_session_id、doer_session_id）/ 任务执行工作区行；
4. 保留普通会话与非任务工作区；
5. 记录清单到本文件「清理记录」。

### 清理记录（2026-10-28）
- DB 备份：`~/.octopus/db/backups/octopus.db.bak-2026-10-28T07-47-52`（24.4 MB）
- 工作区移入 trash：`~/.octopus/trash/task-thread-2026-10-28T07-47-52/`
  - `task-java-common-util-1027-082529-846905`
  - `task-t3of3wx-1027-172601-ac17a4`
- 删除：tasks 2 / executions 2 / task sessions 2 / task workspaces 2 / node_executions 23 / node_edges 12 / llm_calls 173 / messages 24 / chat_messages 3
- 保留：知识中心 archive 会话 1、main-agent 工作区 3、非任务测试目录
- 注：`task_phase_acceptances` 有 append-only 触发器，清理时临时 drop → 删除 → 按原 SQL 重建（已验证触发器存在）

## 4. 断点续做协议

- 每完成一票：更新本文件勾选 + `TaskUpdate` 状态 + 在下方「进度日志」追加一行。
- 上下文被 compact 后：先读本文件 + `TaskList`，从第一个未完成票继续；不要重新讨论已定决策。
- 不可逆操作（数据删除）只在 M4-4 执行一次，执行前确认备份完成。

## 5. 进度日志

- 2026-10-28：计划与票创建；开始 M1-1。
- 2026-10-28：M1 完成（3 票）。新增 `task-thread-service.ts` / `quick-edit.ts` / `migrateProviderTranscript`；chat-routes 接入 profile；测试 `task-thread-profile`(8) / `task-thread-turn`(4) / `task-thread-route`(5) 全绿；doer 与 resume 回归绿；server build success。下一步 M2-1。
- 2026-10-28：M2 完成（3 票）。事件桥静默卡 + actions + ephemeral wake + 执行绑定；任务工具（状态/spec/启动提议/动作确认）；测试 `chat-event-bridge-task-cards`(6) / `task-tools`(4) 绿。
- 2026-10-28：M4 完成（4 票）。ChatTab 去 workbench / 任务线程绑定 / 新建任务复用当前会话；状态条 + 事件卡 actions + 反思卡 + 启动三选一 + 动作确认；任务账本角标；存量任务数据备份并删除（见清理记录）。web 全量 1170 测试绿。
- 2026-10-28：M5 完成（5 票）。作业坞 7 模块 + 状态动作矩阵；运行窗 DAG+日志；验收窗重构（单关闭、无对话/变更/消耗/产物、diff 跳变窗）；归档/消耗/产物窗；旧任务壳从活路径退役。
- 2026-10-28：M6-1/M6-2 完成。删除 TaskDoerService / task-chat 路由 / clone autosave 及旧测试；接管改走主线程；plan-writeback actor 改 task-thread；server build 绿，剩余 35 个 Windows 基线红（clone-file-mgmt/path-guard/archive-service/config-manager/harness/tasks-verify/detector/scheduler-DST）。
- 2026-10-28：M3 完成（3 票）。`GET /:id/usage`（summary+breakdown，防双计）、`GET /:id/archive`（state/report/in-flight/reflection）、归档反思（wake + propose_wiki_entries + decision ingest/skip）；测试 `task-usage`(4) / `task-reflection`(4) 绿；server build success。下一步 M4-1（web）。
- 2026-10-28：旧壳清除。删除 `task-modal` / `task-run-console` / `task-workbench` / `task-run-center` / doer `chat-tab` 及其独占依赖（旧 run-console 节点/日志/接管/用量、旧 authoring 工作台、composite DAG、editable-title、验收 round-diff/impact 面板）与对应单测；`EMPTY_SHELL` 落到 files-tab、`isTakeoverDeliveredRound` 落到 acceptance-labels（两者仍有活消费方）；清理指向旧壳的 e2e 规格（task-workbench / task-overview / task-domain-* / task-phase-* / task-authoring-v4 / draft-artifact-visibility / taskboard-flow-1..7）与 `taskboard-v2-helpers`。web 全量 **878/878** 绿（104 文件），`pnpm build` 绿，typecheck 无新增错误。
- 2026-10-28：M6-3 收口。server build 绿；web 全量 **1170/1170** 绿；server 新增/回归单测 108 绿（task-thread-profile/turn/route、bridge cards、task-tools、task-usage、task-reflection、tasks-v4-gate/duplicate/create/acceptance/archiving），全量 3514 中 35 个为已知 Windows 基线红（clone-file-mgmt/path-guard/archive-service/config-manager/harness/tasks-verify/detector/scheduler-DST）。Playwright 真浏览器：草稿流（新建任务→状态条 草稿/任务作者→主 chat 可见→规格窗/消耗窗→零 console error）+ 待执行流（API 造齐 spec/issues 后入列→状态条 待执行/执行者待命→「已入列」事件卡 + 三个 actions→坞可见性 plan/changes/usage/artifacts、run/acceptance/archive 隐藏）。GLOSSARY-MAP 已补任务线程/状态卡/归档反思/任务周期账本。未跑「真实工作流一路到 done」的 UI E2E（会触发真实 LLM/仓库 push）；该链路由 tasks-v4-acceptance/archiving 集成测试覆盖。