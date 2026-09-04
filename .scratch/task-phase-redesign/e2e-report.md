# 票 14 E2E 验证报告 — task-phase-redesign 主故事全链穿线

- 执行者：matt-e2e-tester（独立验证）
- 基线：`feat/task-phase-redesign` @ `b339f19a`（schema v40 迁移首启自动完成，验证通过）
- 环境：真 server（node dist :3001）· 真 web（next dev :3000，`NEXT_PUBLIC_PHASE_BUDGET_MS=1000` 注入）· 真 SQLite（`~/.octopus/db/octopus.db`）· 真 fs（task home / ws / git fixture）· 零 mock · 执行期 2026-09-03 05:07–06:05
- 主脚本：`packages/web-app/e2e/task-phase-lifecycle.spec.ts`（7 段 serial，**连续 4 次全绿 run**，最后一次 `--trace on`，12.2s）
- 计划内测试命令（票面 Verification Method 原样）：
  `cd packages/web-app && E2E_ARTIFACTS_DIR=…/task-phase-redesign npx playwright test e2e/task-phase-lifecycle.spec.ts --trace on`

## 结论总览

| AC | 判定 | 一句话 |
|----|------|--------|
| AC1 主故事一条跑通 | **PASS** | 7/7 绿、无 skip、真 server/DB/fs/git；agent 节点按票面 stub 原则用 bash-stub 工作流 |
| AC2 交叉真相四方一致 | **PASS** | UI 角标 == GET /:id derived == DB executions/账本 == fs 批次目录（S2/S3/S4/S7 多点断言） |
| AC3 反假跑 R1-R8 | **PASS**（R6 空操作，见下） | 明细见「反假跑合规」表 |
| AC4 证据留存 | **PASS** | `e2e-evidence/`（截图×26、trace×7、证据 JSON×4、run-notes）+ `e2e-screenshots/{lifecycle,test-results,task-domain}` |
| AC5 v3 回归 | **PASS（带基线勘误）** | 本票改动零回归（证据见下）；但「composite 现仍绿」的前提不成立——它在 b339f19a 基线上就是红的（陈旧断言 vs #55 v39 parked-draft，本票域外） |

## 主故事覆盖（一条链路，逐段）

S1 新建（v4 fixture：2 phase + 双 git-fixture project + stub 工作流入 home/workflows）→ **真点击 [入队执行]**（v4 gate 四行清单 ✅×4，信封落库 origin_role=primary/status=draft，config 物化 phases[2]/chain[0]=phase1）
S2 **真点击 触发→立即触发** → 真调度 claim → ws 首建（createFromSpec + 双 project worktree）→ seed 下行（ws 批次目录 == home）→ bash stub 执行 → 打标 (1,1) completed → collect 上行（ws exec-report.md + issues Status 变更回 home）→ SSE `task_artifacts_update` + `phase_status_update(awaiting_review)` → UI 待验收列 + 角标 `Phase 1/2 · Round 1`
S3 home spec 编辑（`E2E_TD_SPEC_R2_EDIT`）→ **真弹窗打回**（三栏齐现 + 反馈必填 disabled→enabled）→ 真 POST 200：账本 rejected + `fix-feedback-r1.md`（home）+ round2 **同 ws** dispatch → seed 带新 spec + fix-feedback 进 ws → workspaces 计数恒 1
S4 round2 终态 → `Phase 1/2 · Round 2` → **真点击 通过** → 账本 accepted → `auto_advance` → phase2 (2,1) 自动开跑（同 ws）→ SSE running(phase2)
S5 phase2 终态 → collect → **末通过** → 响应 task.status=archiving → 归档编排（真 git）→ 轮询 done + completed_at + SSE task_status(done) + 账本终局 3 行 `[rejected, accepted, accepted]`
S6 归档 git 真相：双 project **ADR 顺延 0004**（既有 0001-0003 → 0004-pick-db.md/0004-add-cache.md，尾行 `Synced from task <id>`）；术语 append（Gizmo/Sprocket）、**冲突 Widget 只报不写**（旧行原样、report.md 含词条）；HEAD 标题 `chore(archive): <task> syncback <state.date>`；bare origin `ls-remote` 含归档分支；state.json 双 project=done
S7 终局对账：derived.phaseViews（rounds 含 state×decision 双真相）== DB（3 条打标执行行 + 3 账本行）== fs（双批次 spec/exec-report/fix-feedback）== UI（done 列 + 弹窗时间线 `phase-row-1/2 [data-phase-status=accepted]`）

## 逐 AC 交叉验证证据表（OCTO-STANDARDS 4 层）

| AC | API Evidence | DB Evidence | SSE Evidence | UI Evidence | Layers |
|----|-------------|-------------|--------------|-------------|--------|
| AC1 | S1 ready 200/status=ready；S2 trigger 200；S3-S5 acceptance POST 200 next_action=dispatched/archiving；S5 task.status=archiving | executions (1,1)(1,2)(2,1) completed；schedules 1 行；workspaces 1 行；账本 3 行；tasks.workspace_id 绑定 | task_artifacts_update≥1；phase_status_update(awaiting_review p1 / running p2)；task_status(done) | 7/7 步真点击/真卡片断言（入队/触发/三栏/打回/通过×2/角标/done 列）；截图 12 张 | 4 |
| AC2 | GET /:id derived.phaseViews 状态/轮号逐字段 | 打标执行行+账本行+ws 计数=1+绑定列 | （同 AC1，实时驱动列迁移） | 角标文本 3 连断言 `Phase 1/2·R1`→`·R2`→`Phase 2/2·R1`；列归属断言 | 4 |
| AC3 | 全部经业务字段断言（见反假跑表） | fs 断言：seed 等值/collect 回传/fix-feedback/归档件 | 事件计数断言 | 每步截图 | 4 |
| AC4 | `e2e-evidence/data/lifecycle-evidence-*.json`×4（4 次绿 run） | — | 事件名清单入 evidence json | `screenshots-lifecycle/`×12 + `traces/`×7 | — |
| AC5 | 票 11/12 全套 18✓ 重跑（本票改动后）| server vitest：v4 四件套 62✓ + execution 邻域 149✓；全量 vitest 结果见「回归」节 | — | board AC4 ⏳（env 注入）✓ | — |

## 发现的产品缺陷（本票 E2E 独有价值）

### 发现①（已修复·票内关键路径）v4 同 ws 第二轮执行被 v1「单根」不变量挡死 → 打回/advance/auto_advance 全链不可用
- 症状：`POST /acceptance rejected` 409 `round 执行创建失败: Workspace already has a root execution (…)`。round2 起所有 dispatchPhaseRound 必炸（票 05 集成用 stub registry 镜像了 DB 写、未镜像 `ExecutionLifecycle.create` 的根执行守卫，故从未暴露）。
- 根因：v4 K4/K5「一 task 一 ws，每 round 一条独立根执行」与 v1「一 ws 一根」守卫冲突。
- 修复（最小面，4 文件 +23 行，工作区未提交）：`ExecutionLifecycle.create` 新增可选 `allow_existing_root`（默认关=行为字节不变）；`dispatchPhaseRound` 恒传 true；`execute()` 仅 `isV4` 传 true。文件：
  - `packages/server/src/services/execution/ExecutionLifecycle.ts`
  - `packages/server/src/services/execution.ts`（facade 类型）
  - `packages/server/src/services/tasks/tasks-service.ts`
  - `packages/server/src/services/scheduler/executors/workflow-executor.ts`
- 修复证据：修复前 red-capable 复现 = `e2e-scripts/02-smoke-reject-archive.mjs` FAIL@reject；修复后同脚本 8 断言全绿 + lifecycle spec 4 连绿 + 上述 211 个相关 vitest 全绿。

### 发现②（未修复·票外预存）任务 workspace 永远无法经 API/retention 删除
- 症状：任务 done 后 `DELETE /api/workspaces/:id` → 500 `FOREIGN KEY constraint failed`；retention 回收同败（错误被 catch+log 吞掉 → ws 目录无限堆积，`~/.octopus/orgs/E2E_TD_org/workspaces/` 现存 13 个 8 月孤儿目录即旁证）。
- 根因（`e2e-scripts/04-smoke-ws-delete-500.mjs` 实证）：`WorkspaceDAO.cascadeDeleteByWorkspace` 的桥表清理以 `schedules.workspace_id` 为键子查询，但 task 信封的 `schedules.workspace_id` **从未被写**（v3/v4 皆无，绑定存于 `schedule_workspaces` 桥表 + `tasks.workspace_id`）→ `schedule_executions`/`schedule_workspaces` 行残留 → 其 `execution_id → executions` NO ACTION 外键挡住 `DELETE FROM executions`。
- 建议修复（一行级）：cascade 中补 `DELETE FROM schedule_executions WHERE workspace_id = ?` 与 `DELETE FROM schedule_workspaces WHERE workspace_id = ?`（两表 workspace_id 列在两条执行路径均有写入）。
- 影响面：v3 任务池同样中招（非 v4 专属）；不阻塞任何票 14 AC（lifecycle spec 用 fs+DB 兜底清扫，调用方亦预留了该清扫通道）。

## 回归（AC5）

1. **本票改动零回归**：
   - 票 11 全套 5✓（含 AC4 ⏳ env 注入跑）；票 12 全套 8✓；lifecycle 7✓（四连）。
   - server vitest 邻域 211✓（v4 四件套 62 + execution/v3-dispatch/mutex/composite 149）。
   - **全量 server vitest**（含修复）：`Test Files 9 failed | 155 passed | 1 skipped (165)`，`Tests 37 failed | 2091 passed | 15 skipped`。9 个失败文件中 5 个（config-manager / detector-pipeline / prompt-assembler / clone-file-mgmt / harness-integration）= 票 05 验证记录同款基线噪音（task-author 资产/harness/snapshot）；其余 4 个（archive-routes ×10、archive-service ×1、scheduler-routes ×2、repos-routes ×1）做了 **stash 往返实证**：同一命令在 un-modified 源码上 `14 failed | 74 passed | 2 skipped` 与修复后**逐计数一致** → 预存状态型失败，非本票回归。
2. **基线勘误（重要）**：票面/交接语「task-domain-composite 与 generic 路径现有 e2e 全部仍绿」的前提在 b339f19a 上不成立——
   - `task-domain-composite` AC2 与 `task-domain-crash-abort` G4 断言 `envelope.status === "queued"`，而 readyTask 自 **#55 `ac8ef0b1`（v39 parked-draft，先于本分支）** 起创建 `'draft'` 停放信封；两个 spec 的断言写于 #51 时代。**已在 un-modified b339f19a dist 上复现同样失败**（stash 我的 4 文件 → 重建 → 跑 composite：同点 `Expected queued / Received draft`），与本票修复无关。
   - 处理：按 AC5「零修改」纪律未动这两 spec；修复属行为对齐小改（`"queued"` → `"draft"|"queued"` 或先 trigger 再断言），建议由 dev-runner/人工决定。
   - `task-domain-simple` Story A / `draft-linkage` Story C / `authoring-v3` fulllink 及 `harness-e2e` chatbot 组：需活体 LLM provider（server 进程无 API key，chat SSE 120s 超时）；helper 头注 R1 已声明该环境性。auth.spec.ts 引用不存在的 `/login` 页（开源首提交遗留模板件）。以上均非本票域、零修改、与发现①②改动路径无交集。

## 反假跑 R1-R8 合规

| # | 判定 | 说明 |
|---|------|------|
| R1 真服务 | ✓ | localhost:3001 dev 真 server/真调度/真 git 子进程（本项目「UAT」=本地 dev 栈，OCTO-STANDARDS 口径，无 mock server；主故事无 test.skip 路径，server 不可用即 beforeAll 抛错） |
| R2 业务数据 | ✓ | 断言到字段值：角标文本/next_action/dispatch.(phase,round,ws)/账本 decision+feedback/derived.phaseViews/ADR 文件名/commit 标题/state.date |
| R3 交叉验证 | ✓ | API↔DB↔fs↔SSE↔UI 五面（本项目无 Cache 层，OCTO-STANDARDS 适配） |
| R4 证据 | ✓ | 响应体入 evidence JSON、DB 行断言日志、26 截图、7 trace.zip |
| R5 副作用 | ✓ | 执行类写全验：executions 打标行/schedule_executions/node_executions+agent_events/账本 home fix-feedback/ws seed/collect/home archive state+report/bare 分支 push |
| R6 登录取 token | **N/A→空操作** | 本 server 无鉴权中间件（/api/tasks 等全开放，middleware 仅 error.ts；全库既有 e2e 零 token 先例）。非绕过登录——系统不存在登录 |
| R7 数据隔离+清扫 | ✓ | 全部 `E2E_TD_`/`e2e-td-lc-` 前缀；afterAll 自清 + `e2e-scripts/03-sweep-e2e-td.mjs` 终扫：tasks/executions/schedules/workspaces 残留=0（终验贴报告）；repos/index.md 逐字节还原；**task_phase_acceptances 孤儿计数=67 登记**（append-only trigger 挡 DELETE，按票 11 先例不 DROP） |
| R8 可重放 | ✓ | 同一命令 4 连绿（含冷启动全链：git fixture 自造、index 自注册自还原、无手工前置）；烟测脚本独立可跑 |

## 修复尝试记录（Step 4 台账）

| 失败 | 处置 | 结果 |
|------|------|------|
| smoke1：ws 首建失败 `local path … unreachable` | 测试侧 fixture bug（index.md `- local:` 行需 ` ✓` 收尾，resolveRepoPath 正则 `$` 无 m 标志吞行）→ 修 fixture | 绿 |
| smoke2：reject 409 `already has a root execution` | **产品缺陷①** Quick Fix（4a，最小面 opt-out 旗标）→ red-capable 脚本转绿 → 211 vitest 绿 → spec 绿 | 修复 |
| lifecycle S3 中列产物行不出现 | 票 12 已登记的 v4.1 接缝③（.scratch 不登记 artifacts.json）→ 改断言为登记可见语义的空态（诚实按既有裁决，非硬测） | 绿 |
| lifecycle S6 syncback 日期不符 | 测试侧日历耦合（server ymd=UTC，本地=+08）→ 改读 state.date 自对账 | 绿 |
| lifecycle S7 时间线选择器 | 测试侧 DOM 选择器（data-phase-status 在同元素复合选择器） | 绿 |
| ws delete 500 | **产品缺陷②** 判定票外预存 → 不修，根因+建议入报告；测试侧 fs+DB 兜底清扫 | 登记 |
| composite/crash-abort `queued` 断言 | 基线预存红（stash 复现法实证与本改动无关）→ 按零修改纪律不修 | 登记 |

## 产物索引（绝对路径）

- 主脚本：`/Users/xzf/Projects/ai/XzhiF/open-octopus/packages/web-app/e2e/task-phase-lifecycle.spec.ts`
- 修复 diff：`packages/server/src/services/{execution.ts,execution/ExecutionLifecycle.ts,tasks/tasks-service.ts,scheduler/executors/workflow-executor.ts}`（工作区，未提交）
- 证据包：`/Users/xzf/Projects/ai/XzhiF/open-octopus/.scratch/task-phase-redesign/e2e-evidence/`（screenshots-lifecycle ×12、traces ×7、data ×4、screenshots-t11-t12 ×14、logs/run-notes.md）
- 复现/清扫脚本：`/Users/xzf/Projects/ai/XzhiF/open-octopus/.scratch/task-phase-redesign/e2e-scripts/{01-smoke-chain,02-smoke-reject-archive,03-sweep-e2e-td,04-smoke-ws-delete-500}.mjs`
- 截图工作区：`…/e2e-screenshots/{lifecycle,task-domain,test-results}`

## 遗留待人工

1. 缺陷①修复的 4 文件改动需 review + 提交（含 `tasks-v4-ws-reuse` 集成测试把 stub create 换成真 `ExecutionLifecycle.create` 的加固建议——正是它掩盖了缺陷①）。
2. 缺陷② cascade 补桥表删除（v3 同修）。
3. composite/crash-abort 的 v39 陈旧断言对齐（一处字面量）。
4. `task_phase_acceptances` 67 孤儿行 + 13 个 8 月 E2E_TD_org 旧 ws 目录：建议随缺陷②修复一并做一次性回收。
