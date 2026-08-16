# Story Walk-Through Analysis — Task Pool Redesign

> Protocol: `.claude/skills/matt-verified-requirement/references/story-walkthrough.md`
> Method: trace spec's three core stories end-to-end against actual codebase (file:line cited), flag every break point + anti-pattern.
> Scope: packages/server, packages/engine, packages/shared, packages/web-app.
> Date: 2026-08-17. Spec under test: `.scratch/task-pool-redesign/spec.md`.

## Summary Verdict

The **execution middle** of all three stories is wired today (claim → dispatch → `createFromSpec` → run → done → SSE), and the engine orchestration primitives (DAG/Loop/Swarm/moa) exist. But:

1. **The authoring half of Story A is almost entirely unbuilt** — no modal, no task-author clone, no `task_spec`, no enqueue button, no result modal. The `[+新建]` button is a placeholder toast.
2. **Story B's core mechanism (`task_dispatch` + `TaskDispatchPort` + cross-boundary await) is entirely absent** — this is the R1 risk realized: `handleChainComplete` is fire-and-forget and the engine has no primitive for a node to block on an *external* schedule. The composition-data→composition-workflow bridge is also unspecified.
3. **Story C's rollback trigger EXISTS** (setInterval + `checkStaleClaimed`, 10 min), but there is **no `failed`/`aborted` terminal status** — a failed task stays orphaned in `running`, rolls back after 10 min, and re-dispatches into an **infinite retry loop** (acknowledged in code comments). No abort API.

12 break points found: 6 CRITICAL, 6 HIGH/MEDIUM.

---

## Existing Foundations (verified wired — do NOT re-derive)

| Component | Location | Status |
|-----------|----------|--------|
| Kanban SSE subscribe + 10s poll | `web-app/app/tasks/page.tsx:54-61`, `:45-49` | ✅ wired, re-renders on event |
| `POST /jobs/:id/enqueue` (draft→queued) | `server/routes/scheduler.ts:287-289` | ✅ backend exists (frontend does NOT call it) |
| Claim loop (queued→claimed→dispatch) | `server/services/scheduler/scheduler-engine.ts:416-454` | ✅ atomic claim + rollback-on-throw |
| `createFromSpec` (ws materialization) | `workflow-executor.ts:140-149` → `services/workspace.ts` | ✅ called per dispatch |
| Run workflow + chain completion | `workflow-executor.ts:266` start; `:317` `handleChainComplete` | ✅ intra-schedule chain works |
| SSE emit `running` / `done` | `workflow-executor.ts:257-260`, `:360-363` | ✅ two transitions only |
| `checkStaleClaimed` trigger (60s tick) | `scheduler-engine.ts:117`, `:396`, `:459` | ✅ NOT a missing trigger |
| Stale rollback + release unique_active | `scheduler-engine.ts:465-477`; `schedule-config-dao.ts:155` | ✅ rolls claimed AND running |
| Engine DAG/Loop/Swarm/moa primitives | `engine/src` (`computeExecutionLevels`, `executeNodesParallel`, `MoaStrategy`, `LoopExecutor`) | ✅ exist |
| Variable substitution `$nodeId.output` | engine VarPool | ✅ exists |
| Executor DI convention | `engine/src/executor-factory.ts:31` `ExecutorFactoryContext` (`CreateSessionFn` injected) | ✅ pattern exists; `TaskDispatchPort` feasible |
| `idx_sched_execs_unique_active` | `db/schema.sql:565` | ✅ blocks multi-active under one schedule_id |

---

## Story A — Simple Task Full Chain

`/tasks [+新建]` → modal authoring (1 project + skills) → task-author produces `task_spec` → [入队] → draft→queued→claimed→createFromSpec 1 ws → run workflow_ref → done → result modal.

### Trace

```
[UI] /tasks kanban renders (page.tsx)
  │
  ├─[UI] [+新建任务] button  → page.tsx:110-116 renders Button
  │         ← BREAK A1: onClick = toast.info('…点入队') (page.tsx:112). No modal opens.
  │
  ├─[UI] TaskModal (authoring mode: spec-left / chat-right)
  │         ← BREAK A1: No TaskModal component exists anywhere (grep = 0).
  │            Current layout is a split PanelGroup (page.tsx:92-201), not a modal.
  │
  ├─[UI] project selector + skills checkboxes
  │         ← BREAK A1: does not exist.
  │
  ├─[API] task-author clone chat → produces task_spec
  │         ← BREAK A2: no 'task-author' builtin clone (BUILTIN_CLONES has only
  │            workspace/scheduler/archive/resource/harness-agent). /tasks chat
  │            calls /api/chat/global → scheduler clone + octo-scheduler SKILL
  │            (context-free, no WorkflowConfig producer). The task-pool-system-prompt
  │            (WorkflowConfig-JSON producer) is wired ONLY into chat.ts:105
  │            (purpose:'requirement'), a route /tasks never calls.
  │         ← BREAK A3: task_spec TYPE does not exist. workflowConfigSchema is v2.0
  │            (shared/types/scheduler-job.ts:63-68) with NO task_spec field.
  │            createJobSchema (scheduler-service.ts:72-92) accepts NO task_spec /
  │            project_ids / skills / workflow_ref — body is {name, job_type, config
  │            (WorkflowConfig blob), trigger_source, source_chat_session_id, …}.
  │            ⇒ task_spec has no writer.
  │
  ├─[API] POST /api/scheduler/jobs (create draft)
  │         ✅ route exists (scheduler.ts) + createJob exists (scheduler-service.ts:300).
  │         ← BREAK A4: spec's API contract {task_spec, project_ids, skills, workflow_ref?}
  │            does NOT match createJobSchema. Executor consumes config.workflow_chain
  │            (workflow-executor.ts:112-114 validates type==='workflow' && workspace_spec
  │            && workflow_chain.length), NOT task_spec. No transformer from
  │            task_spec+workflow_ref → WorkflowConfig{workflow_chain} is specified.
  │            (workflow_ref lives INSIDE each workflow_chain item, scheduler-job.ts:~41,
  │            not at top level — v1.0 top-level workflow_ref is @deprecated.)
  │            ⇒ MAGIC BRIDGE: task_spec is written but the executor never reads it.
  │
  ├─[UI] [入队] button → POST /jobs/:id/enqueue
  │         ← BREAK A5: no enqueueJob() in web-app/lib/scheduler-api.ts (grep enqueue=0).
  │            WorkflowConfigPreview is display-only (workflow-config-preview.tsx:12-74,
  │            no buttons except "重新生成" retry). TaskCard display-only (page.tsx:210-229).
  │            Backend enqueue endpoint EXISTS (scheduler.ts:287) — last-mile UI wire missing.
  │
  ├─[Exec] draft→queued→claimed  ✅ enqueueJob + checkQueuedTasks (scheduler-engine.ts:431)
  │         ← BREAK A8: no SSE emit on queued→claimed. UI sees it only via 10s poll.
  │
  ├─[Exec] claimed→running + createFromSpec 1 ws
  │         ✅ workflow-executor.ts:140-149 createFromSpec; :254-256 status='running'; SSE running (:257).
  │         ← BREAK A6: source_path="" silently fails — initWorktreesFromSpec
  │            (workspace-git.ts:97-108) uses explicit proj.source_path only, NO
  │            repos/index.md fallback on the scheduler path (the org-level
  │            initWorktrees at :20-23 DOES use index.md, but the scheduler path doesn't).
  │            Multi-repo codebase with empty source_path = broken (R4/F6).
  │
  ├─[Data] chat↔schedule link
  │         ← BREAK A7: 'taskpool-draft' sentinel auto-created as chat_session.workspace_id
  │            (scheduler.ts:201-206). FK dangling; orphan session on createJob failure.
  │
  ├─[Exec] run workflow_ref → done
  │         ✅ start (workflow-executor.ts:266) → handleChainComplete (:317) → status='done' (:356) + SSE done (:360).
  │
  └─[UI] result modal (synth report + PR links)
          ← BREAK A9: no result modal, no PR link display, no synth report view.
             Done TaskCard renders identically to all other statuses (page.tsx:210-229).
```

### Story A Break Points

| # | Sev | Anti-pattern | Description | Fix |
|---|-----|--------------|-------------|-----|
| A1 | CRITICAL | Missing Trigger | `[+新建]` is a placeholder toast (page.tsx:112); no TaskModal/authoring modal exists. | Build `TaskModal` (decisions/14 spec) + wire button to open it. |
| A2 | CRITICAL | Magic Bridge | No `task-author` clone; /tasks uses `/api/chat/global`→scheduler clone (wrong, context-free prompt). | Add `task-author` CloneDef + route + SKILL.md; route /tasks chat to it. |
| A3 | CRITICAL | Orphan Field | `task_spec` type absent (scheduler-job.ts:63 v2.0 has none); `createJobSchema` (scheduler-service.ts:72) has no task_spec/project_ids/skills/workflow_ref → no writer. | Add `TaskSpec`/`SubunitSpec` to shared; extend config v3.0 + createJobSchema. |
| A4 | HIGH | Magic Bridge | Executor reads `config.workflow_chain` (workflow-executor.ts:114), not `task_spec`; no transformer task_spec+workflow_ref → WorkflowConfig. | Define materialization: task-author emits full WorkflowConfig{workflow_chain:[{workflow_ref}]} OR add a `task_spec→WorkflowConfig` builder in createJob. |
| A5 | HIGH | Missing Trigger | No `enqueueJob()` client (scheduler-api.ts); WorkflowConfigPreview display-only. Backend endpoint exists but last-mile UI wire absent. | Add `enqueueJob()` + [入队] button in TaskModal. |
| A6 | HIGH | Silent Failure | `source_path=""` silently skipped on scheduler path (workspace-git.ts:97); multi-repo broken. | Resolve empty source_path via repos/index.md on scheduler path. |
| A7 | HIGH | Orphan Field | `taskpool-draft` sentinel as chat_session.workspace_id (scheduler.ts:201-206); FK dangling. | Drop sentinel; link chat↔schedule via source_chat_session_id only, or create a real scratch workspace. |
| A8 | MEDIUM | Unconnected Feedback | SSE emits only running/done; queued→claimed invisible to real-time (workflow-executor.ts:257,360). 10s poll mitigates. | Emit `schedule_status` on enqueue + claim transitions. |
| A9 | MEDIUM | Missing Trigger | No result modal / PR links / synth report; done TaskCard display-only. | Build done-mode in TaskModal. |

---

## Story B — Composite Task Full Chain

`/tasks [+新建]` → modal authoring → 3 subunits + `integration_goal=synthesis` → [入队] → dispatch → coordinator-ws runs composition workflow → 3× `task_dispatch` (each createFromSpec own ws + sub-workflow) → engine DAG/Loop/Swarm → moa aggregate → done → composite modal.

### Trace

```
[UI→API] authoring (subunits + integration_goal)
  │   inherits ALL of Story A breaks (A1–A5, A7). PLUS:
  │
  ├─[Data] SubunitSpec / subunits / integration_goal in config
  │         ← BREAK B-data: workflowConfigSchema v2.0 (scheduler-job.ts:63) has NO
  │            subunits/integration_goal. SubunitSpec type absent. ⇒ orphan fields.
  │
  ├─[Exec] claim composition task → createFromSpec coordinator-ws (no projects)
  │         ✅ claim→dispatch chain exists.
  │         ← BREAK B8: createFromSpec with projects=[] (coordinator has no projects)
  │            is an untested edge — initWorktreesFromSpec loops empty array
  │            (workspace-git.ts:97). Likely OK but unverified; may need a no-projects
  │            fast path in createFromSpec.
  │
  ├─[Exec] coordinator-ws runs composition workflow
  │         ✅ an engine workflow YAML can be run via workflow_chain:[{workflow_ref:'composition-wf'}].
  │         ← BREAK B5: MAGIC BRIDGE — task_spec.subunits (data) → composition workflow
  │            (engine nodes). A static "composition workflow 模板" cannot consume a
  │            dynamic N subunits without (a) a Loop over subunits, or (b) per-task
  │            workflow generation. Spec says "composition workflow 模板" in core-pack
  │            but does NOT specify how dynamic subunits map to task_dispatch nodes.
  │
  ├─[Exec] `task_dispatch` node fans out N child schedules
  │         ← BREAK B1: CRITICAL — 'task_dispatch' NodeDef type absent
  │            (shared/types/workflow.ts — 11 types, none is task_dispatch).
  │            No TaskDispatchExecutor in engine.
  │         ← BREAK B2: CRITICAL — TaskDispatchPort interface absent (shared).
  │            Magic Bridge: engine→scheduler boundary has no port. (Injection is
  │            FEASIBLE via ExecutorFactoryContext like CreateSessionFn, but unbuilt.)
  │
  ├─[Exec] cross-boundary await: task_dispatch node blocks until child schedule completes
  │         ← BREAK B3: CRITICAL (R1 realized) — handleChainComplete is fire-and-forget
  │            (workflow-executor.ts:266 "Fire and forget — don't await"). The onComplete
  │            callback (:233-247) re-enters handleChainComplete within the SAME schedule's
  │            workflow_chain (intra-schedule). The engine has NO primitive for a NODE to
  │            block on an EXTERNAL (scheduler) schedule's completion. This is the single
  │            biggest unbuilt mechanism in the design.
  │            FIX: TaskDispatchPort.dispatchChildSchedule(subunit)→ScheduleHandle +
  │            awaitCompletion(handle)→output; the TaskDispatchExecutor awaits it.
  │            Requires a completion-signaling channel from scheduler→engine (e.g. the
  │            port polls schedule status, or scheduler calls back into an injected resolver).
  │
  ├─[Exec] N distinct child schedule_ids (unique_active constraint)
  │         ← BREAK B4: idx_sched_execs_unique_active (schema.sql:565) forbids multiple
  │            active executions under one schedule_id → each subunit MUST get its own
  │            schedule_id. No code creates child schedules from within an engine node.
  │            MAX_PARALLEL_WORKSPACES=3 cap (scheduler-engine.ts:425) — task_dispatch
  │            layer must queue N>3. Unhandled.
  │
  ├─[Exec] engine DAG/Loop/Swarm orchestration
  │         ✅ computeExecutionLevels + executeNodesParallel + DispatchStrategy/buildDAG +
  │            LoopExecutor ($iteration) + SwarmExecutor all exist. CAN orchestrate
  │            task_dispatch nodes IF B1/B3 are built.
  │
  ├─[Exec] moa aggregate
  │         ✅ MoaStrategy exists (fan-out + aggregator).
  │         ← BREAK B6: MAGIC BRIDGE — MoA aggregates in-process ExpertResult[] from
  │            swarm experts, NOT cross-schedule outputs. For moa to aggregate task_dispatch
  │            child outputs: task_dispatch node must return child output via output_mapping
  │            (→ $taskDispatchNode.output), and moa must consume it. $nodeId.output
  │            substitution EXISTS, so the read path is plausible — but it is downstream
  │            of the unbuilt await bridge (B3). If B3 lands, B6 is mostly wiring.
  │
  ├─[Event] SSE parent + each child schedule_status
  │         ← BREAK B7: no parent-child schedule relationship exists today (no composite
  │            dispatch). SSE emits per-schedule running/done only. UI has no composite
  │            modal to display parent+child DAG.
  │
  └─[UI] composite modal (DAG + N child cards + integration node + real-time)
          ← BREAK B7: no composite modal, no task DAG view, no child cards. (swarm DAG
             viz exists at components/swarm/.../internal-dag-tab.tsx but is unrelated.)
```

### Story B Break Points

| # | Sev | Anti-pattern | Description | Fix |
|---|-----|--------------|-------------|-----|
| B1 | CRITICAL | Magic Bridge | `task_dispatch` NodeDef type + `TaskDispatchExecutor` absent. | Add NodeDef type `task_dispatch` (shared/types/workflow.ts) + executor (engine). |
| B2 | CRITICAL | Magic Bridge | `TaskDispatchPort` interface absent; engine→scheduler boundary has no port. | Define `TaskDispatchPort` in shared; inject impl via `ExecutorFactoryContext` (server wires at boot). |
| B3 | CRITICAL | Magic Bridge | Cross-boundary await absent (R1). `handleChainComplete` fire-and-forget (workflow-executor.ts:266); engine node cannot block on external schedule. | Port `dispatchChildSchedule→handle` + `awaitCompletion(handle)→output`; executor awaits. Need scheduler→engine completion signal (poll or callback). |
| B4 | HIGH | Missing Trigger | No code creates N child schedules from an engine node; `unique_active` (schema.sql:565) demands distinct schedule_ids; MAX_PARALLEL=3 cap unhandled in task_dispatch. | Port impl creates child schedule per subunit + concurrency queue. |
| B5 | HIGH | Magic Bridge | `task_spec.subunits` (data) → composition workflow (nodes) mapping unspecified; static template can't consume dynamic N. | Define: Loop over subunits, or per-task composition-workflow generation, or task_dispatch reads subunits from input_vars. |
| B6 | HIGH | Unconnected Feedback | MoA aggregates in-process `ExpertResult[]`, not cross-schedule outputs; needs task_dispatch output_mapping (depends on B3). | task_dispatch returns child output; moa consumes `$taskDispatchN.output`. Verify after B3. |
| B7 | MEDIUM | Unconnected Feedback | No parent-child schedule relationship; SSE per-schedule only; no composite modal. | Add parent_id/child linking on schedules + composite modal in TaskModal. |
| B8 | MEDIUM | Silent Failure | `createFromSpec` with empty projects (coordinator-ws) untested edge. | Verify/patch createFromSpec no-projects path. |

---

## Story C — Crash Recovery

claimed/running task process crashes → >10min → `checkStaleClaimed` → rollback queued.

### Trace

```
[Exec] task claimed/running, worker process crashes
  │   ✅ status set: claimed (scheduler-engine.ts:431-434), running (workflow-executor.ts:254-256).
  │
  ├─[Exec] trigger: setInterval tick (60s) → checkStaleClaimed
  │         ✅ scheduler-engine.ts:117 setInterval; :396 calls checkStaleClaimed;
  │            :460 STALE_CLAIMED_THRESHOLD_MS = 10min. NOT a Missing Trigger.
  │
  ├─[Exec] findStaleClaimed
  │         ✅ schedule-config-dao.ts:155 WHERE status IN ('claimed','running')
  │            AND claimed_at < cutoff. Includes 'running' → catches mid-execution crash.
  │
  ├─[Exec] rollback to queued + release unique_active
  │         ✅ scheduler-engine.ts:465-468 status='queued', claimed_at=null;
  │            :473 markStaleExecutionsFailed (releases idx_sched_execs_unique_active);
  │            :477 markScheduleWorkspacesCleanedBySchedule.
  │         ← BREAK C3: no SSE emit on rollback. UI sees it only via 10s poll.
  │
  ├─[Exec] re-dispatch on next tick
  │         ✅ checkQueuedTasks re-claims.
  │         ← BREAK C1: CRITICAL — ScheduleStatus (scheduler-job.ts:22) =
  │            'draft'|'queued'|'claimed'|'running'|'done'. NO 'failed'/'aborted'.
  │            The failure path (workflow-executor.ts:372-400) marks schedule_execution
  │            + schedule_workspace 'failed' but NEVER updates schedules.status (no such
  │            value). ⇒ a failed task stays orphaned in 'running' until the 10-min stale
  │            rollback, then rolls back to 'queued', then re-dispatches, then fails again
  │            → INFINITE RETRY LOOP on persistent errors (acknowledged at
  │            scheduler-engine.ts:413). No terminal failed state = Silent Failure +
  │            Missing Trigger.
  │
  ├─[UI] kanban card returns to queued
  │         ✅ via 10s poll. ✗ via SSE (no rollback emit).
  │
  └─[Exec] abort (POST /jobs/:id/abort)
          ← BREAK C2: no abort route (grep abort in scheduler.ts = 0). No 'aborted'
             status. No workspace cleanup path. Spec API contract + US15 list it.
```

### Story C Break Points

| # | Sev | Anti-pattern | Description | Fix |
|---|-----|--------------|-------------|-----|
| C1 | CRITICAL | Silent Failure + Missing Trigger | No `failed`/`aborted` in `ScheduleStatus` (scheduler-job.ts:22); failure path never updates `schedules.status` → orphaned `running` → 10-min rollback → infinite retry loop (scheduler-engine.ts:413 acknowledges). | Add `failed`/`aborted` to ScheduleStatus; set `schedules.status='failed'` in failure path; cap retry count. |
| C2 | HIGH | Missing Trigger | No `POST /jobs/:id/abort`; no `aborted` status; no workspace cleanup. | Add abort route + status + cleanup. |
| C3 | MEDIUM | Unconnected Feedback | `checkStaleClaimed` (scheduler-engine.ts:465) rolls back without SSE emit; UI catches only via 10s poll. | Emit `schedule_status` on rollback. |

---

## Anti-Pattern Tally

| Anti-pattern | Hits | Worst instance |
|--------------|------|----------------|
| **Magic Bridge** | 5 | B3 cross-boundary await — engine node cannot block on external schedule (no primitive). |
| **Orphan Field** | 3 | A3 `task_spec` written by author, never read by executor (no transformer). |
| **Silent Failure** | 2 | C1 failed task orphaned in `running`; A6 source_path="" silently skipped. |
| **Missing Trigger** | 4 | A1 no modal; A5 no enqueue wire; C1 no terminal failed; C2 no abort. |
| **Unconnected Feedback** | 3 | A8/B7/C3 SSE gaps (queued/claimed/rollback/child invisible). |
| **Unversioned State** | 1 | C1 status enum lacks failed/aborted (type vs runtime mismatch). |

---

## Highest-Leverage Fixes (before any code)

1. **B3 (CRITICAL)** — Design the cross-boundary await primitive FIRST. Without it, the entire composite path is a paper design. Decide: poll-based `awaitCompletion` in the port, or scheduler→engine callback injection. This is the spec's R1 risk, now confirmed: `handleChainComplete` (workflow-executor.ts:266/:317) is intra-schedule fire-and-forget only.
2. **C1 (CRITICAL)** — Add `failed`/`aborted` to `ScheduleStatus` + write `schedules.status` in the failure path. Without a terminal failed state, every persistent workflow error becomes an infinite retry loop.
3. **A3+A4 (CRITICAL/HIGH)** — Decide the task_spec↔WorkflowConfig materialization. Either the task-author emits a full WorkflowConfig (workflow_chain embedded) and task_spec is pure metadata, OR a builder transforms task_spec+workflow_ref→WorkflowConfig. The executor (workflow-executor.ts:114) reads `workflow_chain`, period — this must be reconciled.
4. **B5 (HIGH)** — Specify how dynamic `subunits[]` map to `task_dispatch` nodes in a static composition-workflow template (Loop? per-task generation? input_vars-driven?). Currently unspecified.

## What Already Forms a Closed Loop

- **Simple-task execution middle**: enqueue(draft→queued) → checkQueuedTasks(queued→claimed) → dispatch → createFromSpec → run → handleChainComplete(running→done) → SSE(done) → UI re-render. (Once A5 enqueue wire + A6 source_path are fixed, the execution half of Story A closes.)
- **Crash recovery trigger + rollback**: setInterval → checkStaleClaimed → rollback queued + release unique_active. (C1/C3 are refinements, not blockers, for the happy rollback case — the *re-dispatch* loop is the real danger.)
