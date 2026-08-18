# 11 — E2E 全链路：task-authoring-v3.spec.ts

## What to build
端到端闭环验证（spec AC Mapping 中标记 Browser E2E 的全部 US）：新建 `e2e/task-authoring-v3.spec.ts`，扩展 task-domain-helpers（复用 SSE collector / SQLite 直读 / E2E_TD_ 前缀），覆盖 US1/2/3/4/6/7/14 的真实 UI 路径，R1-R8 全达标，screenshot 证据。

## Blocked by
09 — 前端两阶段流 · 10 — 前端产出查看器

## Status
ready-for-agent

## Acceptance Criteria
- [ ] AC1: 全链路 story：模板页（2 Skill 组 + org/项目）→ 创建（单 draft + 双向绑定 + 家目录 + plugin 物化）→ chat → goal/ac 浮现 → 直编 → 确认 → 产物全文查看 → 入队 ready
- [ ] AC2: 锁定回归：PUT 改 skill_groups → 409（UI 层无入口 + API 层断言）
- [ ] AC3: 门禁回归：未确认入队 → 409 + 缺失项；确认后 200
- [ ] AC4: 数据隔离：全部数据 E2E_TD_ 前缀；spec afterAll 清理（DELETE + reap 断言）
- [ ] AC5: R3/R4：每个关键步骤 API↔DB↔文件系统交叉断言 + screenshot
- [ ] AC6: server 不可用时 test.skip（沿用 isServerAvailable 模式），不假绿

## Verification Method
**Verification type**: browser E2E（Playwright）

**Verification steps**:
```bash
pnpm build && pnpm dev &   # server :3001 + web :3000
cd packages/web-app && pnpm playwright test e2e/task-authoring-v3.spec.ts --reporter=list
```
全部用例 PASS；检查 screenshot 产物落 E2E_ARTIFACTS_DIR；`grep -c "expect(" e2e/task-authoring-v3.spec.ts` 断言密度 ≥ 0.22（assertion density 健康线）。

**Pass criteria**: All verification steps PASS
**Failure handling**: Max 3 fix attempts, then mark SKIP with reason
