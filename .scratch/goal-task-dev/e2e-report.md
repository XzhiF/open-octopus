# goal-task-dev — Independent E2E Verification Report

- **Date**: 2026-08-29 (runs 01:42–02:15 local)
- **Branch**: `feat/task-workflow-presets` @ `3d32c788` (goal-task-dev commits `c59fa374..3d32c788`, stacked on task-workflow-presets)
- **Executor**: matt-e2e-tester (independent of dev-runner)
- **Environment (live, never restarted)**: server :3001 (`node packages/server/dist/index.js`, fresh build of this branch) · web :3000 · DB `~/.octopus/db/octopus.db` · claude CLI 2.1.250
- **Artifacts**: scripts `e2e-scripts/` · logs+data `e2e-data/` · screenshots `e2e-screenshots/` (under `/Users/xzf/Projects/ai/XzhiF/open-octopus/.scratch/goal-task-dev/`)

## Verdict

**OVERALL: PASS on the feature (AC1–AC9 all green, multi-layer cross-validated).**
One full-chain sub-assertion FAILS due to a **pre-existing platform scheduler bug** (unrelated to this feature's diff, reproduced on main-era data): task/schedule status mirrors `failed` while the execution itself completes `completed`. Root cause + recommended patch below (Step 4c — stop and report; restart-based fix was forbidden by task constraints).

| AC | Acceptance condition (spec.md) | Verdict | Script | Layers verified |
|----|-------------------------------|---------|--------|-----------------|
| AC1 | goal 节点装配 `/goal` 首行 + 全量注入(无截断) | **PASS** | T1 | units (prompt assembly, >200-char passthrough) |
| AC2 | claude 真跑收敛: node completed + 文件存在 + JSONL active_goal | **PASS** | T5(A) + T6 | real process + files + JSONL + DB |
| AC3 | 不收敛响: max_turns:3 → failed + goal_not_met + iterations 证据; runner 终态映射不 throw | **PASS** | T5(B) + T1 | real process + JSONL subtype chain + units |
| AC4 | max_turns/max_budget_usd/tools/disallowed_tools → sdkOptions; `$inputs.max_turns` string→number | **PASS** | T1 | units (14/14 plumbing) |
| AC5 | planning 废弃迁移错误(含 loop 嵌套递归扫描); engine≠claude + budget → validate 警告不拒收 | **PASS** | T1 + T2 | units + CLI process exit/stdout |
| AC6 | presets general-dev=task-dev; bind→ready→materialize input_values(goal/ac 解析, max_turns 缺省); PUT 覆盖生效 | **PASS** | T3 + T4 + T6 | API ↔ DB ↔ file ↔ UI/screenshots |
| AC7 | simulator: task-dev 两场景 pass(耗尽场景 goal_not_met(max_turns)); superpowers cr-fix goal 化 validate+sim | **PASS** | T2 | CLI process + stdout assertions |
| AC8 | schema 清理: scoped grep=0 · orphan json 删 · sync-builtin schema 分支/残留 log 移除且跑 sync 不报错 · setup-runner 分支移除 | **PASS** | T7 | static files + script run (exit 0) |
| AC9 | preset v2 迁移单元 + live catalog 刷新为 task-dev | **PASS** | T1 + T3 | units (12/12) + live file ↔ API cross |
| T7-05 full chain | 看板→绑定→入队→真跑→develop(/goal)→ship(本地降级) 全链 | **PARTIAL** | T6 23/24 | 见下 — 唯一 FAIL 为预存在调度器状态回写 bug |

## Execution Details

| Script | Scope | Result | Evidence |
|--------|-------|--------|----------|
| T1-units.sh | 5 targeted vitest suites (shared/providers/engine/server/web-app) | **83/83, all exit 0** | `e2e-data/T1-units.log` |
| T2-cli.sh | CLI validate/simulate via `node packages/cli/dist/index.js` (global octopus stale) | **14 PASS**, planning rejected w/ 迁移文案 (top-level + loop-nested), pi warning passes, task-dev & superpowers `simulate` = "2 passed, 0 failed" incl. `goal_not_met (max_turns)`, real yamls validate 0-exit | `e2e-data/T2-cli.log`, fixtures `e2e-data/fix-*.yaml`. xzf-dev validate fail = pre-existing swarm `host.prompt` error (ticket-04 documented) → INFO only |
| T3-api.mjs | handoff (1)(2)(3)(8): presets+filter, workflow detail, gate 409→200, schedule queued/origin=task/no-cron, DB config materialization (goal/ac verbatim, no `max_turns` key, variant `"5"`), artifacts dir injection, abort pre-tick, zero-executions safety, hard cleanup | **30/30 ALL PASS** (re-run 02:12) | `e2e-data/T3-api.log` |
| T4-browser.mjs | handoff (4) / fix F + fix N, screenshots REQUIRED | **18/18 ALL PASS** (re-run 02:14). fix F: `max_turns` input shows `"200"`; fix N: manual switch (preset→xzf-dev→task-dev) clears goal/ac to placeholder-only, untouched default persists; badge `built-in/task-dev` + DB row match; zero fatal console errors | `e2e-data/T4-browser.log`; screenshots 01/02/03 (visually verified) |
| T5 goal-realrun-probe.mjs | handoff (6): re-run real-CLI converge/not-converge probe | **ALL PASS, exit 0** — incl. B4/B5: `error_max_turns` → `terminalReason:'max_turns'` + numTurns evidence + active_goal chain in JSONL (closes ticket-03 A3 providers blocker) | `e2e-data/T5-probe.log`, `converge.jsonl`, `not-converge.jsonl`, `*.summary.json` |
| T6-fullchain.mjs | handoff (5): real unattended task-dev run in **throwaway repo** `/tmp/gtd-e2e-repo` (1 seed commit, no remote) | **23/24** — see failure analysis | `e2e-data/T6-fullchain.log`, screenshot 04 |
| T7-ac8.sh | AC8 static scope | **8/8 PASS** (first run 2 FAILs were script-side wrong premises: AC8 keeps sync-builtin.mjs, only removes its schema branch; setup-runner remaining mention is the doc-comment describing removal) | `e2e-data/T7-ac8.log` |
| T8 regression | ticket-07 AC5 baseline | **AC5 PASS** — see below | `e2e-data/T8-regression.log`, `/tmp/gtd-server-{now,base}.txt`, `/tmp/gtd-engine-{now,base}.txt` |

### T6 evidence (what PASSED — substantive chain)

- develop node JSONL `end=completed`; transcript contains the goal condition (real `/goal` loop converged)
- ship node completed; **local commit** `feat: add hello.txt with GTD_E2E_OK` — exact content verified via `git for-each-ref` + `git show <branch>:hello.txt`
- `ship-report.md` exists in `~/.octopus/tasks/<id>/artifacts` and references the AC; artifacts API 200
- var_pool `ship_status` = local fallback (no-remote degradation, per task-dev prompt 三阶段)
- **Safety held**: repo never had a remote before/after; real octopus repo untouched; zero stray executions for non-T6 tasks

### T6 single FAIL — Step 4c (stop and report)

**Assertion**: `EXEC task completed + schedule done` → got `task=failed sched=failed` while `executions.status='completed'` and all node/git evidence above passed.

**Fix attempts**:
1. **Quick Fix — BLOCKED, not attempted**: fix requires patching `packages/server` and restarting :3001; `:3001` runs compiled dist (no watch) and the task environment mandates "do NOT restart or kill". 
2. **diagnosing-bugs (attempt) — root cause established, fix NOT applied**:
   - `packages/engine/src/engine.ts:431` fires `onComplete(result.status)` **inside** `run()`.
   - `packages/server/src/services/scheduler/executors/workflow-executor.ts:459` (`handleChainComplete`) re-reads `execDAO.findExecutionStatusSimple()` at that moment → still `'running'` because the server persists the final status only **after** `run()` returns (`ExecutionLifecycle.ts:556`); also `EngineCallbacks.ts:496` drops the status arg.
   - `status !== 'completed'` → else-branch marks schedule `'failed'` and mirrors `tasks.status='failed'`.
   - **Pre-existence proof**: zero diff on the 3 involved files across `main...HEAD`; historical 2026-08-17 tasks (`E2E_TD_ac6-verify2`, `E2E_TD_simple-A-*`) carry the identical `task=failed / sched=failed / exec=completed` signature.
   - **Minimal patch direction (for manual dev)**: thread engine final status through `EngineCallbacks.onComplete(status)` → `handleChainComplete(opts.engineFinalStatus ?? …)`; mind the later `allSkipped→failed` adjustment in ExecutionLifecycle.

**Impact**: cosmetic-lifecycle only — nothing executed twice, no data corruption, cleanup normal; but UI/board will show a *successful* task as failed after any real task-dev run until this platform bug is fixed.

## Regression baseline (ticket-07 AC5: server/engine 失败集不新增)

- **engine**: current failed set (4 files / 4 test-level failures: octopus-wf-e2e-tester, pr-workflows, outputs-resolver ×1, swarm-host-agent ×3) is a **test-name-level exact match** to `/tmp/engine-baseline.txt`. **Zero new.**
- **server**: `/tmp/server-post-05.txt` = 46 failures / 13 files. Full `pnpm test` (workspace-root cwd) shows 47/14 — the single extra (`subsystem-adapter > does not import getExperiencesDir`) is a **test-harness cwd artifact**: that test reads `process.cwd()/src/...` (ENOENT from repo root), passes **6/6** under the baseline's own invocation (`pnpm --filter @octopus/server`). At matched invocation: **exact 46/13, zero new** (verified by comm-diff of normalized failure lists).
- providers (11 pi) / shared (4 env) match documented pre-existing sets — out of AC5 scope, consistent.
- **Out-of-scope observation**: web-app `task-modal-spec-panel > displays bound workflow_ref` fails at HEAD ("Found multiple elements: octo/my-flow") — introduced by base-branch commit `c6e1613e` (task-workflow-presets T6 mounting WorkflowBox into SpecPanel next to WorkflowRefDisplay), **not** by goal-task-dev commits. Recommend a follow-up ticket (test-side `getAllByText` or dedupe the double render). Remaining 8 web-app failures (knowledge-ui, harness-floating-panel, system-pages) are base/main-era, outside AC5 scope.

## Cross-validation evidence matrix (R3)

| AC | Units/CLI | API | DB | Files/JSONL | UI/Screenshots | Layers |
|----|-----------|-----|----|-------------|----------------|--------|
| AC1 | ✅ T1 engine×22 | — | — | — | — | 1 (pure-unit by spec design) |
| AC2 | ✅ | — | ✅ T6 sched/exec rows | ✅ T5 converge.jsonl + worktree file | ✅ shot 04 | 4 |
| AC3 | ✅ runner mapping | — | — | ✅ T5 not-converge.jsonl subtype chain | — | 2 |
| AC4 | ✅ T1 providers 14 | — | — | — | — | 1 (unit by spec design) |
| AC5 | ✅ shared 28 | — | — | ✅ CLI fixtures + stdout | — | 2 |
| AC6 | ✅ | ✅ T3 30/30 | ✅ config JSON materialized | ✅ live preset catalog file | ✅ shots 01–03 | 5 |
| AC7 | ✅ | — | — | ✅ sim stdout | — | 2 |
| AC8 | — | — | — | ✅ grep + script exit 0 | — | 2 |
| AC9 | ✅ server 12 | ✅ presets API | — | ✅ live catalog `# version: 2` | ✅ shot 01 (prefill from seeded preset) | 4 |

## Anti-Fake-Run compliance (R1–R8)

- **R1 real CLI (non-mock)**: T5/T6 used real `claude` 2.1.250 processes; no stubbed providers at integration layer. ✅
- **R2 file-content/subtype assertions**: exact `GTD_E2E_OK` via `git show`, JSONL `end.status`/subtype chains parsed line-by-line. ✅
- **R3 cross-validation**: matrix above; execution ACs carry ≥2 real layers (T6: 4). AC1/AC4 are unit-level by spec's own Verification Method (documented, not a coverage shortcut). ✅
- **R5 side-effect assertions**: schedule row shape, config JSON, git commits, artifact files — not just HTTP 200. ✅
- **R7 prefix isolation**: all E2E data `E2E_TEST_GTD_`; gate tasks aborted pre-tick; T6 only bound to throwaway repo. ✅
- **R8 replayable scripts**: T1–T8 in `e2e-scripts/`, self-contained, idempotent (T3/T4 re-ran green during this session). ✅
- Independent auth: dev routes are open (no auth) — documented, N/A rather than mocked. ✅

## Environment integrity (post-run)

- `E2E_TEST_GTD_` rows: tasks=0, queued task-schedules=0, executions(last 2h)=0
- `/tmp/gtd-e2e-repo` removed; `~/.octopus/orgs/default/repos/index.md` restored to pre-run absence; task homes removed; workspaces + worktrees pruned
- **All 19 backed-up schedules untouched/paused** (`/tmp/e2e-enabled-schedules.bak`; enabled task-origin count = 0); dev server :3001 + web :3000 never restarted/killed
- Real-spend estimate within the ~$1 approval: T5 probe ≈ $0.23 (B3 `costUsd` evidence) + T6 develop+ship (max_turns fuse=15)

## Findings & recommendations

1. **FAIL (pre-existing platform, blocks clean full-chain status mirror)**: onComplete-before-status-persist ordering — patch `EngineCallbacks.ts:496` + `workflow-executor.ts:459` to thread engine final status. Manual dev decision (needs server restart).
2. **INFO (base branch, out of goal-task-dev scope)**: `task-modal-spec-panel` duplicate-text failure from `c6e1613e`; needs test/component dedupe follow-up on task-workflow-presets.
3. **INFO**: `subsystem-adapter` source-scan test should use a module-relative path instead of `process.cwd()` to be workspace-run safe.
4. **INFO**: xzf-dev CLI validate remains broken on pre-existing swarm `host.prompt` (ticket-04) — unrelated baseline.
