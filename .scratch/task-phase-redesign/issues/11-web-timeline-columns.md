# 11 — web：TemplatePicker 简化 + 五列看板 + phase 时间线（含 legacy 渲染）

## What to build
TemplatePicker：coding 流去 skill_groups 勾选与 preset 预选（直通 task-author）；看板列改为 草稿/待执行/执行中(Phase i/n)/待验收(琥珀)/完成；卡片角标 `Phase i/n · Round m` 与 ⏳超预算徽标（阈值来自 task 派生视图，env `OCTOPUS_PHASE_BUDGET_MS` 可注入）；TaskRunDetailView 顶部 phase 时间线（名/状态/workflow/round 史），v3 legacy 任务派生 `[{legacy:true}]` 单行渲染。

## Blocked by
01, 07

## Status
done

## Exploration

**类比研究对象**：`app/tasks/page.tsx`（v39 看板：TASK_COLUMNS 渲染 + data-task-column + 10s 轮询 + 3 个 subscribeSSE 刷新钩子）、`lib/task-board.ts`（:40 `TasksByStatus=Record<TaskBoardStatus,Task[]>` 穷尽点，TaskStatusSchema 已含 8 态）、`execution-summary.tsx` 的 TaskRunDetailView（getTask→children→SSE task_status refetch 模式）、`authoring-workspace.test.tsx`/`template-picker.test.tsx`（vitest+jsdom+@testing-library 组件测试夹具）。

**derived 数据通路（关键决策）**：`listTasks` 不含 `derived`（server 只在 GET /:id 嵌入，TaskDetailDTO:225）。看板角标读 `derived.phaseViews` ⇒ 页面 fetchTasks 后对 `task_spec.format==="v4"` 的任务逐个 `getTask` 填充 `derivedMap`（看板 v4 任务数量小；10s 轮询+SSE 驱动）。

**列归属矩阵（AC2）**：五列 id 沿用状态词表（draft/ready/running/awaiting_review/done 即 data-task-column 值）。archiving→执行中列（⚠归档中徽标）；**failed/aborted（仅 v3 可持久，K13）→「完成」列（终态列，卡片状态行红/灰自证）**。⚠ 已知冲突：旧 e2e `task-domain-simple.spec.ts` 「renders 6 columns」断言失败/中止独立列存在——五列是本票 AC2 硬约束，旧 e2e 归票 14 的 E2E 主线重写；本票只保证 vitest 全绿 + 新 e2e 全绿。**v4 列归属用 effectiveStatus（derived.taskStatus 优先，持久 draft/aborted 例外）**——票 07 活体交互 #1 指出首 phase round 终态会把持久态写成 done/failed，若按持久态归列，待验收任务会错进「完成」列。

**选定函数**：
- `deriveTaskView` 输出 = GET /:id `derived` 原样（票 07 契约段）；web 在 tasks-api.ts 镜像 `TaskDerivedView`（server 类型不可跨包 import，既有 TaskChild 镜像先例）。
- 角标 `computePhaseBadge(derived)`：current=phaseViews 中**第一个 status!=="accepted" 的位置**（1-based；全 accepted 则末位）；round=`awaitingRound ?? currentRound`。不用 task_spec.phases 数 n（phaseViews 才是账本合并后的真相）。
- 阈值 `phaseBudgetMs()`：`Number(process.env.NEXT_PUBLIC_PHASE_BUDGET_MS)` NaN/≤0 兜底 `5_400_000`（K2 1.5h）。⏳ 判定：任一 round exec state∈{pending,running} 且 `now - exec.created_at > budget`（derived.exec 镜像只带 created_at，无 completed_at —— 终态轮不标，advisory 语义只作用于在跑轮）。
- `postAcceptance`/`postAdvance` 严格照票 07 `## 契约`：acceptance body/返回体逐字段；advance（POST /:id/advance {phase_index}，票 07 活体交互 #3 的「autoAdvance=false 人工起下一 phase」入口，server 侧落地归票 08/12 接线）复用同一 result 形状。错误统一 `TaskApiError(status)`（票 12 需要 409 判别）。
- SSE 常量 `PHASE_STATUS_UPDATE_EVENT` 从 `@octopus/shared` 导入（票 07 已入 shared/types/task.ts:165），看板页 + TaskRunDetailView 各挂 refetch。

**需改文件**（票面 ownership 内）：
- `lib/tasks-api.ts` — TaskDerivedView 族类型 + TaskDetail.derived + postAcceptance/postAdvance + TaskApiError。
- `lib/task-board.ts` — TASK_COLUMNS 五列、Record<TaskStatus> 穷尽 8 桶、STATUS_TO_COLUMN/COLUMN_STATUSES/tasksForColumn、effectiveStatusOf、computePhaseBadge、phaseBudgetMs、overBudgetExecOf。
- `app/tasks/page.tsx` — 五列渲染（column id ≠ 状态时用 tasksForColumn）、derivedMap 抓取、卡片角标/琥珀高亮/⚠归档中/⏳、phase_status_update SSE。
- `components/tasks/phase-timeline.tsx` — 新建（每 phase 一行：名/状态色点/workflowRef/rounds chips；v3 legacy 单行 `{legacy:true}`；derived 缺失→null 不炸旧测试）。
- `components/tasks/execution-summary.tsx` — 顶部插 PhaseTimeline + isLive 扩两态 + phase_status_update refetch。
- `components/tasks/task-modal.tsx` — 仅分流：awaiting_review/archiving → simple-execution（不再误入 terminal），STATUS_LABEL/TONE 补两态。
- `components/tasks/authoring/template-picker.tsx` — coding 隐藏 Skill 组段 + codebase/preset 段（generic 保留现状）；onCreate coding ⇒ skill_groups:[] preset 仅 org。
- 测试：`lib/__tests__/task-board.test.ts`（五列契约——本票 AC2 直接改写旧 6 列断言，属票面强制）、`authoring/__tests__/template-picker.test.tsx`（coding 直通断言——同理 AC1 强制；group 渲染断言切到 generic 型下保留）、新建 `components/tasks/__tests__/phase-timeline.test.tsx`（渲染矩阵）、新建 `e2e/task-phase-board.spec.ts`（AC1-AC4，fixture 走 API + 直造 DB 行）。

**时间预算内发现**：`execution-summary.test.tsx` mock getTask 无 derived → PhaseTimeline 对 `derived==undefined` 必须静默（不是 legacy 单行）——真实 server 恒有 derived 字段，undefined 只出现在旧 server/mock 场景。

## Acceptance Criteria
- [x] AC1: 新建 coding 任务全程无技能组/preset 控件（e2e 选择器断言不存在）
- [x] AC2: 五列正确归属：awaiting_review 任务出现在待验收列且样式高亮
- [x] AC3: 时间线行数=phases 数；legacy v3 卡不报错、显示单行
- [x] AC4: env 注入小阈值后 ⏳ 徽标出现

## Verification (2026-09-03, 票 11 执行器回填)

**vitest**: `npx vitest run lib/__tests__/task-board components/tasks` → **111/112**。唯一失败
`task-modal-spec-panel.test.tsx > displays bound workflow_ref` 已用 HEAD(ce53d549) 干净 worktree
复现 = **先于本票存在**（#52/#55 的 WorkflowRefDisplay+WorkflowBox 双呈现同一 ref 文案 → getByText
多匹配），归票 12 WorkflowBindingDialog 重写线，本票未触碰。全量套件另 3 个失败文件
（system-pages/knowledge-ui/harness-floating-panel）同样 HEAD 基线复现，均与本票无关。
新增/改写测试：task-board.test 22（五列契约+effectiveStatus+角标+阈值）、
phase-timeline.test 9（渲染矩阵）、template-picker.test 9（coding 直通/generic 现状）全绿。

**playwright e2e = 真实执行**: 本地起 server(node dist/index.js:3001) + web
(`NEXT_PUBLIC_PHASE_BUDGET_MS=1000 npx next dev --port 3000`)，
`NEXT_PUBLIC_PHASE_BUDGET_MS=1000 npx playwright test e2e/task-phase-board.spec.ts --retries=0`
→ **5 passed (2.6s)**：AC1 选择器断言不存在 / AC2 待验收列+琥珀+`Phase 1/2 · Round 1` 角标 /
AC2b archiving ⚠ 徽标留执行中列 / AC3 v4 三 phase 三行 + v3 legacy 单行 / AC4 卡+时间线 chip ⏳。
fixture=API 直造 v4（POST→PUT task_spec format/phases）+ node:sqlite 直造 executions+schedules 链
（派生吃归属链）；测后 tasks/executions/schedules/workspaces 零残留。
⚠ 遗留 6 行 `task_phase_acceptances` E2E_TD_acc_% 孤儿（append-only trigger 挡 DELETE）→ 票 14 清扫。
栈不可用时用例自动 skip（serverAvailable/dbAvailable 双探针）。

**票 14 已知契约迁移**: 五列化移除 failed/aborted 独立列（v3 终态归「完成」列，卡片状态行自证）——
旧 `task-domain-simple.spec.ts`「renders 6 columns」将红，属 AC2 预期迁移；
`NEXT_PUBLIC_PHASE_BUDGET_MS`（前端阈值）为票面 `OCTOPUS_PHASE_BUDGET_MS` 的 web 侧落地名，
server 侧如需同名 env 归票 08/14。

## Verification Method
**Verification type**: browser E2E（Playwright，复用 e2e/helpers/task-domain-helpers.ts）

**Verification steps**:
1. `packages/web-app/e2e/task-phase-board.spec.ts`：AC1-AC4（fixture 任务经 API 直造）
2. `pnpm -F @octopus/web-app exec npx playwright test e2e/task-phase-board.spec.ts`

**Pass criteria**: 全绿
**Failure handling**: Max 3 fix attempts, then mark SKIP with reason
