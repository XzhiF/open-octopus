# 04 — schedules.config shape

Type: research
Status: resolved

## Answer

### 1. Exact shape of schedules.config JSON today

`schedules.config` is a `TEXT NOT NULL DEFAULT '{}'` column (`schema.sql:285`) storing a JSON string. The executor casts it to `WorkflowConfig` without runtime Zod re-parse:

```ts
// workflow-executor.ts:112
const config = (typeof job.config === 'object' ? job.config : JSON.parse(schedule.config)) as WorkflowConfig
```

Note: `as WorkflowConfig` is a **type assertion, not a Zod `.parse()`**. Runtime validation happens upstream in `scheduler-service.ts` (`validatedConfig`); the executor only does a duck-type check at `workflow-executor.ts:114`:

```ts
if (config.type !== 'workflow' || !config.workspace_spec || !config.workflow_chain?.length) { ... }
```

The authoritative Zod schema is `workflowConfigSchema` (**v2.0**) at `packages/shared/src/types/scheduler-job.ts:63-69`:

```ts
export const workflowConfigSchema = z.object({
  schema_version: z.literal('2.0'),
  type: z.literal('workflow'),
  workspace_spec: workspaceSpecSchema,                 // line 33-37
  workflow_chain: z.array(workflowChainItemSchema).min(1).max(20),  // line 39-42
  max_retain: z.number().int().min(1).max(100).default(10),
})
```

Constituent schemas (same file):

- `workspaceSpecSchema` (line 33-37): `{ org: string(1-100), branch_prefix: string(1-50, /^[a-zA-Z0-9_-]+$/), projects: projectSpecSchema[](1-20) }`
- `projectSpecSchema` (line 26-31): `{ name: string(1-100), source_path: string().default(""), group: string().default("") }`
- `workflowChainItemSchema` (line 39-42): `{ workflow_ref: WorkflowRef, input_values: Record<string,string>.default({}) }`
- `WorkflowRef` (`packages/shared/src/resource/workflow-ref.ts:14-16`): string regex `/^[a-zA-Z0-9][a-zA-Z0-9._-]*(?:\/[a-zA-Z0-9][a-zA-Z0-9._-]*)?(?:\.ya?ml)?$/` — accepts `"group/name"` or `"name.yaml"`.

Also defined: `workflowConfigSchemaV1` (line 54-60, `@deprecated v1.0`, no `workspace_spec`/`workflow_chain`, single `workflow_ref`); `legacyJobConfigSchema` (line 86-90, union of v1+v2+agent). `jobConfigSchema` (line 80-83) is a `discriminatedUnion('type', [workflowConfigSchema, agentConfigSchema])`.

**Concrete example of today's config JSON:**

```json
{
  "schema_version": "2.0",
  "type": "workflow",
  "workspace_spec": {
    "org": "xzf",
    "branch_prefix": "octo-feat-x",
    "projects": [
      { "name": "octopus", "source_path": "~/Projects/ai/XzhiF/open-octopus", "group": "" }
    ]
  },
  "workflow_chain": [
    { "workflow_ref": "built-in/bug-hunter", "input_values": { "target": "auth" } }
  ],
  "max_retain": 10
}
```

### 2. Where task spec / subunits / composition_plan / per-task skills should live

Recommendation, reconciled with decision 05 (which leans **(B) composition workflow + `task_dispatch` node**):

| Concern | Where it lives | Why |
|---|---|---|
| **task spec** (goal / AC / 数据模型 / 契约) | **Extend `config` JSON**: add optional `task_spec` field, bump `schema_version` to `'3.0'`. | This is the "what + why" that birthed the schedule — genuinely schedule-level metadata for human/AI traceability. It's lightweight text; the executor need not interpret it (it just carries it for the composition workflow's `input_values` and for audit). The config column is already `TEXT` + `schema_version`-gated, so adding a key is a non-migration change. |
| **subunits[]** | **Composition workflow YAML** (engine layer), declared in `task_dispatch` node payloads. | Each subunit = `{ WorkspaceSpec, workflow_ref, vars, skills }`. Decision 05's `task_dispatch` node already plans to carry these. The schedule's `workflow_chain` points at the composition workflow; the workflow's nodes own subunit declarations. |
| **composition_plan** (DAG/topology) | **Composition workflow's own node graph** (engine DAG/Loop/Swarm). | Storing topology again in schedules.config duplicates the workflow's DAG — the exact DRY violation decision 05 rejects in option (A). The workflow *is* the plan. |
| **per-task skills/agents selection** | **Subunit declaration inside the composition workflow** (the `task_dispatch` node's `input_values`, which already accepts `Record<string,string>` JSON). | `workflowChainItemSchema.input_values` (scheduler-job.ts:41) already carries arbitrary string→string payload; a subunit's skills list serializes cleanly into it. No schema change needed. |

**Do NOT** add new `schedules` columns or a separate `task_spec` table. Reasoning:
- New columns (`task_spec_id`, etc.) = schema migration for data that is really document-shaped → wide-not-deep anti-pattern; the `config` TEXT column already absorbs document JSON via `schema_version`.
- A separate table adds a join + new DAO + migration for what is 1:1 with a schedule. Only justify a table if task specs become reusable across many schedules / versioned independently — not the case for the current 1:1 requirement→schedule flow.
- The executor's `as WorkflowConfig` cast tolerates extra keys (it's an assertion, not a strict parse), so a `schema_version: '3.0'` with an added `task_spec` field won't break the executor as long as `workspace_spec` + `workflow_chain` remain present. The service layer should add the real Zod validation (`workflowConfigSchema.parse`) — currently validation is partial.

**Fallback** (if decision 05 reverses to option (A) scheduler-layer composition): then `subunits` + `composition_plan` move into `config` JSON by generalizing `workflow_chain` from a sequential `array` to a DAG object (topology + edges), and `skills` ride on each chain item. This is the path decision 05 warns against (scheduler becomes a second orchestration engine). Avoid unless (B) is rejected.

### 3. Does WorkspaceSpec.projects already support multi-repo?

**Yes.** `projects: z.array(projectSpecSchema).min(1).max(20)` (`scheduler-job.ts:36`) — up to 20 repos per workspace. Each `projectSpecSchema` item = `{ name, source_path, group }`.

`WorkspaceService.createFromSpec` (workspace.ts:315-387) passes `input.projects` straight to `WorkspaceGit.initWorktreesFromSpec` (workspace-git.ts:99-145), which loops over every project and creates an **independent git worktree** per project under `{wsDir}/projects/{name}`, each sourced from `proj.source_path` (the main repo). Resulting `config.json` `repos[]` array (workspace-git.ts:150-152) records `{ name, main_path, worktree_path, branch }` per repo. So "projects as codebase" multi-repo is already fully wired and materialized.

**Gap worth flagging:** `projectSpecSchema.source_path` defaults to `""` (scheduler-job.ts:29), with a comment "empty source_path resolved server-side from repos/index.md". But `initWorktreesFromSpec` does **not** resolve empty paths — it calls `proj.source_path.replace(/^~/, os.homedir())` (workspace-git.ts:111) and, if the path doesn't exist or lacks `.git`, silently `continue`s (workspace-git.ts:115-118), skipping that project's worktree. So the "resolved from repos/index.md" contract is **not implemented** on the scheduler path; an empty `source_path` yields a missing worktree, not a resolved one. If the multi-repo use case needs server-side resolution, this is the fix point.

### 4. Naming collision risk (createFromSpec's "spec" vs future xzf-dev spec doc)

**Risk: LOW (cognitive only, no key/type collision).** The term "spec" is overloaded across three distinct namespaces that never share a storage key:

1. **`WorkspaceSpec`** (`scheduler-job.ts:33-37`, type) — workspace materialization params (`org`/`branch_prefix`/`projects`). Persisted *inside* `config.workspace_spec` (a JSON key), never under a bare `spec` column/key.
2. **`WorkspaceService.createFromSpec`** (workspace.ts:315, method) — the "spec" here is a **parameter name** for a `WorkspaceSpec`-shaped arg. Not persisted, not a type.
3. **xzf-dev `spec.md` files** — already exist: 20+ files at `.scratch/*/spec.md` (requirement/design docs: goal/AC/数据模型/契约). These are **markdown files**, not DB rows or config keys.

A future `task_spec` config field (recommendation in §2) would be a fourth namespace: `config.task_spec` (JSON key inside schedules.config). It does not collide with `config.workspace_spec` (different key) nor with `spec.md` files (different storage: DB JSON vs filesystem markdown).

**Recommendation:** No rename needed. To eliminate cognitive ambiguity in docs, adopt the convention: `WorkspaceSpec` = "workspace materialization spec"; `task_spec` / `spec.md` = "requirement spec". If extra safety is wanted, name the config field `requirement_spec` instead of `task_spec` — but `task_spec` is clearer given the task-pool context and the `trigger_source: 'requirement'` lifecycle already in place (`scheduler-job.ts:17`).

## Primary sources

- `packages/shared/src/types/scheduler-job.ts:26-107` — `projectSpecSchema`, `workspaceSpecSchema`, `workflowChainItemSchema`, `workflowConfigSchema` (v2.0), `workflowConfigSchemaV1` (deprecated), `legacyJobConfigSchema`, derived types.
- `packages/shared/src/resource/workflow-ref.ts:14-16, 61-68` — `WorkflowRef` regex + `zodSchema()`.
- `packages/server/src/db/schema.sql:262-296` — `schedules` table (schema v37), `config TEXT NOT NULL DEFAULT '{}'`, `status`/`trigger_source`/`source_chat_session_id`/`claimed_at`/`max_retain` columns.
- `packages/server/src/db/schema.sql:299-324` — `schedule_executions`; `:360-373` — `schedule_workspaces`.
- `packages/server/src/db/dao/schedule-config-dao.ts:75-103` — `insertSchedule` (writes `config` as JSON string, default `"{}"`); `:105-114` `updateSchedule`; `:327-335` `insertScheduleWorkspace`.
- `packages/server/src/services/scheduler/executors/workflow-executor.ts:112` — `config` parsed/cast as `WorkflowConfig`; `:114` duck-type validation; `:140-149` `createFromSpec` call passing `workspace_spec` + `workflow_chain`; `:429-435` chain continuation reads `config.json` `workflow_chain`.
- `packages/server/src/services/workspace.ts:315-387` — `createFromSpec` signature + `config.json` write (`workflow_chain: input.workflow_chain.slice(1)`).
- `packages/server/src/services/workspace-git.ts:99-164` — `initWorktreesFromSpec`: per-project worktree, `source_path` resolution, `repos[]` write.
- `packages/server/src/services/scheduler/scheduler-service.ts:306-308, 810` — `validatedConfig` Zod validation + `workspace_spec` derivation.
