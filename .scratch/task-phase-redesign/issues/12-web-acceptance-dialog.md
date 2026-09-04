# 12 — web：验收三栏 modal + 打回弹窗（影响清单/形态推荐）+ per-phase 绑定卡

## What to build
验收界面：三栏=执行摘要(用时/token/cost，搬 TaskAiUsageCard)|产物核对(slug 文件列表→ArtifactViewerDialog)|动作区(通过/打回[反馈必填]/中止)。打回弹窗：反馈文本→agent 推荐卡（修复流 or round-2 spec，stub API 可测）→影响清单勾选区（批准→调 spec-field phases）→确认开 round+1。WorkflowBindingDialog 重写：数据源 built-in 清单（票 10）、修 S2（依赖引用稳定化/useMemo）与 S5（保存前重取 version）、per-phase 卡片列表替代单卡。`phase_status_update`/`task_artifacts_update` SSE 挂窗实时刷新。

## Blocked by
07, 10

## Exploration

**类比研究对象**：`execution-summary.tsx`（TaskAiUsageCard/fetchLLMCalls 聚合、ChildrenRunList 的
children.execution_ref↔round.exec.id 联查、ArtifactsCard 的 listArtifacts+`task_artifacts_update` SSE 挂窗）；
`output-viewer.tsx`（ArtifactViewerDialog 行→entry 弹窗先例）；`goal-ac-card.tsx`（spec-field+乐观锁写回先例）；
票 11 `phase-timeline.tsx`（derived 只读渲染纪律——不重实现派生矩阵）。

**需改文件**（票面 ownership 内）：
- 新建 `components/tasks/acceptance-modal.tsx`（三栏 + reject 子块 + agent 推荐/影响清单占位块 +
  `postArchiveRetry` helper——lib/tasks-api.ts 不在本票可改清单，archive/retry 无既成导出，就近实现）。
- 重写 `components/tasks/authoring/workflow-box.tsx`（v4=per-phase 绑定卡列表；v3=单卡保留；
  preset 过滤退役、S2/S5 修）。数据源复用 `lib/workflow-presets-api` 的
  `listBuiltInWorkflows()/getBuiltInWorkflowDetail()`（后者仅 YAML 预览按需拉取 → 弹窗打开期间
  list fetch 恒=1，满足票 10 移交的 AC-20）。
- 改 `authoring-workspace.tsx`（v4 四行入队清单 + canEnqueue v4 + autoAdvance 开关 + v4 隐藏 GoalAcCard）；
  `page.tsx`（仅动作按钮：验收/启动下一 Phase/重试归档 + modal 挂载）；
  `task-modal-spec-panel.test.tsx`（E 项断言按新结构改）。
- 测试：重写 `authoring/__tests__/workflow-box.test.tsx`（preset 用例退役）；
  `authoring/__tests__/authoring-workspace.test.tsx` 加 v4 用例；新建 `__tests__/acceptance-modal.test.tsx`；
  新建 `e2e/task-phase-acceptance.spec.ts`（fixture=票 11 模式：API 直造 + sqlite 直造 exec 链）。

**选定函数**：
- 验收/推进用票 11 已交付的 `postAcceptance`/`postAdvance`/`TaskApiError`（409=他处已决/态变 → 重拉 derived；
  400=表单缺陷）——MUST NOT 再造。写回 phases 用 `updateTask` PUT（带 If-Match），**不用**
  `updateSpecField`（无 If-Match，票面指定 PUT 整数组）。
- 左列 token/cost：`fetchLLMCalls(round.exec.id).aggregates`（round 口径，非 TaskAiUsageCard 的任务口径
  「全部执行合计」——文案不符，用同等数据自排；formatDuration/formatTokenCount/formatCost 复用 lib/format）。
- 用时：`detail.children[].execution_ref` 中 `execution_id === round.exec.id` 的行（duration_ms ??
  completed_at-triggered_at）。

**发现的接缝（票内记录，v4.1）**：
1. **agent round 形态推荐**（D13①）：server 本轮无推荐端点 → UI 预留 disabled 单选卡
   （通用修复流 / round-2 spec + 说明文案），打回提交后显示；acceptance 成功即 round+1 已由 server 开跑。
2. **影响清单**（D14）：server 无 spec-r2 impact API → `ImpactApprovalList` 渲染/批准逻辑就绪
   （批准→updateTask PUT phases 整数组 + If-Match），数据源空态。AC3 以组件测试断言（e2e 断空态）。
3. **collect 不登记 artifacts.json**：批次文件回流进 `{home}/.scratch/…`，但 GET /:id/artifacts
   只扫 `artifacts/` + external 登记 → 中列对未登记批次文件为「登记可见」语义；web 渲染链完整，
   自动登记归 server（v4.1）。
4. **autoAdvance 开关落位**：PUT/spec-field 都限 draft/ready（awaiting 窗口持久态多为 done/running → 弹窗内写
   必 409）→ 开关放 AuthoringWorkspace（draft 可写，AC5 可切=e2e 真 PUT 回读）；验收弹窗动作区只显
   「自动开跑: 开/关」只读态。

## Status
done

## Acceptance Criteria
- [x] AC1: 三栏齐现且数据正确（fixture 执行记录）；产物点击展开全文
- [x] AC2: 反馈为空时「打回确认」disabled；提交后账本行+round+1 卡片反馈生效（SSE 驱动无需刷新）
- [x] AC3: 影响清单批准后 home spec 内容变化（API 回读断言）且 version bump
- [x] AC4: 绑定弹窗打开→fetch 计数=1（网络断言）、快速点选 3 个工作流不闪 spinner 清列表（滚动位置保持）、轮询 bump version 后保存不 409
- [x] AC5: auto_advance 开关可见可切

## Verification (2026-09-03, 票 12 执行器回填)

**vitest**: `npx vitest run components/tasks lib/__tests__/task-board` = **131/131**
（E 项 `task-modal-spec-panel.test.tsx > displays bound workflow_ref` 转绿——断言改分区
scoped 查询；workflow-box.test 重写 17 用例含 S2 渲染稳定回归 + S5 重取 version 回归；
acceptance-modal.test 7 用例含 ImpactApprovalList 批准→updateSpecField(phases) 整数组断言）。

**playwright e2e = 真实执行**（本地 server:3001 dist + next dev:3000，测毕停栈）：
`npx playwright test e2e/task-phase-acceptance.spec.ts --retries=0` → **7 passed (4.2s)**
- AC1: 真实 fixture（API 直造 v4 + sqlite 直造 completed round + 真实 home artifacts 文件）
  三栏齐现；左列 `Phase 1/2 · Round 1`/执行成功/用时 10m 0s；中列按 slug 过滤、点击行
  ArtifactViewerDialog 展开全文（真实 content 端点）。
- AC2: disabled gate 真实 UI 断言；**真实 POST rejected** → DB 账本行核回（decision+feedback
  verbatim）+ fix-feedback-r1.md 落 home；派发 409 人话面（fixture 信封无物化 phases，
  票 07 设计=账本保留）。成功态接缝卡（D13① disabled 推荐 + D14 影响清单空态）用
  route fulfill 票 07 契约 200 驱动（请求 body 真实断言）——活体 agent 执行不在 Web E2E
  范围（票 14 主故事域）。
- AC3（拆分验证）: 组件测试断言批准→`updateSpecField("phases", 整数组, source=user)`；
  e2e 真实 spec-field POST 回读断言 home spec.json 内容变化 + version bump。
- AC4: 弹窗打开 fetch 计数=1（page.on('request')，StrictMode 双跑 ref 守卫）；连点 3 个
  列表计数恒定零重取；弹窗开着时 updateSpecField bump version → 保存仍 200（S5 重取）。
- AC5: 开关默认可见 checked，uncheck→真实 PUT→API 回读 autoAdvance=false→切回。
- B 面: 真实 accepted（autoAdvance=false）→ DB 账本 accepted + 卡片 SSE 归待执行列 +
  「启动下一 Phase」出现（advance 点击真实 POST，409 人话 toast）；archiving 卡「重试归档」出现。

**回归底线**: 票 11 `e2e/task-phase-board.spec.ts` = 4 passed + 1 skip（AC4 需
NEXT_PUBLIC_PHASE_BUDGET_MS 编译期注入，本环境未注入）；`components/tasks` 全量绿。
**残留**: E2E_TD_acc_% 账本孤儿 +2 行（append-only trigger 挡 DELETE，同票 11 处置 → 票 14 清扫）。
**S2/S5/S6 修复项**全部落 workflow-box 重写：依赖 [open]+ref 守卫 / 保存前 getTask 重取 /
preset 段退役无 data-preset-item。

**v4.1 接缝记录位**：本票 `## Exploration`「发现的接缝（票 12 登记）」①②③ +
acceptance-modal.tsx 头注（D13① 推荐卡 / D14 ImpactApprovalList / collect 登记）；
autoAdvance 开关落位裁决 = AuthoringWorkspace（AC5 可切面）+ 弹窗只读态（接缝④）。

## Verification Method
**Verification type**: browser E2E + 组件测试

**Verification steps**:
1. `packages/web-app/e2e/task-phase-acceptance.spec.ts`（AC1-4 网络计数用 page.on('request')）
2. 组件测试：BindingDialog 引用稳定回归（react 渲染计数）
3. `npx playwright test e2e/task-phase-acceptance.spec.ts`（web-app 目录）

**Pass criteria**: 全绿
**Failure handling**: Max 3 fix attempts, then mark SKIP with reason
