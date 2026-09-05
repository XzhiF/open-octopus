# 05 — E2E 验收：双 phase 零转述衔接（编程式，真 LLM SKIP）

## What to build

按 spec §Verification Strategy / Appendix Story 1 跑通端到端断言链（**不跑真 LLM**——simulate mock 已由 02 覆盖，本票验 server↔fs↔UI 四方交叉的部署态）：

`E2E_TD_PHASEHANDOFF_` 前缀编程式构造双 phase v4 任务（POST draft→写 phases 绑 matt-spec-dev+`${phase.batch_rel}`→入队）→ 预置 phase1 home 批次 `handoff.md`（模拟 ship+collect 已完成）→ `POST /:id/acceptance`(phase1, round1, accepted, autoAdvance) → 断言 → 清理。

证据落 `.scratch/phase-handoff-chaining/e2e-data/`（响应快照 + SQL 输出 + 截图）。

## Blocked by

01、02、04（03 为文档票，不入 E2E 依赖）。

## Status

ready-for-agent

## Acceptance Criteria

- [ ] AC1: accept 响应 next_action 进入 phase2；DB 查新执行 chain：`input_values.prev_handoff_paths` = phase1 handoff.md 绝对路径（API↔DB↔fs 三方一致，路径 existsSync）
- [ ] AC2: 验收弹窗（phase1 待验收态）截图含提示行 N=1（UI 面）
- [ ] AC3: 预置 handoff.md 出现在批次清单 LIST（home-file list 接口返回含之）
- [ ] AC4: 反例——phase1 无 handoff.md 时 accept → phase2 chain 无该键且不 500（静默降级）
- [ ] AC5: 测试数据全清（任务+home 批次目录），health `/api/actuator/health` 200 全程
- [ ] AC6: 真 LLM 深验按用户决定标 `SKIP (user decision — 成本口径见 spec Execution Decisions #2)`，**不假绿**

## Verification Method

**Verification type**: API integration test + browser E2E（Playwright）

**Verification steps**:
```bash
# 脚本化：lib/tasks-api 或 curl；DB 断言用 sqlite3 / matt-sql-executor
curl -s -X POST http://localhost:3001/api/tasks/:id/acceptance -H 'content-type: application/json' -d '{"phase_index":1,"round_index":1,"decision":"accepted"}'
sqlite3 ~/.octopus/db/octopus.db "SELECT ... chain/input_values FROM <执行表> WHERE <新round>"   # 断言含 prev_handoff_paths
cd packages/web-app && npx playwright test e2e/task-phase-acceptance.spec.ts --grep handoff
```
**Pass criteria**: AC1–AC5 PASS，AC6 如实 SKIP
**Failure handling**: Max 3 fix attempts, then mark SKIP with reason
