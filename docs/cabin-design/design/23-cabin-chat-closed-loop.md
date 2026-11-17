# 23 · 作战舱 Chat 闭环（chat 里操作一切）

> 2026-11-16 · 状态：P0/P1 已落地（本次提交）
>
> 目标：作战舱里**所有操作都在 chat 里完成** —— 汐音派发任务，任务作者在任务线程
> 里把需求问清楚，入列 / 执行 / 验收 / 归档全部不离开座舱。
>
> 关联：design 12（座舱实现）、design 21/22（舱籍项目）、ADR-0021（任务触发）。

## 0. 目标态

```
用户（舱内任意 chat）
  │  「做 X」/「把第 2 条派了」
  ▼
汐音（cabin-orchestrator · 舱主会话）
  │  cabin_dispatch_task(clarify=ask)
  ▼
任务作者线程（task-author · 任务自己的会话）
  │  ① 读 .cabin/requirements.md + 任务 home 的 context.md
  │  ② AskUserQuestion 一次一问（验收物 / 范围 / 优先级 / 风险）
  │  ③ 多 phase 拆分卡 → 用户在 chat 里批准
  │  ④ 写 phases + 各 phase spec/票 + runbook
  │  ⑤ enqueue_task / launch_task（explicit）或 propose_launch（inferred）
  ▼
绑定工作流（默认 matt-spec-dev）→ 任务自己的 workspace + worktree
  │  高信号回流：待回答 / 待验收 / 失败
  ▼
舱主会话 + 作业面 + 任务线程 chat —— 不离开作战舱
```

三条不变量：

1. **派发 ≠ 免澄清**：`explicit` 只解除「建任务 / 开工作树 / 花 token」，不解除规格问答与拆分确认。
2. **任务自己的 workspace / home**：舱只做项目关联；worktree 与 `.task` 按任务隔离。
3. **人永远在 chat 里**：问题、拆分卡、入列卡、验收都在对话或对话旁的任务模块窗里完成。

## 1. 授权语义（`clarify`）

`CabinMandateSchema` 新增 `clarify: 'ask' | 'auto'`（缺省 `ask`），并写入 job mandate 留痕。

- `clarify=ask`（默认）：作者先澄清；`explicit` 时拆分批准后直接入列执行，`inferred` 时出
  `propose_launch` 卡等人放行。
- `clarify=auto`：仅当用户原话是「看着办 / 直接做」时由汐音传；无实质歧义可直接完成规格并入列，
  有歧义仍先问人。

落点：

- `packages/shared/src/types/cabin.ts` — schema 字段。
- `packages/server/src/services/chat/cabin-tools.ts` — 工具入参 / 描述 / 舱摘要纪律。
- `packages/server/src/services/cabin/cabin-comm-service.ts` — wake 模板（删掉「无需再向人确认」）。
- `packages/core-pack/clones/task-author/persona.md` — 作者身份口径。

## 2. 问题可见性（待回答 → 任务线程）

作者提问必须同时满足两件事：**被舱推导出来**、**点得进去**。

- 落库：`routes/agent/chat-routes.ts` 在 `ask_user_question` chunk 时把
  `{ displayType: 'ask_user_question', questions }` 并入 assistant 行 metadata（与 clone /
  InteractionService 同构）。
- 推导：`cabin-service.gatherAsks` 两种来源都认 —— metadata（新行 / interaction / clone）与
  `tool_calls` 里的 `AskUserQuestion`（修复前的历史行）。
- 入口：`CockpitChatHost` 监听 `octopus:open-task` → `chatWindow.openWithFocus()`。
  `ce078160` 之后切面会自动收窗，「去处理 / 去任务对话」单靠 open-task 会切了线程但看不到；
  统一在宿主开窗，一处覆盖 attention 面 / 任务面 / 作业面 / 模块。
- 作业面「对接」页签新增「任务对话」入口（仅 task 作业）。
- **就地作答（不切对话）**：作者提问时，bridge 把同一组问题追加一张 `authorAsk` 卡到
  **舱主会话**（`ChatEventBridge.requestAuthorAskCard`，零 LLM、按 askMessageId 幂等）。
  前端 `AuthorAskCard` 复用 `AskUserQuestionCard`；提交后把「用户回答了以下问题：…」
  直接转发给作者线程（后台消费 SSE），用户全程留在汐音这条对话里。任务线程里的原卡
  仍是规范事实，答案落库后自动变成已答态。
- **并发提问（编队多线同时来问）**：
  - `gatherAsks` 按会话**逐条**列出全部未答 ask（不再只取末条）；每条独立判定是否已答
    —— 其后有「用户回答了以下问题」，或卡片 metadata 已有 `activity.decision`
    （就地作答写回）。答掉一条不会影响另一条。
  - 会话集合 = 舱绑定会话 ∪ 舱任务主线程会话（UI 直建任务可能没把 cabin_id 写回会话）。
  - 转录顶端 `AuthorAskInbox` 粘性收件箱：列出每条待答（任务名 + 第一个问题），点一行
    把对应卡片滚进视野，人可自选先处理哪一条；答完立即消项。
  - 编队 `mergeAttention` 不再丢弃同一作业的第二条待办 —— 最高优先挂 job 行，其余
    保留为独立 `attn:` 行。
  - 转发失败（作者线程正被别的信号唤醒、服务端 409）不再静默标「已回答」：卡片退避
    重试 2s / 5s，仍失败保持可点并提示「再点一次」，不会丢答案。
  - 在任务线程里直接答题时，`markAuthorAskAnswered` 把主会话镜像卡也写回 decision，
    两线不会一条已答、一条永远挂着。
- **所有拍板点都走问题卡**：wake 与 persona 明确要求「拆分批准 / 每 phase 绑定确认 /
  入列方式」也用 `AskUserQuestion` 一次一问提出（摘要 + 选项），完整卡仍写任务线程。
  这样常见的人机往返全部落在舱主会话，不需要为了点「批准」切线程。

## 2.1 双会话可追溯（2026-11-16 用户口径）

用户对两条线的分工是：**舱里汐音做的事 = 人授权的事**；**任务线程 = 原始委托线**。
两条线都要留痕，且都能单独追溯：

- 任务里程碑卡（状态转场 / 暂停恢复 / 验收方案 / 归档确认与完成）在**任务线程与舱主会话
  各落一张**（`mirrorCardToCabinMain` / `mirrorCardToTaskThread`）：不额唤醒、零 LLM；
  任务线程是规范事实，主会话是舰长视角的同一条事件。
- 镜像卡不改变授权语义，也不代答；唤醒仍只走原路径（避免同一事件烧两次 token）。
- 历史卡同样受益：卡片按 `taskId` 取数，升级前的老状态卡也能展开模块。

## 2.2 模块内嵌（规格 / 运行 / 验收）

状态卡底部新增「在对话里看：规格 / 运行 / 验收」页签（`TaskModuleInline`），展开后把
`TaskPlanWindow`（只读 SpecPanel）/ `RunWindow` / `AcceptanceWindow` 原样嵌进消息流，
高度 440px 内滚动。数据源与作业坞窗口完全一致，不复制只读实现；只负责「看」，拍板
仍在对话里说或在任务线程操作。因为状态卡同时出现在两条会话，这一入口天然双线可用。

## 3. 形状与门禁

### 3.1 v4 对齐

舱派发建任务时传 `task_spec: { format: 'v4' }`，不再用 `task_type: 'coding'` 的 v3 形状 ——
与「新建任务」逐字一致，避免作者起手看到 v3 确认语义。

### 3.2 项目解析

v4 入队门要求项目可解析。舱的本地 / 外部项目只登记在 `<cabin>/config.json.repos[]`，
不在 org `repos/index.md`。单一实现 `services/tasks/task-project-resolver.ts`，顺序：

1. `WorkspaceGit.resolveRepoPath(repo_group, name)`（org 注册表）；
2. 失败且有 `cabin_id` → 读舱 config，`resolveCabinRepo` 得到 `main_path`，**目录必须真实存在**；
3. 仍失败 → `project:<name>` 缺项。

三个消费点共用：`context.md` 的 project 路径、v4 ready gate、执行期
`buildTaskLaunchConfig` 的 `workspace_spec.projects[].source_path` —— 最后一个保证
本地项目真的能开出 worktree（`initWorktreeOne` 优先用显式 source_path）。

### 3.3 无项目舱政策

- 舱有项目：任务必须绑至少一个，否则 `project-binding`。
- 舱一个项目都没有：放行（no-code 舱，没有 worktree 可开）。

## 4. 任务隔离（不再复用舱 workspace）

one-workspace model 下 task home = `<workspace>/.task`。此前舱派发把 `cabin.workspace_id`
传给任务，同舱所有任务共用一个 home（`context.md` / `manifest.json` / `.scratch` 互相覆盖）。

现在派发顺序改为「先建作者会话 → 带 `source_chat_session_id` 建任务」，让 `createTask`
为任务建自己的 workspace 并把会话绑过去；作者线程 cwd 由 task-thread profile 解析到任务 home。

## 5. 验证

- `cabin-comm-service.test.ts`：v4 形状 / 任务 workspace / clarify=ask 文案 / clarify=auto。
- `cabin-p4.test.ts`：只有 `tool_calls` 的 ask 也进「待回答」；**多任务并发提问逐条列出、
  答一条不影响另一条**；卡片 `activity.decision` 后消失。
- `main-chat-ask-user-question.test.ts`：问题落进 metadata。
- `cabin-g2-bridge.test.ts`：提问卡幂等；**状态 / 暂停恢复卡双会话各一张**。
- `tasks-cabin-projects.test.ts`：舱本地项目解析、无项目政策、两任务不同 workspace。
- `chat-window-mount.test.tsx`：`octopus:open-task` / `octopus:open-ask` 自动开窗。
- `author-ask-card.test.tsx`：就地作答转发 + 写回 decision；**转发被拒时不谎报已回答**。
- `author-ask-inbox.test.tsx`：并发待答逐条列出、点选定位、答完消项。
- `fleet-model.test.ts`：同一作业的第二条 attention 保留为独立行。
- `task-status-card.test.tsx`：卡片只有查看页签、没有动作按钮。

## 6. 后续（P2）

- first-plan 建议直接出「派发」按钮。
- 存量：同舱多任务共 home 的只读巡检与迁移提示。
- 跨线程讨论：「先讨论」在就地作答卡上已关闭；若需要，应改为把讨论回合也镜像回主会话。
- 模块内嵌目前是只读查看；若要在主会话里直接编辑 spec / 勾验收，需要把写路径也搬进来。
