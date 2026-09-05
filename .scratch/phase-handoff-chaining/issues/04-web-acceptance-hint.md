# 04 — web：验收弹窗「前序交接自动带入」提示行

## What to build

`packages/web-app/components/tasks/acceptance-modal.tsx`：decision=accepted ∧ 存在下一 phase 时，确认按钮上方一行提示——「本 phase 的 handoff.md 连同已 accepted 共 N 个前序交接，将自动进入下一 phase 执行会话」（N = 已 accepted 前序数 + 1）。数据源=弹窗已持有的 task phases 状态，**无新 API、无后端改动**。末 phase accepted 不显示（无下一站）。批次清单不需另做——home-file LIST 已自动呈现回流后的 handoff.md（K6）。

## Blocked by

None — can start immediately.（提示语义在 spec K6 已锁，不依赖 01/02 实现物）

## Status

ready-for-agent

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
