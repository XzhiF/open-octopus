# 11 — core-pack composition workflow 模板 + task-author SKILL 内容

## What to build
core-pack：composition workflow 模板（coordinator-ws 无 projects）—— **G10：Loop over subunits**（每 iteration 一个 `task_dispatch` 节点，subunit[i] 经 input_values 喂入）+ 后置 swarm/moa 聚合节点（读 loop 累积 `$taskDispatchNode.output`）。task-author SKILL.md 内容（scheduler API + task_spec schema + task_spec→WorkflowConfig 物化 curl recipes）。`octo-workflow-dev`/`octo-workflow-test` skill 覆盖 task_dispatch 节点。

## Blocked by
02, 09

## Status
done

### Verification results
- **validate-workflow.js** (`.claude` copy): `composition-task.yaml` → ✓ 1 passed, 0 errors, 0 warnings (exit 0). `--json` confirms `errors:[], warnings:[]`.
- **simulate**: `pnpm exec octopus workflow simulate packages/core-pack/workflows/composition-task.yaml --json` → exit 0, `passed:true`, `passedCount:1, failedCount:0`. Loop ran 3 iterations (break_when `$iteration >= $vars.subunit_count` converged), task_dispatch auto-passed each iteration, moa `integrate` mocked → status `completed`.
- **depends_on chain**: `loop-subunits` (entry) → `integrate` `depends_on:[loop-subunits]`; `dispatch-child` is the single loop inner node (loop entry, no warning).
- **Regression**: validator change is purely additive (one `case 'task_dispatch'`); `xzf-dev.yaml` + `matt-dev-pipeline.yaml` still pass. `budget-test.yaml` failure is pre-existing (no apiVersion/kind, not touched).
- **SKILL coverage**: node-schema.md §11 + node-patterns.md §11 (octo-workflow-dev); SKILL.md "11 node types" + full-wizard trigger + reference table; octo-workflow-test SKILL.md table row + REFERENCE.md §4 subsection; task-author SKILL.md composition example aligned to the real template. All synced core-pack→.claude (identical).

## Acceptance Criteria
- [ ] composition 模板 `validate-workflow.js` 0 errors（Loop + task_dispatch + moa，depends_on 链完整）
- [ ] Loop over subunits 收敛（break_when 满足）
- [ ] moa 聚合节点 depends_on task_dispatch loop
- [ ] task-author SKILL 含 API + schema + 物化指引
- [ ] octo-workflow-dev/test 覆盖 task_dispatch

## Verification Method
**Type**: manual + simulate
**Steps**: `node .claude/skills/octo-workflow-dev/scripts/validate-workflow.js <template>`（0 errors）；`octopus workflow simulate <template> --json`（happy path green，mock task_dispatch）；manual 检 SKILL 内容。
**Pass**: validate 0 errors + simulate green。**Fail**: max 3 then SKIP。

## Exploration

### Analog studied
- **Loop node**: `packages/core-pack/workflows/xzf-dev.yaml:518-577` (`execution` loop: `max_iterations`, `break_when`, `nodes:` plural, inner `depends_on` chain, `execute_when`) + `packages/engine/src/executors/loop.ts` (counter-based, `this.iterations++`, `loopContext = { iteration: N }` 1-based).
- **swarm/moa**: `packages/core-pack/workflows/matt-dev-pipeline.yaml` + `references/swarm-modes.md` (moa needs `aggregator` + `experts>=2 | dynamic+max_experts`).
- **sub_workflow mappings** (reused by task_dispatch): `node-schema.md` §9 (`input_mapping`/`output_mapping`).
- **task_dispatch contract**: `packages/shared/src/types/workflow.ts:304-313,423-428` (fields `subunit`/`workflow_ref`/`await` + reused `input_mapping`/`output_mapping`); canonical shape from `packages/shared/src/__tests__/task-pool-schema.test.ts:229-282` → `subunit: "$iteration.subunit"`, `await: true`, `output_mapping: { result: "$last_output" }`.
- **TaskDispatchExecutor** (`packages/engine/src/executors/task-dispatch.ts`): `resolveSubunit()` (line 205-239) resolves `$iteration.xxx` via `config.loopContext[xxx]` — so composition loop must expose `loopContext.subunit` per iteration (engine/scheduler materialization; out of core-pack scope). `output_mapping` is `{ parentVar: childKey }` (line 187) → writes `$vars.parentVar` AND `$<nodeId>.output.parentVar` for downstream moa.

### Files needing modification (all core-pack; .claude/ copies kept identical via established sync)
1. **NEW** `packages/core-pack/workflows/composition-task.yaml` — template (Loop over subunits → task_dispatch await → moa synthesis).
2. **NEW** `packages/core-pack/workflows/composition-task.test.yaml` — simulate fixture (mock moa; task_dispatch auto-passes in simulator).
3. `skills/octo-workflow-dev/scripts/validate-workflow.js` — add `case "task_dispatch"` to L1 switch (else `Unknown node type`).
4. `skills/octo-workflow-dev/references/node-schema.md` — "10"→"11" types, enum, add §11 task_dispatch.
5. `skills/octo-workflow-dev/references/node-patterns.md` — composition Loop+task_dispatch+moa pattern.
6. `skills/octo-workflow-dev/SKILL.md` — "10"→"11" node types + tags.
7. `skills/octo-workflow-test/SKILL.md` + `REFERENCE.md` — task_dispatch simulate auto-pass note.
8. `skills/task-author/SKILL.md` — already complete (Stage 1/ticket 09): has API + task_spec schema + 物化指引; verify only.

### Functions/conventions chosen
- **Loop convergence**: `break_when: '$iteration >= $vars.subunit_count'` — `$iteration` resolves via `loopContext.iteration` (expression.ts:49-50). Verified: simulator (0-based, `executeLoopNode` simulator-engine.ts:270-283) and real engine (1-based, loop.ts:436) both converge to N iterations for `subunit_count=N`. Robust to 0/1-based offset.
- **task_dispatch inside loop**: uses `subunit: "$iteration.subunit"` (shared contract). In **simulate**, task_dispatch auto-passes (`simulator-engine.ts:380` no-mock + `createAndExecuteMock:435` default) — no TaskDispatchPort needed. In **real exec**, LoopExecutor.createExecutor (loop.ts:472-628) lacks a task_dispatch case → engine wiring gap (ticket 02 follow-up / scheduler materialization); noted, out of core-pack scope.
- **moa node**: `dynamic: true` + `max_experts` + `aggregator:{role,prompt}` to pass validation without hardcoding experts (L2 line 235 needs aggregator; dynamic skips experts>=2). In simulate, moa is a top-level swarm node → needs a mock (strict default).

### Simulate feasibility: FEASIBLE
`octopus workflow simulate` requires a `<name>.test.yaml` fixture (CLI workflow.ts:362-370). task_dispatch auto-passes in-loop; loop converges via `$iteration >= subunit_count`; moa mocked. Happy path green achievable.
