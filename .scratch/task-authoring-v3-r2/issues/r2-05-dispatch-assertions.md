# r2-05 — dispatch 套件断言强化（真实 edge/negative，禁 padding）

## What to build
`packages/server/src/__tests__/tasks-v3-dispatch.test.ts` 是全特性密度最低套件（0.072，22 asserts / 7 tests），却承载 US12/D14 三路径 `$vars.task_artifacts_dir` 注入关键声明。补充真实 edge/negative 断言到 ≥32 asserts：

建议方向（按实际代码选择，每条断言必须有独立真值来源）：
1. **legacy 键缺席**：v2 任务（无 task_type）ready 后，schedule config 的 workflow_chain[0].input_values **不含** `task_artifacts_dir` 键（`expect(...).not.toHaveProperty('task_artifacts_dir')`，而非"不报错"）
2. **composite 保留完整性**：buildCompositeInputValues 在保留注入键的同时，原有键（goal/subunits 等）不丢失、不被覆盖
3. **composition 类型保持**：input_mapping 解析 `$vars.task_artifacts_dir` 后值为 string 且等于注入值；若注入非 string 值（通过 VarPool 直接 seed）类型保持不失真
4. **injection seam**：readyTask 经注入的 TaskHomeService 实例计算 artifactsDir（temp base 注入 → config 中路径前缀 == temp base，证明走了注入 seam 而非默认 homedir）
5. **materializeTaskSpecToConfig 直调边界**：taskArtifactsDir 参数为 undefined vs 提供时，输出 config 的差异断言

**禁止**：expect(true)、toBeDefined-only、仅 status code 断言、为凑数重复同义断言（tautological padding 会被 verification audit 扫描）。

## Blocked by
None

## Status
done

## Acceptance Criteria
- [x] AC1: suite 全绿（`pnpm vitest run src/__tests__/tasks-v3-dispatch.test.ts`）— 12 tests pass
- [x] AC2: `grep -c "expect(" tasks-v3-dispatch.test.ts` ≥ 32 — 42 expects
- [x] AC3: 无 tautological 模式（自查 + audit 会复核）— no expect(true), no toBeDefined-only, no status-only, no self-equality; removed 2 redundant typeof checks (implied by Object.is type-strict toBe)

## Verification Method
vitest 执行 + 断言计数 + 模式扫描

## Exploration

### Analog studied
The existing `tasks-v3-dispatch.test.ts` (7 tests, 22 expects) — the very suite to strengthen. Its three describe blocks map to the three `$vars.task_artifacts_dir` injection paths (simple materialize / composite buildCompositeInputValues / composition-wf input_mapping). Each path already has a confirmed seam; my job is to add edge/negative assertions at those SAME seams (no new seams, no production changes).

### Files needing modification
- `packages/server/src/__tests__/tasks-v3-dispatch.test.ts` ONLY (my lane). No production code touched.

### Production seams confirmed (read-only, Round 1 interfaces)
- `materializeTaskSpecToConfig` (`scheduler-service.ts:189`) — pure function; builds `simpleInputValues` / `compositeInputValues` objects. Key-absence is observable via `Object.keys()` on the returned `workflow_chain[0].input_values` (when `taskArtifactsDir` is undefined, the key is never SET, so `Object.keys` excludes it — stronger than `toBeUndefined`).
- `buildCompositeInputValues` (`workflow-executor.ts:611`) — replaces `firstStep.input_values` entirely, then spreads `...artifactsEntry` LAST. Observable via the `createSpy` seam already wired in this suite. Returns exactly `{subunits, subunit_count, goal, integration_prompt, task_artifacts_dir}` — exact-keys match catches both dropped and leaked keys.
- `TaskDispatchExecutor.resolveMappingValue` (`task-dispatch.ts:257`) — `$vars.xxx` → `pool.get(key)` preserves type (VarPool stores `any` in a Map, `Object.entries` preserves number/boolean). Observable via the `TaskDispatchPort` spy already wired (AC3 describe). Type-preservation: seed `variables: { numeric_metric: 42, flag: true }` → assert `typeof received.input_values.numeric_metric === "number"` (not stringified).
- `TasksService` constructor (`tasks-service.ts:285`) — optional `taskHomeService` (position 4). `readyTask` (`tasks-service.ts:679`) calls `this.taskHomeService.artifactsDir(id)` and threads it into `materializeTaskSpecToConfig`. Observable by injecting `new TaskHomeService(tempBase)`, seeding a v3 draft task, calling `svc.readyTask(id)`, then reading `schedules.config` from the DB — the resulting `task_artifacts_dir` starts with `tempBase` (proves the injected seam, not the default `os.homedir()/.octopus`).

### Functions chosen (and NOT chosen)
- USE `materializeTaskSpecToConfig` direct-call for key-set integrity assertions (Tests A, B) — pure function, no DB needed, fastest signal.
- USE the existing `createSpy` mock seam (AC2 describe) for composite key-preservation assertions (Test C) — already wired, `buildCompositeInputValues` output is observable at `createSpy.mock.calls[0][1].input_values`.
- USE `WorkflowEngine` + `TaskDispatchPort` spy (AC3 describe) for type-preservation (Test D) — real engine, deterministic pause at `pending_task_dispatch`; the port spy receives the materialized subunit. Do NOT mock the executor itself (would test the mock, not `resolveMappingValue`).
- USE `TasksService.readyTask` + real `:memory:` DB + injected `TaskHomeService(tempBase)` for the injection-seam test (Tests E, F) — exercises the production ready→materialize→insertSchedule chain end-to-end. Do NOT use `POST /api/tasks/:id/ready` (would pull in Hono routing, out of scope; the service seam is the confirmed boundary).

### New assertion dimensions (each non-tautological vs existing)
1. Object.keys exact-set (structural — catches key drop/leak that value-checks miss) — Tests A, B, C, F.
2. subunit_count derivation (function computes `subunits.length`, not echoed param) — Test B.
3. integration_prompt key-renaming (`task_spec.integration_goal.prompt` → `integration_prompt`) — Test C.
4. type preservation through input_mapping (number/boolean not stringified) — Test D.
5. injection seam (config path uses tempBase, not default homedir; task_spec dropped from config SG5; S2 origin wiring) — Tests E, F.

Target: 22 existing + ~22 new = ~44 expects, all with independent truth sources (known-good literals, derived-value expectations, structural key-sets). Zero `expect(true)`, zero `toBeDefined`-only, zero status-only.
