# 01 — Composite orchestration under a first-class `tasks` table: reuse / independent / hybrid?

Type: grilling
Status: resolved (user chose C → ADR-0009, v2-D9)
Blocked by: None

## Answer

User selected **C (hybrid)**. `tasks` owns draft→ready→running + task_spec + resources/skills; dispatch delegates
to existing `task_dispatch`/`WorkflowExecutor`/`SchedulerEngine` (reuse 600 LOC tested infra); coordinator-ws
conditional (skip simple/1-subunit → N+1→1; composite N≥2 → coordinator-ws + composition-task.yaml);
orchestration-strategy seam for incremental future (subunit retry / task-native DAG). ADR-0008 **amended** by
ADR-0009 (not overturned). See `docs/adr/0009-task-domain-orchestration-hybrid.md`.

## Question

With a real `tasks` table owning the draft→ready→running lifecycle (overturning v1 D9), should composite task
orchestration (N subunits + integration) still go through the **workflow-layer `task_dispatch` node** (ADR-0008),
or should `tasks` own orchestration via an **independent task engine**, or a **hybrid**?

This re-opens ADR-0008 because that decision was argued under D9 ("no new table, task_spec in schedules.config").
The tasks table changes the equation: orchestration state can live on `tasks` directly instead of a coordinator
workspace + YAML. Resolving this may require a **new ADR amending 0008**.

## Research findings (R-ORCH, research ②)

The `task_dispatch` pipeline is PRODUCTION-BUILT and tested:
- `TaskDispatchExecutor` (`packages/engine/src/executors/task-dispatch.ts:27-269`) — first-class node, registered
  in `executor-factory.ts:259-268`. Two phases: `dispatchAndPause` (returns `pending_task_dispatch`, mirrors
  approval/interaction pause) + `processCompletion` (applies `output_mapping`).
- `composition-task.yaml` — `loop-subunits` (iterates, break on `$iteration >= $vars.subunit_count`) + inner
  `task_dispatch` node + `integrate` moa-swarm node.
- `TaskDispatchService` (`task-dispatch-service.ts:71-318`) — server port impl: creates child `schedules` row
  (trigger_source='requirement') + child workspace (`createFromSpec`) + `schedule_executions` (trigger_type='task_dispatch'),
  fire-and-forget start, writes `parent_task_dispatch` marker on child config, `handleChildComplete` → `resumeParent`.
- Lifecycle infra all present: pause-resume (G1), `checkQueuedTasks` claim, `MAX_PARALLEL_WORKSPACES` concurrency,
  `checkStaleClaimed` recovery, `ConsecutiveFailureTracker` + terminal `failed` promotion, SSE lifecycle, retention.

Composite dispatch path: `createJob` (materialize task_spec→WorkflowConfig, status=draft) → `enqueueJob` (draft→queued)
→ `checkQueuedTasks` claim → `WorkflowExecutor.execute` → `isCompositeTask` → coordinator-ws (projects=[]) →
`buildCompositeInputValues` → engine runs `composition-task.yaml` → Loop× task_dispatch → child ws+schedule+execution
→ child complete → resume parent → moa aggregate → `handleChainComplete` (failed-child → parent failed).

**Every task requires a workspace** (coordinator-ws with projects=[] for composite → **N+1 workspaces**).

### Option A — Reuse `task_dispatch` + WorkflowExecutor (ADR-0008 unchanged)
Pros: zero new infra (pipeline production-tested); unified execution model (tasks+workflows same engine); declarative
composition YAML; existing test suite covers it.
Cons: coordinator-ws overhead (pure orchestration ws with no git); YAML indirection (task_spec→composition-task
materialization forces orchestration through a template); rigid (sequential loop + moa only; no conditional dispatch /
subunit retry / parallel strategies / dynamic subunits); coupling to cron machinery (enabled/disabled, missed detection,
DST — irrelevant for requirement tasks; `trigger_source` branching is already a smell); no subunit-level retry
(failed subunit fails whole composition); dual-workspace cost (N+1).

### Option B — Independent task orchestration engine on `tasks` table
Pros: no coordinator-ws (orchestration state on tasks table, skip YAML+workspace indirection, eliminate N+1 → N);
task-native DAG from `task_spec.subunits[]` + `integration_goal` (conditional dispatch, parallel fan-out, subunit-level
retry, dynamic subunit discovery — no YAML changes); cross-subunit resource sharing; cleaner lifecycle (no cron
machinery, no trigger_source branching); lightweight simple tasks (direct agent call, skip workspace overhead).
Cons: rebuild ~600 LOC tested lifecycle infra (claim/concurrency/stale/retry/SSE/retention); divergent execution
models (tasks vs workflows — checkpoint/retry/observability in two places, feature-drift risk); migration of existing
composite task rows + `JobDetail` API re-impl; loss of declarative composition template (code not YAML); test gap
from zero; still must interop with SchedulerEngine for concurrency cap.

### Option C — Hybrid (recommended): tasks own lifecycle+spec+resources; delegate orchestration; conditional coordinator-ws
- `tasks` owns draft→ready→running + task_spec + resource/skill binding (the v2 core, independent of orchestration).
- Dispatch (ready→running) DELEGATES to existing `task_dispatch`/`WorkflowExecutor` — reuse all lifecycle infra (no
  600 LOC rebuild). `tasks.schedule_id`/`execution_id` written on dispatch.
- Make **coordinator-ws conditional**: skip for simple (single-subunit / no-subunit) tasks → direct workspace dispatch;
  create coordinator-ws only for genuine composite (N≥2 subunits needing engine DAG/Loop/moa). Cuts the N+1→1 for the
  common case, keeps engine orchestration for the hard case.
- Extract an orchestration-strategy seam between `tasks` and the scheduler so future task-native DAG / subunit retry
  can land incrementally WITHOUT rebuilding lifecycle infra.
- ADR-0008: **amend** (new ADR 0009) — "tasks table owns lifecycle; orchestration delegated; coordinator-ws conditional".
  Not a silent overturn; the workflow-layer principle holds for genuine composite.

## Recommendation

**C (hybrid).** ADR-0008's core argument (engine already has DAG/Loop/Swarm/moa; scheduler has none; DRY) still holds
under the tasks table — an independent engine duplicates tested infra for marginal gain. The tasks table's real win is
owning lifecycle/spec/resources and decoupling from cron, NOT rebuilding orchestration. C captures that win (clean
lifecycle, no cron coupling, no task-pool hack) while keeping tested orchestration. Coordinator-ws-conditional is the
pragmatic cut that removes the worst overhead (N+1 for simple tasks) without a 600 LOC gamble.

**When B would win instead:** if subunit-level retry or task-native conditional DAG is a hard requirement (not just
nice-to-have). If so, the 600 LOC rebuild is justified — confirm with user.

## Note on ADR

Resolving this ticket = write `docs/adr/0009-task-domain-orchestration.md` (amends 0008) if C, or a superseding ADR
if B. ADR criteria met: hard-to-reverse, surprising-without-context, real tradeoffs (A/B/C existed).
