# 04 — web：验收弹窗「前序交接自动带入」提示行

## What to build

`packages/web-app/components/tasks/acceptance-modal.tsx`：decision=accepted ∧ 存在下一 phase 时，确认按钮上方一行提示——「本 phase 的 handoff.md 连同已 accepted 共 N 个前序交接，将自动进入下一 phase 执行会话」（N = 已 accepted 前序数 + 1）。数据源=弹窗已持有的 task phases 状态，**无新 API、无后端改动**。末 phase accepted 不显示（无下一站）。批次清单不需另做——home-file LIST 已自动呈现回流后的 handoff.md（K6）。

## Blocked by

None — can start immediately.（提示语义在 spec K6 已锁，不依赖 01/02 实现物）

## Status

done

- AC1-AC4 全绿：单测 `acceptance-modal.test.tsx` 10/10（新增提示行三态 3 用例）；playwright `task-phase-acceptance.spec.ts` 9/9（新增 2 用例，E2E_TD_PHASEHANDOFF_ 前缀自建自清）。
- 基线：web 全量 `pnpm test` 红 = 3 files（harness/knowledge/system-pages），未增加（一次 execution-summary 并发负载抖动，单独跑 + 复跑全量均绿）。
- 备注：执行时 dev server 实际未跑（:3000/:3001 无监听），已 `pnpm dev` 拉起并保持运行以满足环境假设。

## Acceptance Criteria

- [x] AC1: 双 phase 任务、phase1 待验收 → 弹窗 accepted 态显示提示行 N=1；切 rejected 态不显示
- [x] AC2: phase2 accepted 时已有 1 前序 accepted → N=2；末 phase（无下一站）不显示
- [x] AC3: web 单测覆盖上述三态；playwright 断言提示可见性
- [x] AC4: 基线 web 3 files 红不增加、既有弹窗用例不回归

## Exploration

- 类比对象 = 本弹窗自身（acceptance-modal.tsx 右列动作区已有同密度次要文案：`text-[10px] text-muted-foreground` 的「开关在草稿面板」行）→ 提示行照此风格，插在「验收通过」按钮上方。
- 数据源确认：`derived.phaseViews`（`TaskPhaseView`，lib/tasks-api.ts:108）。前序 accepted 判定用 `acceptedRound !== null`（derive-task-view.ts:244-254：账本为真相，acceptedRound!==null ⇔ status="accepted"，二者等价，取 acceptedRound 口径）；「存在下一 phase」用 position 判定（与既有按钮 label 的 `findIndex(...)+1` 同一口径，acceptance-modal.tsx:417）。
- 「rejected 态不显示」落点：reject 面板展开（`rejectOpen`）即隐藏提示；打回提交成功后 awaitingPhase 派生消失 → 天然不渲染。
- 不改 lib/tasks-api.ts、无新 API、不动 phases[] 信封（K16）。
- playwright 惯例：`e2e/task-phase-acceptance.spec.ts` 的 `awaitingTaskFixture`（API 直造 v4 + sqlite 直造 exec 链）；末 phase 场景仿「归档重试」用例直插 `task_phase_acceptances` accepted 行 + phase2 completed 链。
- 改动文件清单：仅 `acceptance-modal.tsx` + `__tests__/acceptance-modal.test.tsx` + `e2e/task-phase-acceptance.spec.ts`。

## Acceptance Criteria

- [ ] AC1: 双 phase 任务、phase1 待验收 → 弹窗 accepted 态显示提示行 N=1；切 rejected 态不显示
- [ ] AC2: phase2 accepted 时已有 1 前序 accepted → N=2；末 phase（无下一站）不显示
- [ ] AC3: web 单测覆盖上述三态；playwright 断言提示可见性
- [ ] AC4: 基线 web 3 files 红不增加、既有弹窗用例不回归

## Verification Method

**Verification type**: unit test + browser E2E

**Verification steps**:
```bash
pnpm --filter @octopus/web-app test
cd packages/web-app && npx playwright test e2e/task-phase-acceptance.spec.ts
```
（playwright 数据用 E2E_TD_PHASEHANDOFF_ 前缀任务，测后清理；dev server :3000/:3001 在跑）

**Pass criteria**: AC1–AC4 全绿
**Failure handling**: Max 3 fix attempts, then mark SKIP with reason
