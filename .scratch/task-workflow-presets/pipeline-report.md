# Pipeline Execution Report

## Requirement: task-workflow-presets
## Status: PASS

### Phase 1: Development (matt-dev-runner)
| Ticket | Title | Status | Tests |
|--------|-------|--------|-------|
| T1 | shared schemas (input_values + preset catalog) | ✅ done | 21 |
| T2 | core-pack seed catalog → moved to embedded seed (review) | ✅ done | seed test 2 |
| T3 | server preset service + API | ✅ done | 7 |
| T4 | server template materialization | ✅ done | 16 (10 resolver + 6 materialize) |
| T5 | server ready-gate input validation | ✅ done | 5 |
| T6 | web-app WorkflowBox + binding dialog | ✅ done | 9 |
| T7 | copy fixes (persona + SKILL) | ✅ done | — |

Total: 114 dev tests green.

### Phase 2: Code Review (independent, referee≠player)
| Axis | Findings | Fixed | Noted | Cycles |
|------|----------|-------|-------|--------|
| Standards | 7 (no hard violations; baseline smells) | 4 | 2 + 1 rationale | 1 |
| Spec | 1 🔴 (seed copy missing) + 1 ⚠ (unknown placeholder 500) | 2 | 0 | 1 |

- 🔴 Seed copy: `DEFAULT_WORKFLOW_PRESETS_YAML` embedded in server, `CloneInitService` seeds task-author clone dir on first init; removed core-pack duplicate. Verified live: server startup seeded the file, `GET /api/workflow-presets` returns presets.
- 🟡 ready-gate single resolve + missing dedupe; `resolveInputValues` → `{values, unresolved}` (unknown/empty-WHAT placeholder → `missing.push("input:<name>")`, never 500); `InputValues` type alias; `getInputSource`→`describeInputShape`.
- 🔵 Noted: workflow-box 391-line split (when a 2nd consumer appears); `WorkflowPresetsService.list` wrapper return; `parseWorkflowInputDefs` "dup" is deliberate (home-flows aren't covered by builtin service — content-parse is the generic seam).
- Also fixed stale `template-picker` AC1 test (main inherited; D17 button-always-enabled).

### Phase 3: Deploy
No branch CI (only weekly `pi-compat-check`). Full monorepo `pnpm build` gate: **PASS** (server ESM/CJS/DTS + cli + shared). Local dev servers rebuilt + restarted (3001 / 3000) for E2E.

### Phase 4: E2E Verification (matt-e2e-tester, user opted in)
API 18/18 · Browser 13/13 · Contract PASS = **31/31 PASS**

| AC | Condition | Status | Evidence |
|----|-----------|--------|----------|
| 1 | WorkflowBox renders (v3 + v2 SpecPanel); binding dialog search/preset-prefill | PASS | e2e-screenshots/03-09 |
| 2 | `${goal}` resolves into schedule config input_values | PASS | e2e-data/ac5-schedule-config.json |
| 3 | Missing required input → 409 `input:<name>`; unknown placeholder → 409 (not 500) | PASS | e2e-data/ac4/ac6 |
| 4 | Composite skips task-level input validation | PASS | e2e-data/ac7-composite-ready.json |
| 5 | Seed catalog: general-dev fallback + skills-group filter | PASS | e2e-data/ac1 |
| 6 | PUT persists workflow_ref + input_values atomically; UI reflects bound state | PASS | DB + e2e-data/ac3 + screenshots |

Anti-fake-run R1-R8 satisfied (real service, business data, cross-validation API+DB+browser, evidence files, data isolation prefix E2E_TEST_WP_, cleanup).

### Phase 5: Ship (Git MR)
**PR #52**: https://github.com/XzhiF/open-octopus/pull/52 — feat/task-workflow-presets → base `main`, 基于 **bugfix-task-board**(用户指定一起输出)。E2E 结论见表上。Status: PASS。

### Changed Files (from git diff origin/main...HEAD)
| Project | Files | Change Type |
|---------|-------|-------------|
| shared | types/workflow-presets.ts (+InputValues), scheduler-job.ts (+input_values) | schema |
| server | workflow-presets-service.ts, routes/workflow-presets.ts, template-resolver.ts, tasks-service.ts (gate), scheduler-service.ts (materialize), workflow-presets-seed.ts, clone-init-service.ts, builtin-clones.ts | service+gate |
| web-app | workflow-box.tsx + binding dialog, authoring-workspace.tsx, spec-panel.tsx, workflow-presets-api.ts | UI |
| skills | task-author SKILL.md, core-pack skill copy | docs |

### Remaining Issues
| # | Issue | Impact | Suggestion |
|---|-------|--------|------------|
| 1 | workflow-box 391 行单文件 | 可读性(风险)| 出现第二消费方时拆目录 |
| 2 | `?skills_group` 未传名时返回全量 | 无 | 契约即如此 |
| 3 | agent 可靠性仍软依赖 | HOW-handoff 可能再次跳过 | UI WorkflowBox + gate 已兜底;后续可把推荐写进上下文更强制 |