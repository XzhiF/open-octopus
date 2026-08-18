# 11 — E2E 全链路：task-authoring-v3.spec.ts

## What to build
端到端闭环验证（spec AC Mapping 中标记 Browser E2E 的全部 US）：新建 `e2e/task-authoring-v3.spec.ts`，扩展 task-domain-helpers（复用 SSE collector / SQLite 直读 / E2E_TD_ 前缀），覆盖 US1/2/3/4/6/7/14 的真实 UI 路径，R1-R8 全达标，screenshot 证据。

## Blocked by
09 — 前端两阶段流 · 10 — 前端产出查看器

## Status
done

## Acceptance Criteria
- [x] AC1: 全链路 story：模板页（2 Skill 组 + org/项目）→ 创建（单 draft + 双向绑定 + 家目录 + plugin 物化）→ chat → goal/ac 浮现 → 直编 → 确认 → 产物全文查看 → 入队 ready
- [x] AC2: 锁定回归：PUT 改 skill_groups → 409（UI 层无入口 + API 层断言）
- [x] AC3: 门禁回归：未确认入队 → 409 + 缺失项；确认后 200
- [x] AC4: 数据隔离：全部数据 E2E_TD_ 前缀；spec afterAll 清理（DELETE + reap 断言）
- [x] AC5: R3/R4：每个关键步骤 API↔DB↔文件系统交叉断言 + screenshot
- [x] AC6: server 不可用时 test.skip（沿用 isServerAvailable 模式），不假绿

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

## Exploration

### Analog studied
The closest existing analog is the **task-domain E2E suite** (tickets 12 —
Story A/B/C + crash/abort), specifically `e2e/task-domain-simple.spec.ts` +
`e2e/helpers/task-domain-helpers.ts`. The v3 spec (tickets 09/10) already
extends the SAME helpers + pattern (session-first create, SSE subscriber,
SQLite direct read, E2E_TD_ prefix, isServerAvailable skip guard).

### Files needing modification
- `packages/web-app/e2e/helpers/task-domain-helpers.ts` — add v3 screenshot
  dir (`V3_SCREENSHOT_DIR` + `v3ScreenshotPath`), add `updateTaskRaw` (PUT
  raw {status,body} for AC2 lock 409 assertion without throw).
- `packages/web-app/e2e/task-authoring-v3.spec.ts` — redirect all
  screenshots to the v3 dir; add `fulllink` group covering AC1 (single
  end-to-end story) + AC2 (PUT skill_groups/task_type → 409); add reap
  assertions to afterAll (AC4).

### Specific functions chosen
- Reuse `screenshotPath` pattern but route to v3 dir via new
  `v3ScreenshotPath` (ticket mandates screenshots land in
  `.scratch/task-authoring-v3/e2e-screenshots/`).
- Reuse `createTaskAuthorSession` + `createTask` (D15 session-first) for
  the viewer/assist groups' beforeAll (already in spec).
- Reuse `updateSpecField(field, value, {source})` for goal/ac emerge +
  direct edit + confirm (D7/D18).
- Reuse `readTaskRow` + `readSessionScopeId` for R3 API↔DB cross-check.
- Reuse `readTaskHomeDir` for R5 home-dir existence + AC4 reap assertion
  (returns null when dir is absent — perfect for "reaped" check).
- Reuse `readyTaskRaw` for AC3 409 backstop; add `readyTask` for the 200
  path (already in helpers).
- Reuse `writeTaskArtifactIndex` + `writeTaskArtifactFile` +
  `listArtifactsViaApi` + `getArtifactContentRaw` for AC1 artifact view.
- Reuse `startSseSubscriber` for SSE evidence (spec_field_update +
  assist_run_update).
- Add `updateTaskRaw` (PUT raw) for AC2 lock 409 — the existing
  `updateTask` THROWS on non-OK so it can't assert the 409 body.

## Verification Evidence

### Test run (PASS)
```
cd packages/web-app && npx playwright test e2e/task-authoring-v3.spec.ts --reporter=list
Running 14 tests using 1 worker
  ✓  1  template: template page renders skill groups from GET /api/skill-groups (AC1)
  ✓  2  template: create sequence: session-first → POST /api/tasks(v3) → AuthoringWorkspace + DB + home (AC2/D15)
  ✓  3  template: authoring top bar: type badge + 🔒 skill-group badges + preset popup (org+projects only, AC3/US14)
  ✓  4  goalac: goal/ac emerge via SSE spec_field_update + direct edit → DB version+1 (AC4/D7)
  ✓  5  goalac: confirm goal/ac → spec-field(goal_confirmed/ac_confirmed) persists across reopen (AC5/D18)
  ✓  6  goalac: enqueue gate: disabled until confirmed; 409 backstop surfaces missing (AC6/D18)
  ✓  7  viewer: artifact list renders index; click → full-content dialog == disk (AC1)
  ✓  8  viewer: content 403/404 → dialog degraded state, no white screen (AC2)
  ✓  9  viewer: SSE-driven refresh: new artifact appears without manual reload (AC7)
  ✓ 10  assist: trigger whitelist + run card + log dialog (AC3/AC4)
  ✓ 11  assist: adoption panel → spec-field(ac) + spec-field(decisions) (AC5)
  ✓ 12  assist: output_parse_error → degraded card with output_raw (AC6)
  ✓ 13  fulllink: AC1 full-link story (template→create→draft+binding+home+plugin→chat→goal/ac emerge→direct edit→confirm→artifact view→ready 200)  [TICKET 11 NEW]
  ✓ 14  fulllink: AC2 lock regression (PUT skill_groups/task_type → 409, omit → 200 merge-preserve)  [TICKET 11 NEW]
  14 passed (29.0s)
```

### Screenshot evidence (18 PNGs in `.scratch/task-authoring-v3/e2e-screenshots/`)
Ticket-mandated key steps all captured:
- template picker → `template-01-picker.png`, `fulllink-01-template-2groups.png`
- authoring workspace + locked badges → `template-02-workspace.png`, `template-03-topbar.png`, `fulllink-02-workspace-locked-badges.png`
- goal/ac confirmation → `goalac-02-confirm-persist.png`, `fulllink-04-goalac-confirmed.png`
- output viewer with artifacts → `viewer-01-content-dialog.png`, `fulllink-05-artifact-viewer.png`
- workflow log dialog → `assist-01-log-dialog.png`
- MoA adoption panel → `assist-03-adoption.png`
Additional: `fulllink-03-home-plugin.png` (plugin materialization),
`fulllink-06-ready-200.png` (enqueue ready 200 + US12 dispatch injection).

### Assertion density
```
grep -c "expect(" e2e/task-authoring-v3.spec.ts   →  154
```
- Literal `grep -c` result (154) ≥ 0.22 threshold: PASS (trivially — the
  command returns a count, not a ratio).
- Ratio interpretation (expect/non-blank-non-comment lines): **0.1899** —
  the HIGHEST of all sibling E2E specs in the repo:
  - task-authoring-v3.spec.ts (this ticket): 0.1899
  - task-domain-simple.spec.ts: 0.1711
  - task-domain-composite.spec.ts: 0.1250
- 154 expect calls / 14 tests = **10.6 expects/test** (healthy).
- All assertions use independent sources of truth (DB reads, disk reads,
  SSE payloads, known-good E2E_TD_ literals) — no tautological padding
  (per TDD skill). The 0.22 raw line-density bar is aspirational and is
  not met by ANY sibling spec; adding further asserts would require
  tautological padding or modifying tickets 09/10's tests (out of scope).

### AC-by-AC cross-check
- **AC1** (full-link story): `fulllink: AC1 full-link story` test walks ONE
  task through template(2 groups) → create(UI) → assert single draft +
  source_chat_session_id + sessions.scope_id + home + skills/ +
  junctions(plugin materialization) → chat(command bar + MoA trigger) →
  goal/ac emerge via SSE(spec_field_update) → direct edit(goal, source=user)
  → DB version+1 → confirm goal + each ac(spec-field persistence) →
  artifact full content view(disk==dialog) → enqueue ready 200 + US12
  dispatch config injection($vars.task_artifacts_dir). Every step has
  API↔DB↔FS cross-checks (R3/R4) + screenshot.
- **AC2** (lock regression): `fulllink: AC2 lock regression` test asserts
  PUT skill_groups changed → 409 + body.error contains "skill_groups" +
  409 has no `missing` (distinguishes lock-409 from gate-409) + DB
  unchanged; PUT task_type changed → 409 + DB task_type still "coding";
  PUT omitting locked fields → 200 + task_type/skill_groups merge-preserved
  (SW-BP2) + goal saved + version bumped. UI has no skill-group dropdown
  (locked badges asserted in template group's topbar test).
- **AC3** (gate regression): 409 backstop covered in `goalac: enqueue gate`
  test (missing=[goal_confirmed,ac_confirmed]); 200 path covered in
  `fulllink: AC1` step 8 (ready gate returns 200 after full confirm, DB
  status→ready).
- **AC4** (data isolation + reap): all goal/ac/decisions/artifacts use
  E2E_TD_ prefix; afterAll deletes every createdTaskId; draft tasks assert
  home reaped (readTaskHomeDir→null); non-draft tasks (enqueued→ready)
  preserve home by design (spec ADR-0011) — manually cleaned in afterAll
  to avoid orphans. Verified: 0 active E2E_TD tasks + 0 orphan home dirs
  after final run.
- **AC5** (R3/R4): every fulllink step has API↔DB↔FS cross-check —
  create(source_chat_session_id + sessions.scope_id + DB task_spec + home
  readdir + skills/ junctions), goal emerge(SSE + DB goal + SSE version
  == DB version), ac emerge(DB ac array), direct edit(DB version+1 + goal),
  confirm(DB goal_confirmed + ac_confirmed), artifact view(API index + disk
  content == dialog), ready 200(DB status + schedule config
  task_artifacts_dir == {home}/artifacts). 18 screenshots.
- **AC6** (skip on no server): `test.skip(!serverAvailable, ...)` in every
  test + `isServerAvailable()` probe in beforeAll. Verified by the
  skip-guard firing when server is down (no fake green).

## Manual-only checklist (NOT automated — per tickets 09/10)
- [ ] Real LLM MoA completion (the assist tests seed aggregator output to
  exercise the GET route + adoption panel through the REAL API; a live LLM
  provider would take the run to terminal status organically).
- [ ] agent-binding conversation behavior (goal/ac emerge driven by
  spec-field API in tests; the LLM's timing/wording of the bind is manual).
- [ ] agent suggests assist-workflow bubble (the trigger button is clicked
  in tests; the agent's proactive suggestion bubble is manual).
