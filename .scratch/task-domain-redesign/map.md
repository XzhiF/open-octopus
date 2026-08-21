# Decision Map — Task Domain Redesign (v2)

> Wayfinder map. Living registry of decisions, fog, and decision tickets.
> This is **v2** of the task-pool effort: it **overturns v1's D9** ("no new table, task_spec in schedules.config JSON v3.0")
> and re-evaluates ADR-0008 under a first-class `tasks` table.
> **v1 baseline** (implemented as PR #50 / `test-task-board`): `.scratch/task-pool-redesign/` (map/spec/issues).
> v2 adds three things v1 lacked: deterministic draft autosave, spec↔agent linkage, non-cwd skill/resource loading.

## Destination

A first-class `tasks` domain that owns the full task lifecycle (`draft → ready → running → done/failed/aborted`),
the task_spec (WHAT), and resource/skill binding — with a deterministic, app-driven draft save (turn-end autosave
+ save-draft button), bidirectional agent↔spec-panel linkage (agent can auto-bind fields during chat; user can
override), and the task-author agent able to load installed (non-cwd) skills/resources at draft time. The scheduler
is stripped of the task-pool hack (the 4 v37 columns + cron-nullable + config.task_spec). Orchestration is decided
under the new tasks-table context (re-evaluating ADR-0008).

## Notes (inherited — do NOT re-derive)

### From v1 (`task-pool-redesign/map.md`) — decisions that still hold
- **D1** task binds project(s) at authoring; workspace materialized at dispatch.
- **D2** spec = WHAT, workflow_ref = HOW. Decoupled.
- **D3** authoring chatbot = `task-author` clone (own CloneDef + SKILL.md).
- **D5** subunits declarative in spec; executor consumes.
- **D7** structured spec always; workflow_ref picks elaboration depth.
- **D8** execution-time HITL = workflow-native `interaction` node (separate from authoring chat).
- **D10** reuse engine DAG/Loop/Swarm/moa primitives.
- **D13** manual enqueue = confirm gate; draft = review state.
- **D14** integration output configurable via `task_spec.integration_goal` (moa synthesis default / merge opt-in).
- **D15** composite kanban = parent card + drill-down.
- **D16** `workflow_chain` kept as simple sequential same-ws fast path.

### From v1 — being OVERTURNED or RE-EVALUATED in v2
- **D9 (OVERTURN)** v1: "task_spec in schedules.config JSON v3.0, no new tables". v2: new `tasks` table owns
  lifecycle + spec; schedules stripped of task-pool hack. Greenfield cleanup (user: "无历史包袱").
- **D4 / ADR-0008 (RE-EVALUATE → ticket 01)** v1 chose workflow-layer `task_dispatch`. Under a real `tasks` table,
  the orchestration calculus changes: re-compare (A) reuse task_dispatch / (B) independent task engine / (C) hybrid.
- **D11 per-task skills** v1 flagged `loadSkills()` dead post-ADR-006; options synthetic-dir vs re-enable. v2
  expands scope (ticket 05): non-cwd *installed* skill/resource loading at draft time.

### From ADRs
- **ADR-0006** (plugin-skill-discovery): skills injected via SDK plugin scan of `skills/` dirs; `CloneDef.skills`
  whitelist is the filter (not dead — honored by loadSkills, but getPlugins ignores it → every clone inherits all
  shared skills). `~/.octopus/agent/` = main plugin; `built-in/{clone}/` = clone plugin. Nesting isolated (non-recursive).
- **ADR-0008** (composition-layer-workflow-task-dispatch): Accepted, hard-to-reverse. Composite orchestration at
  workflow layer via new `task_dispatch` node + `TaskDispatchPort`. v2 may **amend** (not silently overturn) via a new ADR.

### From today's research (post-refactor code state)
- **R-DB (research ①)**: No `jobs`/`tasks`/`resources`/`skills`/`dispatch` tables. Run chain:
  `schedules` (def) → `schedule_executions` (trigger bridge) → `executions` (workflow run) → `node_executions`.
  `scheduled_job_executions` = unrelated legacy agent-cron (no FK). Task-pool hack = schedules v37 cols
  (status/trigger_source/source_chat_session_id/claimed_at) + cron nullable + config blob (task_spec).
  sessions↔schedule = bidirectional SOFT link (sessions.scope_id→schedules.id, schedules.source_chat_session_id→sessions.id, no FK).
  Skills stored in `clones.skills` JSON + `schedules.config.skills` + `subunitSpecSchema.skills`. No resources table.
- **R-ORCH (research ②)**: `task_dispatch` executor (`task-dispatch.ts`) + `composition-task.yaml` (Loop+task_dispatch+moa)
  + `TaskDispatchService` (server port) are PRODUCTION-BUILT: pause-resume (G1), stale-claimed recovery, retry cap,
  concurrency cap (`MAX_PARALLEL_WORKSPACES`), SSE lifecycle, retention. Every task requires a workspace (coordinator
  ws with projects=[] for composite → N+1 workspaces). Independent engine duplicates ~600 LOC tested infra; unique value
  = eliminate coordinator-ws / task-native DAG (no YAML) / subunit-level retry / cross-subunit resource sharing.
- **R-AUTOSAVE (research ③)**: clone title saved server-side at `clone/index.ts:402-406` after assistant persist
  (first 40 chars; main-agent route has LLM-Haiku refinement, clone route does not). User msg persisted eagerly before
  stream; assistant msg + tool_calls metadata persisted after full response. `useAgentChat.onDone` fires once/turn with
  `{session_id,message_id,session_title}`; no explicit onTurnComplete. `resolveDraft` is the only post-turn action,
  READ-only + racy, no autosave endpoint. task-modal's useAgentChat passes NO `onTitleUpdate` (title signal dropped).
  Cleanest insertion = `clone/index.ts:406` (after title block, before done SSE), deterministic, full context.
- **R-LINKAGE (research ⑤)**: SpecPanel fields (projects/skills/goal/ac/subunits/integration) all local useState
  seeded once from `job`; write-back only via [保存 spec]→`updateJob` (PUT /jobs/:id, If-Match). ChatArea↔SpecPanel
  = ZERO bridge. Agent creates draft via full POST /jobs (entire config+task_spec), no incremental field API. Recommended
  bridge: `update_task_spec_field` tool → server updateJob → `spec_field_update` SSE → SpecPanel subscribe; reverse:
  SpecPanel save → notifyAgent (context msg). Version-conflict handling needed (409 on stale).

## Decisions so far (tentative — to survive grilling)

- **v2-D1 (user-stated)** New `tasks` table owns lifecycle + spec + resource/skill binding; schedules stripped of
  task-pool hack. Greenfield, no migration burden (user: "无历史包袱").
- **v2-D2 (user-stated + v2-D14)** Status machine: `draft → ready(待开始) → running` + terminal
  `done/failed/aborted` (v2-D14). [renames v1's queued→ready]
- **v2-D3 (user-stated)** Resource binding split: draft-time the task-author chatbot can load resources to use;
  workspace-time resources come via workflow `require`. User can specify AND agent can assist.
- **v2-D4 (user-stated)** Deterministic draft save: app-driven (NOT LLM-whim). Turn-end autosave + explicit save-draft button. [v1 had neither]
- **v2-D5 (user-stated)** spec↔agent bidirectional linkage: agent can auto-bind target/skills/goals during chat; user can override.
- **v2-D6 (resolved, R-AUTOSAVE + ③)** Autosave mechanism: server-side at task-author clone turn-end
  (`clone/index.ts:406` seam, after auto-title block, before done SSE), gated by `cloneName==='task-author'`;
  scope = **row-existence + title only** (v2-D11); spec flows via O4 tool + save button. Mirrors auto-title pattern.
- **v2-D7 (resolved, R-LINKAGE ⑤)** spec↔agent mechanism: `update_task_spec_field({field,value})` tool → server
  applies to tasks row → `spec_field_update` SSE → SpecPanel subscribes; reverse notify via context message
  (`@@spec_updated`). **All 6 fields auto-bindable** (v2-D12); conflict: user override wins (409 → re-GET + retry).
- **v2-D8 (tentative, R-RES — resolved)** Resource loading split (matches user decision): draft-time = **prompt injection**
  (read SKILL.md from global `installPath` → inject into task-author session system prompt; seams `pi-sdk-adapter.ts:99-112`
  + `prompt-enhancer.ts`); workspace-time = propagate `task_spec.resources` → `workflow.requires` + existing `ResourceProvisioner`.
  Reference model: `tasks.resources[] = [{type, name}]` declarative, resolved via global registry. Resources always live
  outside cwd (`~/.octopus/resources/installed/`); no resource↔entity binding exists today (`config.skills` decorative,
  `subunitSpec.skills` unused). [residual → resolved v2-D13: two-scope UX]
- **v2-D9 (user-confirmed, → ADR-0009)** Orchestration = **hybrid (C)**. `tasks` owns draft→ready→running + spec +
  resources/skills; dispatch delegates to existing `task_dispatch`/`WorkflowExecutor`/`SchedulerEngine` (reuse 600 LOC
  tested infra); **coordinator-ws conditional** (skip simple/1-subunit → N+1→1; composite N≥2 → coordinator-ws +
  composition-task.yaml); orchestration-strategy seam for incremental future (subunit retry / task-native DAG).
  ADR-0008 **amended** (not overturned) by ADR-0009.
- **v2-D10 (user-confirmed, S2)** tasks↔schedules association = **pure polymorphic origin (no FK)**. `schedules` adds
  `origin_type`(cron|task|agent|manual|api|…, **replaces trigger_source**, extensible no-migration) + `origin_id`(TEXT NULL,
  no FK — tasks.id when origin_type='task') + `origin_role`(coordinator|subunit|primary). `tasks` has **NO schedule pointer**;
  lookups via `schedules.origin_type='task' AND origin_id=task.id`. Removed: trigger_source, source_chat_session_id, config.task_spec.
  **R-INT (accepted):** origin_id orphan risk → mitigated app-level (cascade-reap on task delete + orphan reaper + createJob-rollback).
  Composite N children: origin_id=parent + origin_role='subunit'. Cron/agent-direct: origin_id=NULL.
- **v2-D11 (user-confirmed, ③)** Autosave scope = **row-existence + title only** (mechanism v2-D6). Spec fields
  flow via O4 `update_task_spec_field` tool (agent) + [保存草稿] button (user), NOT via autosave. Draft row exists
  from turn 1.
- **v2-D12 (user-confirmed, ⑤)** spec↔agent linkage = **all 6 fields auto-bindable** (projects/skills/goal/ac/
  subunits/integration_goal) via `update_task_spec_field` tool; SpecPanel live-renders via `spec_field_update` SSE;
  reverse = context message on [保存草稿]; conflict = user override wins (409 → re-GET + retry).
- **v2-D13 (user-confirmed, ④)** Resource UX = **two persisted scopes**: `tasks.authoring_resources[]` (draft-scope,
  prompt-injected into task-author session, reload on reopen) + `tasks.resources[]`/`subunitSpec.resources[]`
  (workspace-scope, → `workflow.requires` + provisioner). Both user-picker + agent-tool editable. Matches user's
  draft/workspace split; authoring aids don't pollute execution requirements.

## Not yet specified (fog)

- **F-ORCH** — RESOLVED (research ② + user → v2-D9=C, ADR-0009): hybrid; tasks own lifecycle, delegate orchestration, coordinator-ws conditional.
- **F-ASSOC** — RESOLVED (user → v2-D10=S2): polymorphic origin_type+origin_id (no FK); tasks has no schedule pointer; lookups via schedules.origin.
- **F-AUTOSAVE-FIELDS** — RESOLVED (user → v2-D11): row+title only; spec via O4 tool + save button.
- **F-LINKAGE-FIELDS** — RESOLVED (user → v2-D12): all 6 fields auto-bindable; reverse context msg; 409 retry.
- **F-NONCWD-LOAD** — RESOLVED (research ④ → v2-D8): prompt-inject from global `installPath` at draft-time; provisioner at workspace-time.
- **F-RES-UX** — RESOLVED (user → v2-D13): two persisted scopes (authoring_resources draft-inject / resources → workflow.requires); user picker + agent tool.
- **F-STATUS-TERMINAL** — RESOLVED (user → v2-D14): draft|ready|running|done|failed|aborted; claimed folds into running; discard=soft-delete.

## Out of scope

- Overturning v1 decisions that hold (D1,D2,D3,D5,D7,D8,D10,D13,D14,D15,D16).
- Cross-workspace `sub_workflow` (v1 out; stays out).
- xzf-dev as DEFAULT authoring pipeline (stays opt-in).
- Frontend chat component rewrite (reuse ChatArea/useAgentChat).
- Data migration from v1 PR#50 rows (user: greenfield, no historical baggage — fresh DB acceptable; v1 rows on dev DBs can be dropped).

## Decision Ticket Registry

| # | Slug | Type | Status | Blocked by |
|---|------|------|--------|------------|
| 01 | grilling-orchestration-engine | grilling | **resolved** (→ v2-D9=C, ADR-0009) | None |
| 02 | grilling-task-table-association | grilling | **resolved** (→ v2-D10=S2) | None |
| 03 | grilling-draft-autosave-scope | grilling | **resolved** (→ v2-D11) | None |
| 04 | grilling-spec-agent-linkage-fields | grilling | **resolved** (→ v2-D12) | None |
| 05 | research-non-cwd-skill-resource-loading | research | **resolved** (→ v2-D8) | None |
| 06 | grilling-resource-binding-ux | grilling | **resolved** (→ v2-D13) | None |
| 07 | grilling-status-machine-terminal | grilling | **resolved** (→ v2-D14) | None |

> **Wayfinder exit reached** — all 7 decision tickets resolved, fog clear. Next: draft spec.md → story-walkthrough
> sub-agent → user confirmation → fix spec → issues/ DAG.

## ASCII — v2 target shape (pre-grill, provisional)

```
═══════════════════════════════════════════════════════════════════════
TASK DOMAIN REDESIGN v2 — target (provisional, pending grill 01-07)
═══════════════════════════════════════════════════════════════════════
[1] AUTHORING (tasks table owns draft)
    /tasks [+新建] → TaskModal authoring (spec LEFT / task-author chat RIGHT, LINKED)
      ├─ task-author clone chat (useAgentChat)
      │    ├─ turn-end → server autosave draft title + spec fields → tasks row  [v2-D4/D6]
      │    ├─ update_task_spec_field tool → SSE spec_field_update → SpecPanel  [v2-D5/D7]
      │    └─ load installed (non-cwd) skills/resources for authoring          [ticket 05]
      ├─ [保存草稿] button (manual save)                                       [v2-D4]
      └─ resources bindable to draft (authoring) OR target workspace (via wf require)  [v2-D3]
    status: draft

[2] CONFIRM  draft → ready(待开始)   [v2-D2]
    [入队] / [准备就绪] → draft→ready (confirm gate, v1 D13 stands)

[3] DISPATCH  ready → running  (orchestration: ticket 01 decides)
    (A) reuse task_dispatch + WorkflowExecutor  | (B) independent task engine  | (C) hybrid (recommended)
    tasks.schedule_id / execution_id written on dispatch

[4] RUNNING → done/failed/aborted  (terminal: ticket 07)

[5] REAL-TIME  SSE (schedule_status / spec_field_update)

schedules table: stripped of task-pool hack (status/trigger_source/source_chat_session_id/claimed_at → tasks)
═══════════════════════════════════════════════════════════════════════
```
