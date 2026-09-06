# 05 — E2E 验收：双 phase 零转述衔接（编程式，真 LLM SKIP）

## What to build

按 spec §Verification Strategy / Appendix Story 1 跑通端到端断言链（**不跑真 LLM**——simulate mock 已由 02 覆盖，本票验 server↔fs↔UI 四方交叉的部署态）：

`E2E_TD_PHASEHANDOFF_` 前缀编程式构造双 phase v4 任务（POST draft→写 phases 绑 matt-spec-dev+`${phase.batch_rel}`→入队）→ 预置 phase1 home 批次 `handoff.md`（模拟 ship+collect 已完成）→ `POST /:id/acceptance`(phase1, round1, accepted, autoAdvance) → 断言 → 清理。

证据落 `.scratch/phase-handoff-chaining/e2e-data/`（响应快照 + SQL 输出 + 截图）。

## Blocked by

01、02、04（03 为文档票，不入 E2E 依赖）。

## Status

done

真 LLM 零调用口径下完成 server↔DB↔fs↔UI 四方交叉验收：**AC1–AC5 全 PASS，AC6 如实 SKIP（用户成本决定，不假绿）**。

### 结果矩阵

| AC | 结论 | 关键证据（绝对路径见 e2e-data/e2e-screenshots） |
|----|------|------|
| AC1 | PASS | accept `next_action=dispatched`+`dispatch.p2r1`；DB envelope `workflow_chain[0].input_values.prev_handoff_paths` **=== phase1 handoff.md home 绝对路径**（字符串全等+`existsSync`+字节一致）；终态后仍持久；`AC1-acceptance-response.json` / `AC1-envelope-after-accept.json` / `AC1-runtime-delivery.json` / `AC1-db-ledger-rows.txt` |
| AC1+（运行时送达） | PASS | phase2 bash-stub 把 `$inputs.prev_handoff_paths` 原样落盘 → seed→start→collect 回 home `{batch2}/runtime-prev-handoff.txt` 值=注入路径；phase2 同 ws 复用 |
| AC2 | PASS | `e2e-screenshots/AC2-handoff-hint-n1.png.png`（弹窗含提示行「…共 1 个前序交接…」，DOM 文本全等断言）+ reject 态隐藏复验 + console errors=0 |
| AC3 | PASS | `GET /:id/home-file?path={batch1}&list=1` 返回含 `…/handoff.md (bytes=652)`；`AC3-home-file-list.json` |
| AC4 | PASS | 反例（无 handoff.md）accept **HTTP 200 非 500**、chain 不含 `prev_handoff_paths` 键、phase2 正常 completed、运行时值未含任何路径；`AC4-response-and-chain.json` / `AC4-runtime-degrade.json` |
| AC5 | PASS | 任务/信封/执行/ws 行 + home/ws 目录 + git fixture + org index.md 全清全恢复；health `/api/actuator/health` 200 全程（start/end）；`AC5-postclean-*.json` |
| AC6 | **SKIP (user decision)** | 真 LLM 深验按 spec Execution Decisions #2 成本口径 SKIP；matt-spec-dev 消费面由票 02 simulate（mock）覆盖 |

### 执行环境与偏差（诚实披露）

1. **部署态实例**：:3001 现役进程启动于 09-05 22:05（早于本特性 01:03 的 stage-0 提交构建），且 dev.mjs 非 watch——为满足「勿重启 dev」，AC1/3/4/5 跑在**同仓新构建的隔离实例**（PORT=3555、专用 DB `octopus-handoff-e2e.db`、共用 home fs）；测毕实例已停、临时 DB 已删，:3001/:3000 全程未动（health 200 复核）。AC2 按既有惯例走 :3000 web + :3001 API（弹窗提示纯前端派生，不依赖新 server 代码）。
2. **工作流绑定**：成本口径不跑真 LLM，phase 绑 `e2e-td-ho` bash-stub（票14 smoke-chain 同法）而非 matt-spec-dev；注入键=server 派发侧产物，与绑定流无关，且 stub 的运行时回写比 matt-spec-dev 探测更接近「执行输入实际值」证明。
3. **环境注记（非本特性缺陷）**：:3000 next dev 内嵌 `data-server-url=http://172.29.100.7:3001`（启动时刻 LAN IP）现已不可达 → 看板对任何浏览器返回空列表；AC2 脚本用 playwright route 将该主机名重写到 localhost:3001 取证。dev 下次重启即自愈。

### 修了什么（Quick Fix ×1，产品代码）

- `packages/server/src/services/git-ops.ts` `createOrSwitchBranch`：worktree 占用分支的兜底正则 `/already checked out/i` 在本机 git 2.43.0.windows 下不匹配新措辞 `already used by worktree at`，致**一切 v4 活体派发**在 `switchToExecutionBranch("main")` fatal（首次 E2E 全链 phase1 r1 必红的根因，`DEBUG-exec-failure.json` 留证）。扩为 `/already (?:checked out|used by worktree)/i`。既有回归用例（git-ops.test.ts，本机基线红）转绿：**server 全量红 43→42，基线未增加**。

### 复跑命令

```bash
# API 链（需 :3001 或任一最新构建 server + 可指定 DB）
E2E_ARTIFACTS_DIR=.../phase-handoff-chaining OCTOPUS_SERVER_URL=... OCTOPUS_DB_PATH=... \
  node e2e-scripts/01-ac1-ac3-ac4-ac5-api-chain.mjs
# UI 提示行
E2E_ARTIFACTS_DIR=.../phase-handoff-chaining node e2e-scripts/02-ac2-ui-handoff-hint.mjs
```

反假跑自评：R1 真服务（隔离同构建实例，偏差已披露）/R2 值断言（路径全等+字节一致）/R3 API↔DB↔fs↔运行时四方/R4 快照+SQL+PNG 落盘/R5 写副作用+回收双验/R6 本机 dev 无鉴权面（spec 环境表既定口径）/R7 `E2E_TD_PHASEHANDOFF_` 前缀+测后全清（账本行随隔离 DB 一并销毁）/R8 脚本自建自清零手工前置。

## Acceptance Criteria

- [x] AC1: accept 响应 next_action 进入 phase2；DB 查新执行 chain：`input_values.prev_handoff_paths` = phase1 handoff.md 绝对路径（API↔DB↔fs 三方一致，路径 existsSync）
- [x] AC2: 验收弹窗（phase1 待验收态）截图含提示行 N=1（UI 面）
- [x] AC3: 预置 handoff.md 出现在批次清单 LIST（home-file list 接口返回含之）
- [x] AC4: 反例——phase1 无 handoff.md 时 accept → phase2 chain 无该键且不 500（静默降级）
- [x] AC5: 测试数据全清（任务+home 批次目录），health `/api/actuator/health` 200 全程
- [x] AC6: 真 LLM 深验按用户决定标 `SKIP (user decision — 成本口径见 spec Execution Decisions #2)`，**不假绿**（本票实际深验结论=SKIP，登记于 Status）

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
