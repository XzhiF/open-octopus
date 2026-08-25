# 01 — shared 类型 + taskSpecSchema 扩展

## What to build
task_spec 的新字段获得 schema 身份：`task_type`（coding/generic）、`skill_groups[]`、`decisions[]`、`goal_confirmed`、`ac_confirmed[]` 经 zod 校验且 PUT 往返不丢失；`decisions` 成为合法的 spec-field 字段；AssistWorkflowRun / ArtifactIndexEntry 类型就位。

## Blocked by
None — can start immediately

## Status
done

## Acceptance Criteria
- [x] AC1: `shared/src/types/scheduler-job.ts` 的 taskSpecSchema 增 `task_type: z.enum(["coding","generic"]).optional()`、`skill_groups: z.array(z.string()).default([])`、`decisions: z.array(z.string()).default([])`、`goal_confirmed: z.boolean().optional()`、`ac_confirmed: z.array(z.string()).default([])`
- [x] AC2: `shared/src/types/task.ts` 的 TaskSpecFieldSchema 增 `"decisions"`；validateSpecFieldValue 增 decisions 分支（string[] 校验）
- [x] AC3: 新增 ArtifactIndexEntry 类型：`{ path, by, title, external, updated_at }`；AssistWorkflowRun 类型：`{ run_id, execution_id, workspace_id, template, status, logs[], output?, output_raw?, output_parse_error? }`
- [x] AC4: 既有字段 goal/ac min(1) 约束不被破坏

## Verification Method
**Verification type**: unit test

**Verification steps**:
```bash
cd packages/shared && pnpm vitest run src/__tests__  # 新增 task-schema-v3.test.ts
```
断言：`taskSpecSchema.parse({goal:"g",ac:["a"],task_type:"coding",skill_groups:["open-spec"],decisions:["x"]})` 往返后三新字段存在；`validateSpecFieldValue("decisions", ["a"])` 通过；`validateSpecFieldValue("unknown", ...)` 仍抛错。

**Pass criteria**: All verification steps PASS
**Failure handling**: Max 3 fix attempts, then mark SKIP with reason

## Exploration

### Analog studied
- **`validateSpecFieldValue` + `TaskSpecFieldError`** — the closest existing analog lives in the *server*, not shared: `packages/server/src/services/tasks/tasks-service.ts:77` (`TaskSpecFieldError`) and `:180` (`validateSpecFieldValue`, an 8-branch switch + defensive default). The spec modules table (spec line 94) and AC2 attribute `validateSpecFieldValue` to `shared/src/types/task.ts`, and the verification asserts it from within the shared test suite — so the canonical validator must live in shared. I ported the server's switch into shared (the analog's full behavior, not speculation) and added the `decisions` branch.
- **taskSpecSchema `.default([])` convention** — `resources`/`authoring_resources` already use `z.array(...).default([])` (scheduler-job.ts:111-113), which makes them REQUIRED keys in the inferred `TaskSpec` output type. AC1 mandates the same `.default([])` for `skill_groups`/`decisions`/`ac_confirmed` and `.optional()` for `task_type`/`goal_confirmed`. I followed AC1 exactly; the required-key consequence is the established pattern.

### Files modified (all in `packages/shared` — my lane)
- `src/types/scheduler-job.ts` — taskSpecSchema +5 fields (AC1): `task_type` (enum optional), `skill_groups`/`decisions`/`ac_confirmed` (`.default([])`), `goal_confirmed` (bool optional).
- `src/types/task.ts` — (AC2) `TaskSpecFieldSchema` enum +`"decisions"`; new `TaskSpecFieldError` class + `validateSpecFieldValue(field, value)` canonical function with `decisions` branch (string[] non-empty, mirroring the `ac` branch). (AC3) new `artifactIndexEntrySchema`/`ArtifactIndexEntry`, `assistWorkflowLogSchema`, `assistWorkflowOutputSchema`, `assistWorkflowRunSchema`/`AssistWorkflowRun`.
- `src/__tests__/task-schema-v3.test.ts` — NEW (verification: 23 tests, all green).

### Collateral fix (shared tests only — not another ticket's files)
- `src/__tests__/task-domain-schema.test.ts` (lines 227, 424) and `src/__tests__/task-pool-schema.test.ts` (line 214) — 3 `TaskSpec`-typed literals that pre-existing-included `resources`/`authoring_resources` now also need the 3 new defaulted keys to satisfy the inferred type. Added `skill_groups: [], decisions: [], ac_confirmed: []` (mirrors the existing `resources: []` pattern). This brought shared `tsc --noEmit` back to the 9-error pre-existing baseline (proven via stash).

### Specific functions / decisions chosen
- **`validateSpecFieldValue` signature**: `(field: TaskSpecField, value: unknown): unknown` — mirrors the server's (`tasks-service.ts:180`). Throws `TaskSpecFieldError` (default branch → "unknown field"). `decisions` branch validates `Array.isArray && every(string && non-empty)`, same shape as `ac`.
- **Did NOT add `goal_confirmed`/`ac_confirmed` branches** to the shared validator — those are ticket 05's lane (server-side `source` flag + ready gate; ticket 05 AC2 binds them). AC2 names only `decisions`.
- **`AssistWorkflowRun.status`** kept as `z.string()` (permissive) — the lifecycle vocabulary is owned by the server/ticket-07 run service; shared carries only the contract shape (spec GET response line 126). Avoids dictating enum values to ticket 07.
- **`output`/`output_raw`/`output_parse_error`** triplet included per spec line 126 + SW-BP10 (aggregator JSON parse-failure fallback).

### Lane boundaries respected (verified, not touched)
- Server source/tests: NOT modified. Verified the server's gates still pass with my shared change: `pnpm build` (tsup, does not typecheck test files) ✓; the 5 server test files that construct `: TaskSpec` literals (`07-resource-loading`, `06-schedules-origin-materialize`, `orchestration-strategy`, `scheduler-task-spec`, `workflow-executor-dispatch`) PASS at runtime — 45 passed / 2 skipped. Production server code uses `as unknown as TaskSpec` / `JSON.parse(...) as TaskSpec` casts (`tasks-service.ts:163,390,451`; `workflow-executor.ts:644`; `scheduler-service.ts:777`) which bypass the required-key check. No repo-level `tsc`/`typecheck` gate exists (only web-app has `lint: eslint`), so latent server test-literal type errors are not gated — same tolerated category as the 9 pre-existing shared `tsc` errors.
- `scheduler-service.ts` / `tasks.ts` routes / `task-home-service.ts` / assist workflows — untouched (tickets 02/04/05/07/08).

### Notes
- The one failing test in `pnpm vitest run src/__tests__` is `model-alias.test.ts` — PRE-EXISTING environment drift (`DEFAULT_MODEL_ALIASES` now resolves to `my-ai/glm-5.2` / `deepseek-v4-pro`, the session's actual provider), proven by stashing my changes and re-running (fails identically). Unrelated to ticket 01.
