# Verification Report: task-authoring-v3-r2 (Round 2 gap-fix)

Generated: 2026-08-19 00:05 (local)
Commit: 2e5e08fb (HEAD)
Branch: feat/task-domain-redesign
Mode: static (targeted live re-runs: 4 feature vitest suites + full `pnpm build`; Playwright E2E accepted as documented execution evidence per audit charter, cross-checked via screenshot mtimes)
Artifacts: .scratch/task-authoring-v3/ (R1) + .scratch/task-authoring-v3-r2/ (R2)
Diff base (whole feature): `9917e986...HEAD` — live: **95 files, +13319/−118** (R1 scope 94/+13250/−118 + r2 report artifacts, see §6-G3)

---

## Executive Summary

| Metric | Value |
|--------|-------|
| **Confidence Score** | **80.6/100** (R1: 78.5) |
| **Decision** | **REVIEW** |
| Requirements Traced | 33/33 (100%) — both R1 PARTIALs cleared (D12 fully; US8 as PASS-pending-manual-evidence per loop convention) |
| Test Authenticity | 81.5/100 |
| Quality Gates | 6/6 passed |
| Top Risk | Change breadth (95 files, risk factor 0.6) caps the score; US8 human-run checklist evidence still pending |

Independent audit highlights (R2 gap claims re-derived from evidence, not copied):
- **G1/D12 VERIFIED**: `app/tasks/prototype/` deleted; zero code references (only provenance comments); full build exit 0; route unroutable by filesystem structure.
- **G2 VERIFIED**: sibling simple spec migrated (45 expects / 7 tests identical before vs after — zero coverage loss); composite untouched; execution evidence coherent (7 fresh PNGs 23:42–23:46 + `.last-run.json` passed).
- **G3 VERIFIED**: Changed-Files table exact vs git at pinned commit b430f89a; per-package numbers exact vs live HEAD; residual +1 file/+69 lines is the report's own commit (self-referential lag, documented).
- **G4 VERIFIED**: MANUAL-CHECKLIST M1–M5 structurally complete; persona mechanism tests green live; US8 residual = BLOCKED-pending-human (loop convention: index.md entry 42 precedent).
- **G5 VERIFIED**: 42 expects ≥ 32 target; zero tautologies; 3 spot-checked assertions non-tautological with independent truth sources.
- **Live runs this audit**: vitest 4 suites **38/38 PASS** (1.67s); `pnpm build` **exit 0**.

---

## 1. Requirements Traceability Matrix

Atoms: 14 user stories (US1–US14) + 19 decisions (D1–D19). R1 statuses carried only where re-confirmed; ✱ = freshly re-verified this audit (6 spot checks + both carryovers).

| REQ-ID | Requirement | Code Ref | Test Ref | Status |
|--------|-------------|----------|----------|--------|
| US1 | 模板页选择→创建→编写（单 draft + 会话绑定） | ✅ tasks-service createTask v3 path · routes/tasks.ts · template-picker.tsx | ✅ tasks-v3-routes AC2/AC3 · e2e test 2,13 · regression re-run evidence (18 PNGs 23:41) | COVERED |
| US2 | Skill 组多选整合 | ✅ plugin-materializer.materializeGroups | ✅ plugin-materializer.test.ts · tasks-v3-routes AC2 · e2e test 13 | COVERED |
| US3 | 创建后锁定（PUT 409 + schema 往返） | ✅ tasks-service updateTask lock | ✅ tasks-v3-routes AC4 · task-schema-v3 · e2e test 3,14 | COVERED |
| US4 | goal/ac SSE 浮现 | ✅ tasks-service SPEC_FIELD_UPDATE_EVENT emit | ✅ goal-ac-card.test.tsx · e2e test 4,13 | COVERED |
| US5 | 用户直编 → @@spec_updated | ✅ tasks-service `source==="user"` → setSpecNotice | ✅ tasks-v3-gates AC1 (green live) · clone-spec-notice (7/7 live) | COVERED（下轮投递效果 = M1 manual） |
| US6 | 确认后方可入队（409+缺失项） | ✱ tasks-service.ts:109 `TaskReadyGateError` + goal_confirmed/ac_confirmed validation (grep-verified fresh) | ✅ tasks-v3-gates 15/15 live | COVERED |
| US7 | 产物完整内容查看 + 降级 | ✱ task-home-service `ArtifactAccessError` FORBIDDEN/NOT_FOUND (:43-49, grep-verified fresh) | ✅ tasks-v3-artifacts · task-home-service tests · e2e test 7-9 | COVERED |
| US8 | 对话改产物 | ✅ builtin-clones persona + @@task_context mechanism | ✅ **NEW** persona-v3-instructions.test.ts (4/4 live) + clone-spec-notice D6 suite (mechanism complete); M2 checklist item for LLM behavior | **COVERED — PASS-pending-manual-evidence** (see §7.1) |
| US9 | agent 建议 + 用户执行辅助工作流 | ✅ assist-workflow-service trigger + 白名单 | ✅ tasks-v3-assist AC2/AC3 · e2e test 10 | COVERED（建议气泡 = M3 manual） |
| US10 | 过程日志 | ✅ assist-workflow-service getRun logs | ✅ tasks-v3-assist AC4 · e2e test 10 | COVERED |
| US11 | MoA 勾选采纳 + 解析兜底 | ✅ moa-adoption-panel · validateSpecFieldValue decisions | ✅ tasks-v3-assist AC5 · e2e test 11,12 | COVERED |
| US12 | dispatch 注入 $vars.task_artifacts_dir（三路径） | ✱ scheduler-service.ts:213-214 · workflow-executor.ts:612-616 · engine task-dispatch.ts:89-95,210-232 (grep-verified fresh) | ✅ tasks-v3-dispatch 12/12 live (42 expects) · e2e test 13 | COVERED |
| US13 | 删除 reap 家目录（不跟随 junction） | ✱ task-home-service reapHome lstat pre-scan (:239-278, grep-verified fresh) | ✅ task-home-service SW-BP14 · tasks-v3-routes AC5 · e2e afterAll | COVERED |
| US14 | 预设仅 org+projects | ✅ authoring-workspace preset popup | ✅ authoring-workspace.test.tsx · e2e test 3 | COVERED |
| D1 | Per-task plugin 目录 | ✅ clone-runtime getPlugins(taskHomePath?) | ✅ clone-runtime.test.ts · plugin-materializer | COVERED |
| D2 | 创建时锁定 | 同 US3 | 同 US3 | COVERED |
| D3 | registry group 聚合 | ✅ routes/skill-groups.ts | ✅ skill-groups-api.test.ts · e2e test 1 | COVERED |
| D4 | skill_groups 不写 authoring_resources | ✅ tasks-service createTask | ✅ tasks-v3-routes AC6 | COVERED |
| D5 | 家目录 + artifacts.json | ✅ task-home-service | ✅ task-home-service.test.ts | COVERED |
| D6 | @@task_context append | ✅ routes/clone/index.ts + clone-runtime 9th param | ✅ clone-spec-notice D6 三例 (green live) · M4 manual | COVERED |
| D7 | 双通道编辑 | 同 US5 | 同 US5 | COVERED |
| D8 | ghost 占位 → SSE 浮现 | ✅ goal-ac-card ghost state | ✅ goal-ac-card.test.tsx · e2e test 4 | COVERED |
| D9 | 内置 3 模板 + 白名单 | ✅ core-pack YAML ×3 | ✅ assist-workflows-simulator · tasks-v3-assist | COVERED |
| D10 | 三段式采纳 | ✅ assistWorkflowOutputSchema | ✅ e2e test 11 · tasks-v3-assist | COVERED |
| D11 | 无审批按钮 | ✅ artifact-viewer-dialog footer | ✅ e2e test 7 | COVERED |
| D12 | TaskModal 内部重构，不加新路由 | ✱ task-modal refactor ✅ + **prototype dir DELETED** (verified: dir gone, `app/tasks/` = page.tsx only, zero code refs — 7 provenance attribution comments + 7 "interaction reference" header comments only) | ✱ build route table (exit 0) + E2E 404 evidence (r2 pipeline-report G1) + v3 E2E regression 14/14 | **COVERED (was PARTIAL)** |
| D13 | 预设瘦身 | 同 US14 | 同 US14 | COVERED |
| D14 | server 侧物化注入三路径 | ✱ 同 US12 (fresh grep) | 同 US12 | COVERED |
| D15 | 会话先行创建顺序 | ✅ tasks-v3-routes SG3 · persona example | ✅ tasks-v3-routes AC3 · **persona-v3-instructions D15 test (live)** · e2e test 2,13 | COVERED |
| D16 | 辅助工作流临时 workspace | ✅ assist-workflow-service source:"task-assist" | ✅ tasks-v3-assist AC2/AC6 | COVERED |
| D17 | default 组空标记不物化 | ✱ plugin-materializer DEFAULT_SKILL_GROUP skip (:41,:79, grep-verified fresh) | ✅ plugin-materializer AC3 · e2e test 1 | COVERED |
| D18 | 确认持久化 + ready 门禁 | 同 US6 | 同 US6 | COVERED |
| D19 | SSE 刷新通道（无轮询） | ✱ tasks-service.ts:655 TASK_ARTIFACTS_UPDATE_EVENT emit (fresh grep) · output-viewer.tsx zero setInterval/setTimeout (fresh grep = 0) | ✅ tasks-v3-gates D19 (green live; SSE emit lines visible in live run log) · e2e test 4 | COVERED |

**Coverage**: 33/33 (100%) — EXCELLENT (R1: 30/33, 90.9%)

### Carryover Clearance (loop-extraction critical)
- **D12 PARTIAL → PASS**: removal verified from filesystem + git (`D packages/web-app/app/tasks/prototype/page.tsx` in r2 diff), zero routable path, zero code refs, build green. No exemption needed.
- **US8 PARTIAL → PASS-with-manual-evidence-pending**: clearance rule applied — checklist complete (M1–M5 with 前置条件/步骤/期望/证据栏, status header BLOCKED-pending-human) AND mechanism layer complete (persona contract 4/4 live + @@task_context D6 3/3 live + assist/notice suites). LLM-conversation residual declared BLOCKED-pending-human as explicit exception. Precedent: `.scratch/index.md` entry 42 (task-pool-redesign converged GO with "US3 env-blocked" carried as explicit exception).

### Unimplemented Requirements
- None. (US8's conversation-behavior residual is a spec-declared R2-strategy exclusion with human-run prerequisite, not an omission.)

### Orphan Tests
- None. persona-v3-instructions.test.ts maps to US5/US8/D15 mechanism side; new dispatch tests map to US12/D14/AC4-compat; simple-spec changes preserve existing test→requirement links.

---

## 2. Test Authenticity Audit

Scope note: full-feature numbers = R1 portfolio updated for the 3 files changed since R1 (`tasks-v3-dispatch.test.ts` modified, `persona-v3-instructions.test.ts` new, `task-domain-simple.spec.ts` migrated — assertion count unchanged there).

### 2.1 Assertion Analysis

| File | Lines | Assertions | Density | Rating | Δ since R1 |
|------|-------|-----------|---------|--------|-----------|
| server/tasks-v3-dispatch.test.ts | 647 | 42 | 0.065 (0.091 eff.) | LOW ⚠️ by line metric; 3.5 asserts/test | **+20 asserts, +5 tests** (G5) |
| server/persona-v3-instructions.test.ts | 92 | 10 | 0.109 (0.37 eff.) | HIGH (effective lines; comment-heavy by design) | **NEW** (G4) |
| web/e2e/task-domain-simple.spec.ts | 462 | 45 | 0.097 | LOW-ish (legacy E2E boilerplate) | migrated entry only; **45→45 expects, 7→7 tests — zero coverage loss** |
| other 14 R1 suites | (unchanged) | 669 | (R1 table) | (R1 ratings) | unchanged (git-verified: gates/clone-spec-notice diff empty) |

**Overall (feature, 18 files)**: 766 assertions / 5,139 LOC = **0.149 (MEDIUM-low)** → sub-score min(0.149/0.30) = **0.497** (R1: 0.523 — density dipped because the strengthened dispatch tests are integration-heavy; count and quality rose).

### 2.2 Issues Detected (changed files scanned fresh)

| Type | File | Line | Detail |
|------|------|------|--------|
| (none) | — | — | EMPTY_TEST: 0 in changed files |
| (none) | — | — | TAUTOLOGICAL: 0 × expect(true)/toBeTruthy; 1 × `toBeDefined` (persona:62) — guard immediately followed by `toContain("decisions")` on the same value → guard+value pattern, NOT tautological |
| (none) | — | — | dispatch suite self-audit honored: 2 redundant typeof checks were removed by the author (logically implied by Object.is-strict `toBe(42)`) — anti-padding discipline observed |
| MYSTERY_GUEST | e2e suites (carried) | — | live server dependency; skip-guarded, documented |

### 2.3 Negative Test Coverage

- Total tests: 180 (R1 171 + dispatch 5 + persona 4)
- Negative/boundary/edge: 53 (R1 49 + key-set-absence, exact-key-set-leak, type-preservation, v2-seam-absence)
- **Negative ratio: 29.4% (ACCEPTABLE, top of band)** — sub-score 0.98 (R1: 0.96)
- New negative dimensions: legacy key ABSENCE via `Object.keys(...).toEqual([])` (stronger than toBeUndefined), composite exact key-set (catches drop AND leak), number/boolean type preservation through input_mapping, injected-seam baseDir proof.

### 2.4 Test Smells

| Smell | Count | Severity |
|-------|-------|----------|
| Empty Test | 0 | — |
| Tautological | 0 | — |
| Sleepy Test | 0 (grep waitForTimeout/setTimeout in migrated spec = 0; GS2 AC3 honored) | — |
| Assertion Roulette (fulllink E2E, carried) | 1 | LOW |
| Mystery Guest (live-server E2E, carried) | 1 | LOW |

**Authenticity score**: (0.497×0.30 + 1.0×0.15 + 1.0×0.20 + 0.98×0.20 + 0.8×0.15) × 100 = **81.5/100** (R1: 82)

---

## 3. E2E Script Audit

`e2e-scripts/` and `e2e-data/` for r2 are empty (real surface = Playwright specs, same as R1).

| Suite | Real Requests | Body Checks | Cross-Validates | Error Tests | Rating |
|-------|:---:|:---:|:---:|:---:|--------|
| task-authoring-v3.spec.ts (14, regression) | ✅ browser + server :3001 | ✅ DB/FS/SSE | ✅ API↔DB↔FS↔SSE↔UI | ✅ 403/404/400/409 | AUTHENTIC |
| task-domain-simple.spec.ts (7, migrated) | ✅ | ✅ readTaskRow DB + SSE | ✅ API↔DB↔SSE↔UI | ✅ abort/409-cleanup paths added | AUTHENTIC |
| task-domain-composite.spec.ts (6, unchanged) | ✅ API-driven | ✅ DB | ✅ | ✅ tolerance pattern | AUTHENTIC (git-verified zero diff) |

**Execution-evidence cross-check (audit charter: accept documented Playwright results, verify mtimes):**
- v3 regression 14/14 claim: **18/18 v3 PNGs regenerated 23:41:19–23:41:42** (R1 screenshots dir) — fresh, sequential, matches a single real run. ✅
- Sibling run "11 passed + 2 provider-gated skips, 4.7m, retries=0": r2 screenshots dir holds 7 PNGs **23:42:16–23:46:49** (span ≈ run duration) + `test-results/.last-run.json = {"status":"passed","failedTests":[]}`; A-07-modal-result-aborted.png (23:46:49) corroborates the abort-then-modal flow added in test 6/7. ✅
- The 2 skips are provider-gated (no LLM → workflow hangs in `running`), hard contract (dispatch→running→task_status SSE) asserted BEFORE the conditional skip, mirroring composite's pre-existing tolerance pattern; consistent with loop convention for env-blocked items.
- Minor report blemish (non-material): r2 pipeline-report says "test 9 容忍模式" — the tolerant test is simple **test 6** (no 9th test exists in either spec). Numbering slip only; substance verified.

---

## 4. Quality Gate Results

| Gate | Criteria | Threshold | Actual | Result |
|------|----------|-----------|--------|--------|
| Spec Completeness | ACs have verification methods | 100% | 100% (R1 spec US table + r2 GS1–GS5 AC Mapping) | **PASS** |
| Code Completeness | Requirements with code refs | ≥ 90% | 33/33 = 100% | **PASS** |
| Test Completeness | Requirements with test refs | ≥ 80% | 33/33 = 100% (US8 now has mechanism-layer tests + checklist; D12 covered by build/404/E2E) | **PASS** (R1: 93.9%) |
| Test Authenticity | Composite score | ≥ 70 | 81.5 | **PASS** |
| Build Health | Compilation | 0 errors | `pnpm build` re-run LIVE this audit → exit 0 (all packages) | **PASS** |
| Ticket Resolution | Issues done | ≥ 80% | 16/16 = 100% (R1 11/11 + r2 5/5; ticket-01 checkboxes now all [x], material-verified by r2-03) | **PASS** |

Baseline handling: 31 pre-existing failing files (known-baseline-failures.txt) excluded — separate cleanup task, out of loop scope. Provider-gated E2E skips treated as env-blocked exceptions per index.md entry 42 convention.

---

## 5. Confidence Score Breakdown

| Dimension | Weight | Score | Weighted |
|-----------|--------|-------|----------|
| Traceability | 25% | 1.00 (33/33; both carryovers cleared per §1 rules) | 0.2500 |
| Test Pass Rate | 25% | 1.00 (38/38 live vitest this audit; build exit 0; E2E 14/14 + 11/11 non-skipped accepted with mtime-verified fresh evidence; 2 skips = env-blocked exceptions) | 0.2500 |
| Assertion Density | 20% | 0.497 (0.149/0.30) | 0.0994 |
| Negative Tests | 15% | 0.98 (29.4%/30%) | 0.1470 |
| Change Risk | 15% | 0.40 (risk factor 0.6: 95 files > 80 → 0.6; +0.0 sensitive areas; +0.0 new deps — grep-verified zero package.json/lock in diff; +0.0 migrations — zero .sql/migration files) | 0.0600 |
| **Total** | **100%** | | **80.6/100** |

Δ vs R1: +2.1 (traceability 0.909→1.00 +2.3; negative 0.957→0.98 +0.4; density 0.523→0.497 −0.5).

---

## 6. Static Cross-Reference: R2 Gap Claims vs Evidence

| Gap | Claim | Verdict | Evidence (independently gathered) |
|-----|-------|---------|-----------------------------------|
| G1 | prototype deleted → D12 PASS | ✅ VERIFIED | dir absent (`ls` → No such file); `app/tasks/` contains only page.tsx; grep `tasks/prototype\|prototype/page` in packages/**/*.{ts,tsx} → only 7 attribution comments ("code rewritten, not copied") + 7 "interaction reference" header comments; zero imports/links/router.push; full `pnpm build` exit 0; binary hits confined to `.next` dev cache (artifacts, not code) |
| G2 | sibling specs migrated, green | ✅ VERIFIED | simple diff: entry `[data-task-spec-panel]`→`[data-template-picker]` (intent comment), test 6 terminal branch made conditional with hard contract first + abort + documented skip, afterAll abort-before-delete fix; counts identical 7 tests/45 expects before vs after; composite zero diff; no waitForTimeout/setTimeout; execution evidence coherent (mtimes + last-run.json, §3) |
| G3 | report reconciled to git truth | ✅ VERIFIED (self-referential footnote) | table pinned @b430f89a: live `git diff --shortstat 9917e986...b430f89a` = **94 files, +13250/−118 — exact match**; per-package rows exact vs live HEAD (shared 5/+380/−6, providers 0, engine 2/+159/−2, core-pack 7/+199, server 22/+5091/−66, web-app 21/+4358/−44); live HEAD 95/+13319 = pinned + r2 pipeline-report.md/index/pr-body commits (the report cannot include itself); footnote documents 口径演变 + verify command; ticket-01 boxes [x]×4; stray PNG moved to task-domain-redesign (27414 bytes, verified) |
| G4 | US8 convergence path | ✅ VERIFIED | MANUAL-CHECKLIST.md: M1–M5 each with 前置条件/操作步骤/期望观察/证据栏; header STATUS: BLOCKED-pending-human; convergence rule stated; persona-v3-instructions 4/4 green live; mechanism-ownership boundary documented in test header (artifact guidance lives in @@task_context D6 suite — clone-spec-notice green live, unchanged since R1) |
| G5 | dispatch ≥32 asserts, no tautology | ✅ VERIFIED | `grep -c "expect("` = **42** (22→42); 12 tests all green live; scan: 0 expect(true), 0 toBeDefined-only, 0 status-only; spot-check 3 assertions non-tautological: (a) `Object.keys(iv)).toEqual(["task_artifacts_dir"])` exact key-set (:132), (b) `toBe(42)` Object.is type-strict numeric preservation (:532), (c) injected-seam `path.join(tempBase,"tasks",id,"artifacts")` equality (:610-612) — each has an independent truth source and a concrete regression it catches |
| R1-carry | 214/214 feature unit tests | not re-run in full (charter limited live runs to 4 suites) | 4 suites incl. all r2-changed files: 38/38 green; gates + clone-spec-notice byte-identical to R1-audited versions (git diff empty) |

---

## 7. Gap Analysis

### 7.1 Requirements Gaps (asked but not built)
- None. All 33 atoms have code evidence; both R1 PARTIALs resolved per clearance rules.
- **Explicit exception (carried)**: US8/US5/M3/M4/M5 LLM-conversation behaviors — BLOCKED-pending-human; MANUAL-CHECKLIST is the execution vehicle; US8 is PASS-with-manual-evidence-pending, NOT fully closed until M1–M5 evidence columns are back-filled by a human with a real provider.

### 7.2 Testing Gaps (built but not tested)
- None blocking. Prototype route has no tests — correct: it is deleted (R6 throwaway policy satisfied).

### 7.3 Authenticity Gaps (tested but superficially)
- None tautological. Structural note persists: server integration suites sit LOW on line-density due to Hono/DB request boilerplate (dispatch 0.065 raw). The G5 strengthening raised count (22→42) and quality (key-set/type/seam dimensions) but line density cannot rise without boilerplate engineering — see §9 ceiling math.

---

## 8. Risk Factors (Top 3)

1. **Change breadth (95 files, risk factor 0.6, weighted 0.06/0.15)** — irreducible for a shipped multi-package feature; it is the dominant score suppressor and is formulaic, not evidentiary. Mitigation: none available inside this branch; formula note in §9.
2. **US8 human-run evidence pending** — until M1–M5 are executed against a real LLM provider, the conversation layer (artifact edits via chat, suggestion bubbles, @@task_context behavioral effect, real MoA terminal run) rests on mechanism tests only. Impact: medium, contained by checklist structure. Mitigation: human runs checklist, back-fills evidence, flips status to done.
3. **31 env-drift baseline failures + 15 provider-gated hung executions** — mask future drift and normalize skip-gates. Impact: low for this feature, medium for the next. Mitigation: separate baseline-cleanup task (already declared out of loop scope).

**GO-ceiling math (required disclosure):** with change_risk pinned at 0.40 (95 files), the formula's maximum with everything else perfect is 0.25+0.25+0.20+0.15+0.06 = **91**. GO (≥85) additionally requires density sub-score ≥ 0.70 → overall density ≥ 0.21. Current 0.149 → reaching 0.21 needs ≈ +1,044 assertions at 0.30-density (≈3,480 new test lines) — i.e., exactly the assertion padding GS5 forbade — or ≈ −1,491 lines of boilerplate with zero assertion loss. **GO is structurally unreachable for a 95-file feature without padding.** At this density profile, GO would require ≤30 changed files (risk 0.8): 0.25+0.25+0.0994+0.147+0.12 = 86.6. The score gap to GO is formula drag, not an evidence gap.

---

## 9. Decision

**REVIEW** — Confidence 80.6/100 (R1: 78.5; GO ≥ 85, REVIEW 70–84, NO-GO < 70)

### Recommendation
Both R1 PARTIAL carryovers are cleared on evidence: D12 fully (prototype removed, zero refs, build green), US8 via the loop's convergence convention (mechanism layer + checklist complete; LLM residual declared BLOCKED-pending-human, same treatment as index.md entry 42's "US3 env-blocked" GO). Every R2 claim survived independent re-derivation; the only discrepancies found are cosmetic (report "test 9" numbering slip; self-referential +1-file diff lag). Per §8, GO ≥85 is unreachable on this branch without assertion padding, so the loop should converge on **REVIEW-with-zero-open-ACs** rather than iterate a Round 3 for score alone.

### Required Actions Before Proceeding
1. **Human**: execute MANUAL-CHECKLIST M1–M5 against a real LLM provider; back-fill evidence columns; flip US8 to fully PASS (no code work required).
2. **Loop orchestrator**: record explicit exceptions — US8 manual-evidence-pending; 31 baseline failures + provider-gated skips as env-blocked (entry-42 convention). A hypothetical Round 3 has **no code gaps to fix** and is not recommended.
3. **Separate task** (non-blocking): baseline-failure cleanup; fix r2 pipeline-report "test 9" → "test 6" numbering if the report is touched again.

---

## AC-Level Status Table (loop-orchestrator extraction)

| AC | Description | Status | Carryover |
|----|-------------|--------|-----------|
| US1 | Template→create→authoring, single draft + binding (D15) | PASS | — |
| US2 | Skill-group multi-select + plugin materialization | PASS | — |
| US3 | Lock after creation (PUT 409 + schema round-trip) | PASS | — |
| US4 | goal/ac SSE emergence | PASS | — |
| US5 | User direct edit → @@spec_updated | PASS | delivery-effect = M1 manual (BLOCKED-pending-human) |
| US6 | Confirm-before-enqueue gate (D18) | PASS | — |
| US7 | Artifact full-content + degraded + SSE refresh | PASS | — |
| US8 | Chat-driven artifact edits | **PASS (manual-evidence-pending)** | checklist M2 + real-provider evidence to be back-filled by human; mechanism layer complete |
| US9 | Agent suggest + user-run assist workflows | PASS | suggestion-bubble = M3 manual |
| US10 | Process logs | PASS | — |
| US11 | MoA adoption (ac+decisions) + parse-error fallback | PASS | real-LLM run = M5 manual |
| US12 | $vars.task_artifacts_dir injection (3 paths) | PASS | strengthened 22→42 asserts, verified |
| US13 | Delete reaps home (junction-safe) | PASS | — |
| US14 | Preset = org+projects only | PASS | — |
| D1–D11, D13–D19 | Design decisions incl. D14 3-path, D16 temp workspace, D17 empty marker, D18 gate, D19 SSE no-polling | PASS | — |
| D12 | TaskModal-internal refactor, no new routes | **PASS (was PARTIAL)** | prototype route deleted; zero refs; build green |

SKIP/FAIL count: 0 FAIL, 0 SKIP. PARTIAL carryovers: **0** (US8 cleared as PASS-with-manual-evidence-pending per clearance rule; D12 cleared fully). Explicit exceptions carried out of the loop: US8/M1–M5 human-run evidence (BLOCKED-pending-human), 31 env-drift baseline failures, provider-gated E2E skips.
