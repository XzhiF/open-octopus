# 14 — E2E 主故事穿线：phase 全生命周期真实验证

## What to build
端到端主故事验证（浏览器真实路径 + 真实 server/DB/fs/git fixture，agent 执行节点用 stub 工作流模拟）：新建 coding 任务 →（stub phases 经 API 直造）确认拆分与逐 phase 绑定 → v4 入队 → 触发 phase1 → 待验收三栏 → 打回带反馈 → round2 同 worktree 开跑（seed 反映 home 新 spec）→ 通过 → phase2 自动开跑（auto_advance）→ 末通过 → archiving（ADR 顺延/术语 append/归档 commit 落 git fixture）→ done；全程五列/角标/时间线/SSE 实时性正确。

## Blocked by
01, 02, 03, 04, 05, 06, 07, 08, 09, 10, 11, 12, 13

## Status
ready-for-agent

## Acceptance Criteria
- [ ] AC1: 主故事一条跑通（Playwright 无 skip、非 mock server）
- [ ] AC2: 交叉真相断言：UI 角标 == GET /:id phases == DB 账本/executions 行 == fs 目录四方一致
- [ ] AC3: 反假跑标准 R1-R8 全项满足（真实服务、业务字段断言、API↔DB↔文件三方、副作用验证、登录取 token、E2E_TEST_ 隔离、无手工前置）
- [ ] AC4: 证据留存：截图/trace 归档到 `.scratch/task-phase-redesign/e2e-evidence/`
- [ ] AC5: v3 回归：task-domain-composite.spec.ts 与 generic 路径现有 e2e 全部仍绿（零修改）

## Verification Method
**Verification type**: browser E2E

**Verification steps**:
1. `packages/web-app/e2e/task-phase-lifecycle.spec.ts` 主故事脚本
2. `cd packages/web-app && npx playwright test e2e/task-phase-lifecycle.spec.ts --trace on`
3. 回归：`npx playwright test e2e/`（全量，composite 必须绿）
4. 读 e2e-report，逐 AC 勾

**Pass criteria**: 主故事 + 全量回归绿，证据目录非空
**Failure handling**: Max 3 fix attempts, then mark SKIP with reason
