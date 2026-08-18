# Verification Report: task-authoring-v3

Generated: 2026-08-18 22:25 (local)
Commit: a9fe1206 (HEAD)
Branch: feat/task-domain-redesign
Mode: static (targeted live re-run of feature-scoped tests only; no full-suite run, no mutations)
Artifacts: .scratch/task-authoring-v3/
Diff base: `9917e986...HEAD` (iteration #44 scope; branch carries already-shipped iteration #43)

---

## Executive Summary

| Metric | Value |
|--------|-------|
| **Confidence Score** | **78.5/100** |
| **Decision** | **REVIEW** |
| Requirements Traced | 30/33 (90.9%) — US8 + D12 PARTIAL by design, 0 MISSING |
| Test Authenticity | 82/100 |
| Quality Gates | 6/6 passed |
| Top Risk | Large multi-package surface (82 files, risk factor 0.6) + unverified LLM-behavior exclusions + one stale sibling E2E spec (cross-feature regression) |

Independent audit highlights:
- **214/214 feature-scoped unit/integration tests re-run LIVE during this audit — all green** (shared 23, server 135, engine 12, web-app 44).
- `pnpm build` re-run LIVE during this audit — **exit 0**.
- E2E spec claim "156 expects / 14 tests" — **VERIFIED** (actual count 156 / 14).
- Zero empty tests, zero tautological assertions, zero hard-coded sleeps.
- No new dependencies, no DB migration files (spec "no DB schema change" — VERIFIED).
- Two reporting discrepancies found in pipeline-report.md (scope-table base mislabel, screenshot count 19 vs 18 v3-specific). See §6.

---

## 1. Requirements Traceability Matrix

Atoms: 14 user stories (US1–US14) + 19 decisions (D1–D19, behavioral). Evidence gathered via grep against the iteration diff.

| REQ-ID | Requirement | Code Ref | Test Ref | Status |
|--------|-------------|----------|----------|--------|
| US1 | 模板页选择→创建→编写（单 draft + 会话绑定） | ✅ tasks-service.ts `createTask` v3 path (`isV3`, home+materialize+scope_id) · routes/tasks.ts POST · template-picker.tsx · tasks-api.ts | ✅ tasks-v3-routes.test.ts AC2/AC3（恰一个 draft）· e2e test 2, 13 | COVERED |
| US2 | Skill 组多选整合 | ✅ plugin-materializer.ts `materializeGroups` · tasks-service createTask skill_groups[] | ✅ plugin-materializer.test.ts (14) · tasks-v3-routes AC2（两组物化）· e2e test 13 | COVERED |
| US3 | 创建后锁定（PUT 409 + schema 往返） | ✅ tasks-service.ts `updateTask` SW-BP9 lock → 409 + merge-preserve · scheduler-job.ts taskSpecSchema | ✅ tasks-v3-routes AC4 · task-schema-v3.test.ts（PUT 往返）· e2e test 3（🔒 badge）, 14（409+merge） | COVERED |
| US4 | goal/ac SSE 浮现 | ✅ tasks-service.ts:641 `SPEC_FIELD_UPDATE_EVENT` emit · goal-ac-card.tsx SSE subscription | ✅ goal-ac-card.test.tsx (8) · e2e test 4, 13 | COVERED |
| US5 | 用户直编 → @@spec_updated | ✅ tasks-service.ts:665 `source==="user"` → setSpecNotice | ✅ tasks-v3-gates.test.ts AC1（notice 含 @@spec_updated+goal）· clone-spec-notice.test.ts (7) · e2e test 4 | COVERED（下轮投递 = manual，spec 已声明） |
| US6 | 确认后方可入队（409+缺失项） | ✅ tasks-service.ts `TaskReadyGateError`(:109) + gate(:697) goal_confirmed/ac_confirmed | ✅ tasks-v3-gates.test.ts (15) · e2e test 5, 6, 13 | COVERED |
| US7 | 产物完整内容查看 + 降级 | ✅ task-home-service.ts `readArtifactContent` + `ArtifactAccessError`(FORBIDDEN/NOT_FOUND) · routes artifacts/content · artifact-viewer-dialog.tsx | ✅ tasks-v3-artifacts.test.ts (14, 含 403/404/损坏) · task-home-service.test.ts (19) · e2e test 7, 8, 9 | COVERED |
| US8 | 对话改产物 | ✅ builtin-clones.ts persona 扩展（decisions 字段 + 产物指令） | ❌ manual checklist only（R2 accepted exclusion） | **PARTIAL** |
| US9 | agent 建议 + 用户执行辅助工作流 | ✅ assist-workflow-service.ts `trigger` + 白名单 · routes POST assist-workflows · workspace `source='task-assist'` | ✅ tasks-v3-assist.test.ts AC2/AC3（400 + workspace 行）· e2e test 10 | COVERED（建议气泡 = manual） |
| US10 | 过程日志（时间戳+专家步骤） | ✅ assist-workflow-service.ts `getRun` logs（JSONL → {t,icon,text}） | ✅ tasks-v3-assist.test.ts AC4 · e2e test 10（日志弹窗） | COVERED |
| US11 | MoA 勾选采纳（ac+decisions）+ 解析兜底 | ✅ moa-adoption-panel.tsx → spec-field(ac)+spec-field(decisions) · shared validateSpecFieldValue decisions 分支 · output_raw fallback | ✅ tasks-v3-assist.test.ts AC5（broken JSON）· task-schema-v3 · e2e test 11, 12 | COVERED |
| US12 | dispatch 注入 $vars.task_artifacts_dir（三路径） | ✅ scheduler-service.ts:213-214（simple+composite）· workflow-executor.ts:612-616（preserve）· composition-task.yaml input_mapping · engine task-dispatch.ts:91 | ✅ tasks-v3-dispatch.test.ts (7, 三路径+向后兼容) · e2e test 13 | COVERED |
| US13 | 删除 reap 家目录（不跟随 junction） | ✅ tasks-service deleteTask → reapHome · task-home-service `reapHome` lstat 预扫描 | ✅ task-home-service.test.ts SW-BP14 junction · tasks-v3-routes AC5/AC5b · e2e afterAll | COVERED |
| US14 | 预设仅 org+projects | ✅ authoring-workspace.tsx preset popup | ✅ authoring-workspace.test.tsx · e2e test 3（无 skills 选项） | COVERED |
| D1 | Per-task plugin 目录（第三 plugin 目录） | ✅ clone-runtime.ts:247 `getPlugins(taskHomePath?)` 追加第三目录 | ✅ clone-runtime.test.ts (31, 含回归) · plugin-materializer.test.ts | COVERED |
| D2 | 创建时锁定 | 同 US3 | 同 US3 | COVERED |
| D3 | registry group 聚合数据源 | ✅ routes/skill-groups.ts (NEW) ResourceManager.list 聚合 + frontmatter best-effort | ✅ tasks-v3-routes AC1 · skill-groups-api.test.ts (3) · e2e test 1 | COVERED |
| D4 | skill_groups 不写 authoring_resources | ✅ tasks-service createTask | ✅ tasks-v3-routes AC6（authoring_resources == [] ） | COVERED |
| D5 | 家目录约定 + artifacts.json | ✅ task-home-service.ts（createHome/readArtifacts/writeArtifactEntry） | ✅ task-home-service.test.ts (19) | COVERED |
| D6 | @@task_context system prompt append | ✅ routes/clone/index.ts:394 + clone-runtime 第 9 位参数穿透 | ✅ clone-spec-notice.test.ts (3 个新集成测试) · clone-runtime.test.ts | COVERED（投递效果 = manual） |
| D7 | 双通道编辑 | 同 US5 | 同 US5 | COVERED |
| D8 | ghost 占位 → SSE 浮现 | ✅ goal-ac-card.tsx ghost state | ✅ goal-ac-card.test.tsx · e2e test 4 | COVERED |
| D9 | 内置 3 模板 + 白名单 | ✅ core-pack 3 YAML + 3 .test.yaml · ASSIST_WORKFLOW_TEMPLATES | ✅ assist-workflows-simulator.test.ts (12 live PASS) · tasks-v3-assist（400） | COVERED |
| D10 | 三段式采纳 | ✅ assistWorkflowOutputSchema + moa-adoption-panel | ✅ e2e test 11 · tasks-v3-assist output 断言 | COVERED |
| D11 | 无审批按钮 + 右侧面板形态 | ✅ artifact-viewer-dialog.tsx footer「有意见在对话里说」 | ✅ e2e test 7（footer + 无审批按钮断言） | COVERED |
| D12 | TaskModal 内部重构，不加新路由 | ⚠️ task-modal.tsx 重构 ✅；但 app/tasks/prototype/page.tsx 新路由随 spec 阶段产物入库 | ❌ 原型无测试（throwaway 标记） | **PARTIAL** |
| D13 | 预设瘦身 | 同 US14 | 同 US14 | COVERED |
| D14 | server 侧物化注入三路径 | 同 US12 | 同 US12 | COVERED |
| D15 | 会话先行创建顺序 | ✅ tasks-v3-routes SG3 scope_id 回写 · persona 显式创建必须带 source_chat_session_id | ✅ tasks-v3-routes AC3 · e2e test 2, 13 | COVERED |
| D16 | 辅助工作流临时 workspace 宿主 | ✅ assist-workflow-service.ts:164 `source:"task-assist"` + 终态 reap | ✅ tasks-v3-assist AC2/AC6 | COVERED |
| D17 | default 组空标记不物化 | ✅ plugin-materializer.ts:79 skip default | ✅ plugin-materializer AC3 · tasks-v3-routes AC1（default skills==[]) · e2e test 1 | COVERED |
| D18 | 确认持久化 + ready 门禁 | 同 US6 | 同 US6 | COVERED |
| D19 | SSE 刷新通道（无轮询） | ✅ tasks-service.ts:649-655 伴随 emit `TASK_ARTIFACTS_UPDATE_EVENT` · output-viewer.tsx 纯 SSE（grep 证实零 setInterval/setTimeout） | ✅ tasks-v3-gates D19 test · e2e test 4（collector 断言 task_artifacts_update） | COVERED |

**Coverage**: 30/33 (90.9%) — EXCELLENT band (≥90%)

### Unimplemented / Partial Requirements
- **US8 (PARTIAL)** — 对话改产物为 LLM 行为，spec 显式分配 manual checklist（R2 策略）；机制侧（persona 指令 + artifacts.json 写入路径）存在，无自动断言。
- **D12 (PARTIAL)** — 功能载体确为 TaskModal 内部重构（✅），但 `/tasks/prototype` 原型路由仍在 app 内（spec 阶段产物，Remaining Issue #3 已记录，建议合并前决定去留）。

### Orphan Tests (no requirement link)
- 无实质孤儿。clone-runtime.test.ts / clone-spec-notice.test.ts 中的回归用例对应 D1/D6/SW-BP15；task-domain-schema / task-pool-schema 的修改为类型兼容 collateral（ticket 01 已说明）。

---

## 2. Test Authenticity Audit

### 2.1 Assertion Analysis

Density = `expect(`/`expectTypeOf` occurrences ÷ non-blank non-comment lines.

| File | Lines | Assertions | Density | Rating |
|------|-------|-----------|---------|--------|
| server/tasks-v3-routes.test.ts | 399 | 51 | 0.128 | LOW ⚠️ |
| server/tasks-v3-gates.test.ts | 321 | 47 | 0.146 | LOW ⚠️ |
| server/tasks-v3-assist.test.ts | 372 | 49 | 0.132 | LOW ⚠️ |
| server/tasks-v3-artifacts.test.ts | 229 | 33 | 0.144 | LOW ⚠️ |
| server/tasks-v3-dispatch.test.ts | 305 | 22 | 0.072 | LOW ⚠️ |
| server/clone-spec-notice.test.ts | 306 | 37 | 0.121 | LOW ⚠️ |
| server/task-home-service.test.ts | 237 | 44 | 0.186 | MEDIUM |
| server/plugin-materializer.test.ts | 199 | 43 | 0.216 | MEDIUM |
| server/clone-runtime.test.ts | 467 | 67 | 0.143 | LOW ⚠️ |
| shared/task-schema-v3.test.ts | 188 | 39 (+19 expectTypeOf) | 0.207 (0.308 eff.) | MEDIUM/HIGH |
| engine/assist-workflows-simulator.test.ts | 61 | 10 | 0.164 | MEDIUM |
| web/authoring-workspace.test.tsx | 176 | 17 | 0.097 | LOW ⚠️ |
| web/goal-ac-card.test.tsx | 185 | 16 | 0.086 | LOW ⚠️ |
| web/template-picker.test.tsx | 115 | 19 | 0.165 | MEDIUM |
| web/skill-groups-api.test.ts | 52 | 9 | 0.173 | MEDIUM |
| web/tasks-api.test.ts (v3 additions) | 274 | 58 | 0.212 | MEDIUM |
| **web/e2e/task-authoring-v3.spec.ts** | **819** | **156** | **0.190** | **MEDIUM** |

**Overall assertion density (17 files)**: 736 assertions / 4,705 LOC = **0.157 (MEDIUM, low end)**
Sub-score = min(0.157/0.30, 1.0) = **0.52**

Context: integration tests carry heavy request-construction boilerplate (Hono `app.request` + JSON bodies), which mechanically depresses line density; assertions themselves are value-based and from independent truth sources (DB reads, disk reads, SSE payloads). The claimed E2E density **156 expects / 14 tests was independently re-counted and confirmed**.

### 2.2 Issues Detected

| Type | File | Line | Detail |
|------|------|------|--------|
| (none) | — | — | EMPTY_TEST scan: 0 real empties (3 type-level tests use `expectTypeOf` = real compile-time assertions; 1 scanner artifact) |
| (none) | — | — | TAUTOLOGICAL scan: 0 × expect(true); 5 × `toBeDefined` all inspected — each followed by value assertions (`toContain`/`toEqual`/field checks); RTL `getByText().toBeDefined()` is non-tautological (getByText throws on absence); no status-200-only tests (every 200/201 check is paired with body/DB/FS assertions) |
| HAPPY_PATH_NOTE | goal-ac-card / template-picker / simulator suites | — | 0 name-classified negative tests in 3 suites (frontend render paths); overall ratio stays ACCEPTABLE |
| MYSTERY_GUEST | e2e/task-authoring-v3.spec.ts | — | Depends on live server :3001/:3000 + direct SQLite; mitigated by `test.skip(!serverAvailable)` guard (no fake green) + E2E_TD_ prefix |

### 2.3 Negative Test Coverage

- Total tests (15 suites analyzed): **171**
- Negative tests (400/403/404/409, invalid/corrupt/escape/lock/degraded paths): **49**
- **Negative ratio: 28.7% (ACCEPTABLE, 20–29%)** — sub-score 0.96
- Notable negative coverage: artifact path traversal `../` → 403; unregistered absolute path → 403; corrupt artifacts.json → []+warn; bad assist template → 400; broken aggregator JSON → output_raw+parse_error; PUT locked fields → 409; unconfirmed ready → 409+missing[]; reap-does-not-follow-junction.

### 2.4 Test Smells

| Smell | Count | Severity |
|-------|-------|----------|
| Empty Test | 0 | — |
| Tautological | 0 | — |
| Sleepy Test | 0 (no setTimeout/waitForTimeout in any new test) | — |
| Assertion Roulette (large multi-step E2E tests, e.g. fulllink ~30 asserts) | 1 | LOW (steps are commented + screenshot-segmented) |
| Mystery Guest (live-server E2E dependency) | 1 | LOW (skip-guard + documented in AC6) |

**Authenticity score**: (0.52×0.30 + 1.0×0.15 + 1.0×0.20 + 0.96×0.20 + 0.8×0.15) × 100 = **82/100**

---

## 3. E2E Script Audit

`e2e-scripts/` contains only one debug helper (`debug-assist-seed-get.mjs` — used for test-11 root-cause isolation, not an acceptance script). The real E2E surface is the Playwright spec:

| Script | Real Requests | Body Checks | Cross-Validates | Error Tests | Rating |
|--------|:------------:|:-----------:|:---------------:|:-----------:|--------|
| e2e/task-authoring-v3.spec.ts (14 tests) | ✅ real browser + real server :3001 | ✅ 44 DB/FS/SSE cross-check markers (readTaskRow, readTaskHomeDir, fs.readFileSync, SSE collector) | ✅ 5 layers: API↔DB↔FS↔SSE↔UI (R3) | ✅ 403/404/400/409 paths | **AUTHENTIC** |
| e2e-scripts/debug-assist-seed-get.mjs | ✅ real GET against :3001 | ✅ parses body | n/a (debug) | — | AUTHENTIC (diagnostic only) |

Evidence of real runs: 18 v3-specific PNGs with mtime 2026-08-18 22:01 (post review-fix regeneration), verbatim Playwright output in issue 11 (14 passed, timings), independent matt-e2e-tester re-run section (14/14, retries=0, 24.9s) with a documented test-only Quick Fix consistent with the D19 SSE-only design.

---

## 4. Quality Gate Results

| Gate | Criteria | Threshold | Actual | Result |
|------|----------|-----------|--------|--------|
| Spec Completeness | ACs have verification methods | 100% | 100% (AC Mapping table US1-14 + every issue has Verification Method block) | **PASS** |
| Code Completeness | Requirements with code refs | ≥ 90% | 33/33 = 100% | **PASS** |
| Test Completeness | Requirements with test refs | ≥ 80% | 31/33 = 93.9% (US8, D12 lack auto tests) | **PASS** |
| Test Authenticity | Composite authenticity score | ≥ 70 | 82 | **PASS** |
| Build Health | TypeScript compilation | 0 errors | `pnpm build` re-run live during audit → exit 0 (note: tsup bundles DTS but repo has no full `tsc` gate; shared carries 9 pre-existing tsc errors per ticket-01 notes — pre-existing, not gated) | **PASS** |
| Ticket Resolution | Issues marked done | ≥ 80% | 11/11 = 100% (statuses + Verification Result sections verified; ticket 01 checkboxes left unchecked — hygiene only) | **PASS** |

Baseline handling: 31 pre-existing failing vitest files (known-baseline-failures.txt) excluded from the pass-rate denominator. **Sampled 3/3 confirmed unrelated to the diff**: `model-alias.test.ts` (provider alias drift — file not in diff), `task-dao.test.ts` (DB schema/DAO test — feature explicitly adds zero schema changes, file not in diff), `detector-pipeline.test.ts` (harness — not in diff).

---

## 5. Confidence Score Breakdown

| Dimension | Weight | Score | Weighted |
|-----------|--------|-------|----------|
| Traceability | 25% | 0.909 (30/33 COVERED) | 0.2273 |
| Test Pass Rate | 25% | 1.00 (214/214 feature tests re-run LIVE in this audit: shared 23 + server 135 + engine 12 + web 44; E2E 14/14 claim backed by screenshots/verbatim output, not re-executed — static mode) | 0.2500 |
| Assertion Density | 20% | 0.523 (0.157 / 0.30) | 0.1047 |
| Negative Tests | 15% | 0.957 (28.7% / 30%) | 0.1435 |
| Change Risk | 15% | 0.40 (risk factor 0.6: 82 files > 80 → 0.6 base; +0.0 sensitive areas; +0.0 new deps — verified zero package.json changes; +0.0 migrations — verified zero .sql/migration files in diff) | 0.0600 |
| **Total** | **100%** | | **78.5/100** |

---

## 6. Cross-Reference: pipeline-report.md Claims vs Evidence (static mode — replaces dynamic section)

| # | Claim | Verdict | Evidence |
|---|-------|---------|----------|
| 1 | E2E "156 expects / 14 tests / 11.1 per test" | ✅ VERIFIED | Independent recount: 156 `expect(` occurrences, 14 `test(` blocks. (Issue 11's earlier "154" predates the D19 assertion additions — consistent timeline, not a contradiction.) |
| 2 | "19 张截图" | ⚠️ INFLATED BY 1 | 19 PNGs exist, but one is `task-domain/A-01-kanban-board.png` — a stray from the previous iteration. v3-specific evidence = **18** (matches issue 11's own count). |
| 3 | "Changed Files（当前迭代 vs 9917e986）" per-package table (server 73 files/+15712, providers 4/+248, … 80 files/+15286) | ⚠️ MISLABELED BASE | Every row exactly matches `git diff main...HEAD` (full branch incl. iteration #43), NOT the iteration base. Actual iteration scope: **82 files, +15430/−106** (packages only: shared 5, providers 0, engine 2, core-pack 7, server 21, web-app 21; providers has ZERO files in the iteration diff). The "80 files/+15286" summary line is ≈ iteration scope minus the two post-report doc commits (d24b7591, a9fe1206) — so the table and its own summary line disagree. |
| 4 | "11/11 tickets done, zero new failures vs 31-file baseline per stage gate" | ✅ CONSISTENT | All 11 issues status=done with Verification Results; baseline sample 3/3 unrelated to diff; 214/214 feature tests green live now. |
| 5 | "14/14 E2E PASS (retries=0, 24.9s)" | ✅ CORROBORATED (not live re-executed — static mode, no dev server spun up) | Fresh screenshots mtime 22:01, verbatim Playwright output, documented Quick Fix coherent with D19 SSE-only refactor; server suite incl. D19 test re-run green in this audit (tasks-v3-gates 15/15 live). |
| 6 | D6/D19 review fixes landed (9385ba69) | ✅ VERIFIED | routes/clone/index.ts:394 `@@task_context`; tasks-service.ts:649-655 companion emit; output-viewer.tsx zero polling (grep-verified); clone-spec-notice 7/7 + gates D19 test green live. |
| 7 | Sibling spec `task-domain-simple/composite` fails against v3 TemplatePicker — "correct-by-design, separate feature" | ⚠️ REAL CROSS-FEATURE REGRESSION, acknowledged | Honest disclosure, but leaves the repo's E2E suite partially red; tracked as Remaining Issue #2. |
| 8 | "无 DB schema 变更 / 无新依赖" | ✅ VERIFIED | Zero `.sql`/migration files in diff; zero package.json dependency changes. workspaces.source is free-form TEXT (no enum to alter). |

---

## 7. Gap Analysis

### 7.1 Requirements Gaps (asked but not built)
- None material. All 14 stories + 19 decisions have implementation evidence. US8's automation gap is a spec-accepted exclusion (LLM behavior), not an omission.

### 7.2 Testing Gaps (built but not tested)
- **US8** (chat-driven artifact modification) — manual checklist only.
- **D12** — `/tasks/prototype` route ships without tests (throwaway by policy; decide removal).
- **Manual-checklist debt** (documented, unverified): US5 `@@spec_updated` next-turn delivery, US9 agent proactive suggestion bubble, D6 `@@task_context` delivery, real-LLM MoA completion to terminal state.

### 7.3 Authenticity Gaps (tested but superficially)
- None tautological. Structural note: 6 server integration suites sit in the LOW density band (0.07–0.15) due to request boilerplate — assertions are genuine but per-test assertion count is modest (avg 3.5); dispatch suite lowest (22 asserts / 7 tests, 0.072) despite carrying the critical three-path injection claim.

---

## 8. Risk Factors (Top 3)

1. **Change breadth (82 files, 5 packages, risk factor 0.6)** — touches shared executor path (engine task-dispatch.ts), scheduler materialization, and clone-runtime chat signature used by all clones. Mitigated by: tail-appended params (SW-BP15), 31-test clone-runtime regression suite live-green, v2 tasks-routes baseline preserved. → Residual: full-suite baseline (31 failing files) masks drift; run a dedicated baseline-cleanup pass.
2. **Cross-feature E2E regression** — `task-domain-simple.spec.ts` test 1 is red against the v3 TemplatePicker (documented as correct-by-design). An E2E suite left red erodes the anti-fake-run invariant for the next feature. → Update or explicitly retire the sibling spec.
3. **Unverified LLM-behavior surface** — US5 delivery / US8 / US9 bubble / D6 append / real MoA completion rest on manual checklist only; assist E2E seeds aggregator output rather than running an LLM. → Human must execute the manual checklist before production reliance; keep as explicit carryover.

---

## 9. Decision

**REVIEW** — Confidence 78.5/100 (thresholds: GO ≥ 85, REVIEW 70–84, NO-GO < 70)

### Recommendation
The delivery is truthful and structurally sound — every major claim survived independent re-verification (214/214 feature tests live-green, build green, zero fake-test patterns, zero schema/dependency surprises), and the two discrepancies found are reporting-label issues, not implementation fraud. The score sits below GO purely on formula drag from change breadth (risk 0.6) and mid-band assertion density, plus two genuine PARTIAL carryovers. A human should review the three action areas below; if the loop requires ≥85 for convergence, this iteration does NOT yet converge on score alone.

### Required Actions Before Proceeding
1. **Carryover PARTIALs**: resolve US8 (accept manual-checklist evidence with a human-run record, or add mechanism-level assertions) and D12 (remove `/tasks/prototype` route or formally exempt it).
2. **Fix the cross-feature regression**: update `task-domain-simple/composite` specs to the v3 TemplatePicker flow (or retire them) so the E2E suite is not left red.
3. **Execute the manual checklist** (US5 delivery, US9 bubble, D6 @@task_context, real-LLM MoA) and attach evidence.
4. **Correct pipeline-report.md**: Changed-Files table was computed against `main`, not 9917e986 (providers row claims 4 files; actual iteration = 0); screenshot count should read 18 v3-specific (19 includes a stray prior-iteration PNG).
5. Housekeeping: tick ticket-01 AC checkboxes; schedule the 31-file baseline-failure cleanup as a separate task.

---

## AC-Level Status Table (loop-orchestrator extraction)

| AC | Description | Status | Carryover |
|----|-------------|--------|-----------|
| US1 | Template→create→authoring, single draft + binding (D15) | PASS | — |
| US2 | Skill-group multi-select + plugin materialization | PASS | — |
| US3 | Lock after creation (PUT 409 + schema round-trip) | PASS | — |
| US4 | goal/ac SSE emergence | PASS | — |
| US5 | User direct edit → @@spec_updated | PASS | delivery-effect manual item open |
| US6 | Confirm-before-enqueue gate (D18) | PASS | — |
| US7 | Artifact full-content + degraded + SSE refresh | PASS | — |
| US8 | Chat-driven artifact edits | **PARTIAL** | manual-only; needs human checklist evidence |
| US9 | Agent suggest + user-run assist workflows | PASS | suggestion-bubble manual item open |
| US10 | Process logs | PASS | — |
| US11 | MoA adoption (ac+decisions) + parse-error fallback | PASS | — |
| US12 | $vars.task_artifacts_dir injection (3 paths) | PASS | — |
| US13 | Delete reaps home (junction-safe) | PASS | — |
| US14 | Preset = org+projects only | PASS | — |
| D1–D11, D13–D19 | Design decisions incl. D14 3-path, D16 temp workspace, D17 empty marker, D18 gate, D19 SSE no-polling | PASS | — |
| D12 | TaskModal-internal refactor, no new routes | **PARTIAL** | /tasks/prototype route still present; decide removal |

SKIP/FAIL count: 0 FAIL. PARTIAL carryovers: US8, D12. No AC may be treated as converged until the two PARTIALs reach PASS (manual evidence accepted for US8).
