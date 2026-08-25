# Story Walk-Through Analysis — Task Domain Redesign v2

> Protocol: `.claude/skills/matt-verified-requirement/references/story-walkthrough.md`
> Spec under review: `.scratch/task-domain-redesign/spec.md`
> Reviewer ran against post-PR-#50 code state on `test-task-board` branch.
> All file:line citations verified against real code.

## Executive Summary

**The spec is largely sound at the decision level** — every claimed insertion/extension seam I was asked to verify actually exists in code at approximately the cited location (clone/index.ts:406, scheduler-service.ts:154/492/857, workflow-executor.ts:142/490, task-dispatch.ts:27, pi-sdk-adapter.ts:99-112, prompt-enhancer.ts:6, resource-provisioner.ts:64, TaskDispatchPort, composition-task.yaml, task-author SKILL.md). The v2 architecture (first-class `tasks` table + deterministic autosave + spec↔agent linkage + ADR-0009 hybrid orchestration) is coherent and the inherited v1 decisions are correctly carried forward.

**However, the spec undersells several integration gaps** that will block or degrade the stories mid-flow. The most consequential are NOT missing seams (those exist) but **missing writers** (fields claimed but no code path populates them) and **missing triggers** (automatic transitions with no scheduler/event to fire them). Six HIGH-severity break points need spec-level fixes before pipeline execution; eight MEDIUM issues can be addressed during implementation. No CRITICAL blockers — the architecture is recoverable with the fixes below.

The 6 anti-patterns manifest as follows:
- **Magic Bridge**: `config.requires` (spec claim) doesn't exist on `WorkflowConfig`; reverse context-msg injection assumes the Claude SDK accepts synthetic messages without verifying; `task_status` SSE on `/api/tasks/events` has no emitter bridging from `schedule_status`.
- **Orphan Field**: `sessions.scope_id → tasks.id` retarget has no defined writer; `tasks.status` lifecycle transitions (`ready→running→done`) have no writer.
- **Silent Failure**: not prominent — most paths have error handling.
- **Missing Trigger**: `checkQueuedTasks` filter (`trigger_source==='requirement'`) will reject v2 schedules; orphan reaper has no schedule.
- **Unversioned State**: autosave vs `update_task_spec_field` version coordination is asserted "无竞态" but DAO-level interaction is unspecified.
- **Unconnected Feedback**: `enhancePromptWithSkills` is dead code (never called in production) — the spec frames it as wired to `pi-sdk-adapter`, but an orchestration layer is missing.

---

## Verified Seams (spec claims that match code)

| Spec Claim | Code Evidence | Verdict |
|---|---|---|
| Autosave seam at `clone/index.ts:406` (after auto-title, before done SSE) | `packages/server/src/routes/clone/index.ts:402-415` — auto-title block at 402-406, `writeSSE(done)` at 408-415. Seam has access to `cloneName`, `sessionId`, `session`, `body.message`, `fullContent`. | ✅ EXACT match |
| `materializeTaskSpecToConfig` at scheduler-service.ts:154-189 | `packages/server/src/services/scheduler/scheduler-service.ts:154-189` — exists, signature `(task_spec, project_ids, org, workflow_ref?, skills?) → WorkflowConfig`. | ✅ exists (but see BREAK C3/A7 — doesn't handle resources, file-private, embeds task_spec) |
| `createJob` at ~492 | scheduler-service.ts:492 — writes v1 columns (trigger_source, source_chat_session_id) only. | ✅ |
| `enqueueJob` at ~857 | scheduler-service.ts:857 — `draft→queued` for `trigger_source==='requirement'` only. | ✅ |
| `trigger_source==='requirement'` branch (v1 hack to remove) | scheduler-service.ts:249 (schema), 527-530 (status derivation), 864 (enqueue guard); scheduler-engine.ts:448 (claim filter) | ✅ exists in multiple places |
| `TaskDispatchService` + `dispatchChildSchedule` + `handleChildComplete` | `packages/server/src/services/scheduler/task-dispatch-service.ts` — all exist. | ✅ |
| `isCompositeTask` at workflow-executor.ts:142-170 | Method at `workflow-executor.ts:490-497`; call site at line 142; ws creation at 155-170. | ✅ (method defined at 490, not 142 — spec's line ref is the call site) |
| `TaskDispatchExecutor` + pause-resume | `packages/engine/src/executors/task-dispatch.ts:27` — class exists. Pause-resume is a **two-invocation state-machine pattern** (`pending_task_dispatch` + `engine.retryFrom`), NOT in-memory suspend. | ✅ (mechanism is more complex than spec implies) |
| `getSystemPrompt` override at pi-sdk-adapter.ts:99-112 | `packages/providers/src/pi/pi-sdk-adapter.ts:99-112` — monkey-patch on `resourceLoader`, per-session, appends `opts.systemPrompt`. | ✅ EXACT match |
| `enhancePromptWithSkills` in prompt-enhancer.ts | `packages/providers/src/pi/prompt-enhancer.ts:6-23` — exists, pure string concatenator. | ✅ exists BUT **DEAD CODE** — never called in production (only `parseVarsUpdate` imported from this file). See BREAK C2. |
| `directCopy` from `installPath` in resource-provisioner | `packages/shared/src/resource/resource-provisioner.ts:64-117` — exists. Reads `entry.installPath` from `ResourceManager` registry. | ✅ (lives in `@octopus/shared`, not `@octopus/server` — server file is re-export only) |
| Global install path `~/.octopus/resources/installed/` | `resource-manager.ts:58` (basePath) + `869-880` (hierarchical: `installed/{type}s/{group}/{name}/`). | ✅ (hierarchical, not flat) |
| `/api/resources` route | `server/src/index.ts:459`; 11+ endpoints in `routes/resource/index.ts`. | ✅ |
| `schedules` table at schema.sql:264 | `packages/server/src/db/schema.sql:264-296` — has status/trigger_source/source_chat_session_id/claimed_at/job_type/config/workspace_id/max_retain/version/cron_expression. NO origin_type/origin_id/origin_role/assoc_meta. | ✅ matches spec's "add" claim |
| `sessions.scope_id` at schema.sql:380 | `schema.sql:380-394` — `scope_id TEXT` exists. Currently set to `schedules.id` (scheduler.ts:259). | ✅ field exists; retarget claim has no writer (see BREAK A2) |
| `TaskDispatchPort` interface | `packages/shared/src/types/task-dispatch-port.ts:28` — has `dispatchChildSchedule(subunit)` + `resumeOnCompletion(handle, output)`. NO `origin_role` param. | ✅ exists (but see BREAK B3) |
| `composition-task.yaml` | `packages/core-pack/workflows/composition-task.yaml` — Loop+task_dispatch+moa. Confirmed. | ✅ |
| task-author SKILL.md teaches curl /api/scheduler/jobs | `packages/core-pack/skills/task-author/SKILL.md` — currently teaches `curl /api/scheduler/jobs` + `trigger_source: "requirement"`. | ✅ (spec's "改调 /api/tasks" is a real change) |

---

## Story A: Simple Task Full Path

```
/tasks [+新建]
  │
  ├─[UI] TaskModal authoring mode opens (task-modal.tsx:102 AuthoringMode)
  │         ← BREAK A1 [HIGH]: TaskModal currently requires a SchedulerJob prop.
  │            Spec API returns Task. Who creates the initial tasks row on [+新建]?
  │            Autosave only fires after first turn. Before first message, no
  │            tasks row exists → SpecPanel can't render. Spec must define:
  │            TaskModal calls POST /api/tasks on open (returns Task with
  │            status=draft, source_chat_session_id=null), THEN creates
  │            task-author session with scope_id=task.id.
  │
  ├─[UI→API] User types "早上好，做 X" → useAgentChat.sendMessage
  │            → POST /api/clones/task-author/sessions/:id/chat (SSE)
  │            (clone/index.ts:242 route, apiOverrides in task-modal.tsx:167-174)
  │
  ├─[Exec] CloneRuntime.chat() streams text + tool_call events
  │
  ├─[Exec] Tool: update_task_spec_field(goal=...) — NEW tool handler
  │         → tasks DAO patch task_spec.goal, bump version
  │         → emit spec_field_update SSE {task_id,field,value,version}
  │         ← BREAK A4 [MEDIUM]: tool writes version; autosave (next step) writes
  │            updated_at on the same row. Spec R2 claims "无竞态" — correct for
  │            spec FIELDS (autosave doesn't touch task_spec) but DAO must use
  │            targeted UPDATE (title column only) to avoid clobbering version
  │            via a full-row update trigger. Spec should explicitly state:
  │            "autosave UPDATEs title + updated_at columns only; does NOT
  │            bump version, does NOT touch task_spec/resources/authoring_resources."
  │
  ├─[Exec] Turn-end → clone/index.ts:406 autosave seam
  │         (cloneName==='task-author' gate; after auto-title block 402-406,
  │          before done SSE 408-415)
  │         → UPSERT tasks row (status=draft, source_chat_session_id=sessionId,
  │            title=autoTitle, org=session.org)
  │         ← BREAK A2 [HIGH]: sessions.scope_id → tasks.id retarget has NO WRITER.
  │            The autosave seam creates the tasks row but doesn't update
  │            sessions.scope_id. Spec claims "sessions.scope_id→tasks.id" but
  │            no code path sets it. Orphan Field anti-pattern.
  │            FIX: autosave seam, after creating tasks row, MUST call
  │            agentSessionDAO.updateSession(sessionId, { scope_id: task.id }).
  │            Add to spec Implementation Decisions + AC.
  │
  ├─[UI] SpecPanel subscribes to /api/tasks/events SSE → spec_field_update
  │         → setGoal(value), setVersion(version)
  │         ← BREAK A5 [MEDIUM]: TaskModal data layer is entirely SchedulerJob-based
  │            (task-modal.tsx:17 imports SchedulerJob; SpecPanel seeds from
  │            job.config.task_spec at line 318). v2 needs Task type + new
  │            tasks-api.ts lib + SpecPanel SSE subscription. Scope ack, not a break.
  │
  ├─[UI→API] User edits SpecPanel + [保存草稿]
  │           → PUT /api/tasks/:id with If-Match: version
  │           → tasks DAO update task_spec, bump version
  │           → reverse context msg: inject @@spec_updated:<field>=<value>
  │             into task-author session (next turn agent sees user override)
  │         ← BREAK A6 [HIGH]: reverse context msg mechanism UNDEFINED.
  │            Spec says "注入 @@spec_updated 到 task-author session" but
  │            doesn't specify HOW. The Claude SDK session has provider_session_id
  │            (resume-based). Injecting a synthetic message into the messages
  │            table (source='spec_override') may NOT be picked up by SDK resume
  │            (which uses provider_session_id, not local messages). Magic Bridge.
  │            FIX: spec must define either (a) insert a messages row with
  │            source='spec_override' AND verify SDK resume reads it, OR
  │            (b) prepend @@spec_updated to next user message at send time
  │            (server-side intercept in clone chat route), OR
  │            (c) use SDK's system prompt override (pi-sdk-adapter.ts:99)
  │            to inject @@spec_updated as a system-level note.
  │            Verify with a spike BEFORE pipeline execution.
  │
  ├─[UI→API] [入队] → POST /api/tasks/:id/ready
  │           → tasks.status: draft→ready (confirm gate)
  │           → dispatch seam (NEW) creates schedules envelope:
  │             simple = 1 schedule(origin_type='task', origin_role='primary',
  │             status='queued', config=materializeTaskSpecToConfig)
  │         ← BREAK A7 [HIGH]: materializeTaskSpecToConfig is FILE-PRIVATE
  │            (scheduler-service.ts:154, no `export` keyword). Dispatch seam
  │            (new code) can't call it. FIX: export it, OR move dispatch seam
  │            INTO scheduler-service.ts, OR move materializeTaskSpecToConfig
  │            to a shared util.
  │         ← BREAK A7b [HIGH]: materializeTaskSpecToConfig EMBEDS task_spec in
  │            config (line 181: `task_spec,`). v2 says "schedules 清掉
  │            config.task_spec". Contradiction: dispatch seam calls a function
  │            that produces config WITH task_spec, but spec says schedules
  │            should NOT carry task_spec. FIX: materializeTaskSpecToConfig
  │            must be modified to drop task_spec from output config (task_spec
  │            lives in tasks table now), OR the spec must clarify what
  │            "config.task_spec removed" means for the materialize function.
  │         ← BREAK A8 [HIGH]: checkQueuedTasks (scheduler-engine.ts:444-488)
  │            filters `trigger_source === 'requirement'` at line 448. v2
  │            REMOVES trigger_source. New schedules (origin_type='task',
  │            no trigger_source) will NEVER be claimed. Spec's "runner认领
  │            schedules 'queued' 不变" is INCORRECT. FIX: spec must explicitly
  │            amend scheduler-engine.ts:448 filter to either drop the
  │            trigger_source filter (claim ALL queued) OR replace with
  │            `origin_type IN ('task','manual','api')`. Add to Implementation
  │            Decisions + AC.
  │
  ├─[Exec] scheduler-engine.ts checkQueuedTasks polls → claims schedule
  │         (status: queued→claimed→running)
  │         → workflow-executor.createFromSpec (line 155) creates ws + runs workflow
  │         ← BREAK A9 [HIGH]: tasks.status: ready→running has NO WRITER.
  │            The runner (scheduler-engine + workflow-executor) only writes
  │            schedules.status. No callback propagates schedules.status='running'
  │            → tasks.status='running'. Missing Trigger anti-pattern.
  │            Same for schedules.status='done' → tasks.status='done'.
  │            FIX: spec must define a bridge — either:
  │            (a) dispatch seam registers a schedule-status listener that
  │                updates tasks.status on schedule transitions, OR
  │            (b) workflow-executor/scheduler-engine call a
  │                TaskLifecycleCallback.onScheduleStatusChange(taskId, status)
  │                that maps schedule status → task status, OR
  │            (c) a new background reaper reconciles tasks.status from
  │                schedules.status periodically (latency tradeoff).
  │            Recommend (a) — server-side listener pattern, mirrors existing
  │            schedule change listeners in scheduler-service.
  │
  ├─[Event] SSE task_status: running on /api/tasks/events
  │         ← BREAK A9b [HIGH]: task_status SSE has NO EMITTER. Scheduler
  │            emits schedule_status SSE on /api/scheduler/events. Spec wants
  │            task_status on /api/tasks/events. No bridge exists. Magic Bridge.
  │            FIX: the schedule-status listener (BREAK A9 fix) should also
  │            emit task_status SSE on the /api/tasks/events channel. Add AC.
  │
  ├─[Exec] workflow completes → schedules.status: done
  │         → tasks.status: done (BREAK A9 — no writer)
  │         → SSE task_status: done (BREAK A9b — no emitter)
  │
  └─[UI] DoneMode renders (task-modal.tsx:775) — currently reads job.last_execution
           error_summary. v2 needs TaskDetail with execution summary + PR links.
           (Scope ack — web-app rewrite.)
```

---

## Story B: Composite Task Full Path

```
/tasks → open composite draft → edit 3 subunits + integration_goal
  │
  ├─[UI] SubunitsEditor (task-modal.tsx:481-503)
  │         ← BREAK B1 [MEDIUM]: SubunitsEditor currently only edits
  │            name/workflow_ref/skills (lines 491-497). Does NOT edit
  │            workspace_spec (required in subunitSpecSchema) or resources[]
  │            (v2 NEW field). v2 SubunitSpec extension (+resources[]) needs
  │            UI: add resources picker per subunit. Scope ack, document in spec.
  │
  ├─[UI→API] [入队] → POST /api/tasks/:id/ready
  │           → dispatch seam creates coordinator schedule:
  │             origin_type='task', origin_role='coordinator',
  │             workflow_ref='composition-task', status='queued',
  │             config=materializeTaskSpecToConfig (with composition-task wf_ref)
  │         ← BREAK B2 [HIGH]: materializeTaskSpecToConfig must produce config
  │            WITHOUT task_spec (BREAK A7b) BUT WITH composition-task workflow_ref
  │            + subunit_count variable injected. Currently the function embeds
  │            task_spec (line 181) and uses COMPOSITION_WF_REF='composition-task'
  │            (line 148). v2 needs: drop task_spec from config output, keep
  │            workflow_chain[0].workflow_ref='composition-task', inject
  │            input_values.subunit_count = task_spec.subunits.length.
  │            Spec should explicitly list the materializeTaskSpecToConfig
  │            changes (it's not "use existing seam" — it's MODIFY existing seam).
  │
  ├─[Exec] runner claims coordinator schedule → workflow-executor.createFromSpec
  │         (line 155-170, isComposite=true → projects=[] → coordinator-ws)
  │         → runs composition-task.yaml
  │         ← BREAK B3 [MEDIUM]: isCompositeTask (line 490-497) uses
  │            `subunits.length >= 1` threshold. Spec wants "简单/单 subunit
  │            跳过 coordinator-ws" implying N≥2 for coordinator-ws.
  │            A 1-subunit task currently gets coordinator-ws treatment.
  │            FIX: spec must explicitly state the threshold change:
  │            `isCompositeTask` → `subunits.length >= 2` (not `>= 1`), OR
  │            the dispatch seam materializes 1-subunit as simple workflow_chain.
  │            Add to Implementation Decisions.
  │         (Note: workflow-executor ALWAYS creates a workspace at line 157 —
  │          there's no "skip ws entirely" path. The spec's "直分发（跳
  │          coordinator-ws）" means "use regular-projects ws, not empty-projects
  │          coordinator-ws" — the existing isComposite=false path does this.
  │          No NEW "no-ws" path needed for simple tasks. Spec wording is
  │          ambiguous but coherent once clarified.)
  │
  ├─[Exec] composition-task.yaml Loop× task_dispatch
  │         → engine TaskDispatchExecutor.dispatchAndPause (task-dispatch.ts:60)
  │         → port.dispatchChildSchedule(subunit)
  │         → TaskDispatchService creates child schedule
  │         ← BREAK B4 [HIGH]: TaskDispatchPort.dispatchChildSchedule(subunit)
  │            has NO origin_role param. TaskDispatchService impl must set
  │            origin_type='task', origin_role='subunit', origin_id=parent_task_id
  │            internally when creating child schedules. Also: TaskDispatchService
  │            currently creates child schedules via v1 trigger_source='requirement'
  │            path (which v2 removes). Port impl needs rewriting to use
  │            origin_type/origin_id/origin_role. Spec doesn't explicitly call
  │            out this internal change. FIX: add to Implementation Decisions:
  │            "TaskDispatchService.dispatchChildSchedule rewritten to create
  │            child schedules with origin_type='task', origin_role='subunit',
  │            origin_id=parent_task_id (not trigger_source='requirement')."
  │         ← BREAK B5 [HIGH]: checkQueuedTasks filter (same as A8) — child
  │            schedules (origin_type='task') won't be claimed. Same fix.
  │
  ├─[Exec] child schedule claimed → child ws created → sub-workflow runs
  │         → schedules.status (child): queued→claimed→running→done
  │         → SSE schedule_status (child) on /api/scheduler/events
  │         ← BREAK B6 [MEDIUM]: task-dispatch-service does NOT emit `running`
  │            SSE transition when a child schedule starts. Only queued + done/
  │            failed transitions emit. Spec AC#9 asserts "全转换点". Either:
  │            (a) add running SSE emission in TaskDispatchService, OR
  │            (b) relax AC#9 to "queued + done/failed/aborted transitions".
  │            Composite UI (CompositeMode:562) shows child status dots —
  │            without running emission, children show queued→done with no
  │            running intermediate. UX degradation.
  │
  ├─[Exec] child completes → TaskDispatchService.handleChildComplete
  │         → engine.retryFrom → TaskDispatchExecutor.processCompletion
  │         → output_mapping applied to parent VarPool
  │         → composition loop resumes (next iteration or break)
  │         (mechanism: two-invocation state-machine, NOT in-memory suspend —
  │          parent wf is persisted + re-entered via retryFrom. Spec's
  │          "pause-resume" framing is a simplification, not a break.)
  │
  ├─[Exec] all subunits done → moa aggregation (integrate node, swarm moa)
  │         → coordinator schedule status: done
  │         → tasks.status: done (BREAK A9 — no writer)
  │
  └─[UI] CompositeMode renders (task-modal.tsx:562) — reads JobDetail.children
           + dag. v2 needs TaskDetail.children (via schedules.origin lookup) + dag.
           ← BREAK B7 [LOW]: CompositeMode child click → router.push(
           `/scheduler/jobs/${scheduleId}`) (line 641). Retarget to
           /tasks/:id/children/:scheduleId or /tasks/:id?child=scheduleId.
           Scope ack.
```

---

## Story C: Draft Autosave + Spec Linkage + Resource Loading

```
早上好对话
  │
  ├─[Exec] turn-end autosave (clone/index.ts:406) → creates tasks row
  │         (Story A steps 1-3 — same BREAKs A1, A2, A4)
  │
  ├─[Exec] agent update_task_spec_field(goal/ac/projects/skills)
  │         → SpecPanel live-refresh via spec_field_update SSE
  │         (Story A steps 4-5 — same BREAKs A4, A5)
  │
  ├─[Exec] agent load_resource_for_authoring(octo-backend)
  │         → tasks.authoring_resources[] updated (NEW tool)
  │         → server reads SKILL.md from global installPath
  │           (~/.octopus/resources/installed/skills/{group}/{name}/SKILL.md)
  │         → inject into task-author session prompt via
  │           pi-sdk-adapter.ts:99-112 getSystemPrompt override +
  │           prompt-enhancer.ts enhancePromptWithSkills
  │         ← BREAK C1 [HIGH]: MID-SESSION resource injection mechanism UNDEFINED.
  │            pi-sdk-adapter createSession (line 84) is called ONCE per session.
  │            The getSystemPrompt monkey-patch (line 99-112) captures
  │            opts.systemPrompt at session creation time. To inject NEW
  │            authoring_resources[] MID-SESSION (agent adds a resource during
  │            chat), you'd need to either:
  │            (a) call _rebuildSystemPrompt (line 106-111) after updating the
  │                captured systemPrompt closure — but the closure is frozen
  │                at createSession time, OR
  │            (b) recreate the session (loses context + provider_session_id), OR
  │            (c) the load_resource_for_authoring tool handler, on the NEXT
  │                turn, re-reads authoring_resources[] and re-injects (the spec's
  │                "重开 draft 重载 authoring_resources[]" suggests this path).
  │            Spec says "agent 可现场 加载" (mid-session) but the mechanism
  │            for mid-session injection is unclear. RECOMMEND: spec should
  │            clarify that mid-session injection happens via (c) — each new
  │            turn's prompt is rebuilt from current authoring_resources[]
  │            before sending to SDK. This requires the clone chat route to
  │            re-read authoring_resources[] and call _rebuildSystemPrompt
  │            at the start of each turn. Verify SDK accepts prompt rebuild
  │            mid-session via a spike.
  │         ← BREAK C2 [MEDIUM]: enhancePromptWithSkills is DEAD CODE.
  │            prompt-enhancer.ts:6-23 defines it, but NO production code calls
  │            it (only `parseVarsUpdate` is imported from this file by
  │            provider.ts:11). Spec frames "pi-sdk-adapter:99-112 +
  │            prompt-enhancer 注入" as if wired — but an ORCHESTRATION LAYER
  │            is missing. FIX: spec should acknowledge this is NEW code:
  │            "new TaskAuthorSessionAugmenter service that: (1) reads
  │            tasks.authoring_resources[], (2) resolves installPaths via
  │            ResourceManager, (3) reads SKILL.md content, (4) calls
  │            enhancePromptWithSkills, (5) passes result to pi-sdk-adapter
  │            createSession as opts.systemPrompt (or rebuilds mid-session)."
  │            Add to Implementation Decisions.
  │
  ├─[UI] user resource picker (NEW) → selects resources → tasks.resources[]
  │         (workspace-scope, → workflow.requires)
  │         ← BREAK C4 [MEDIUM]: resource picker UI doesn't exist. SkillsSelector
  │            (task-modal.tsx:441) lists installed skills but writes to
  │            `skills` field (decorative). v2 needs a picker that writes to
  │            tasks.authoring_resources[] (draft-scope) AND tasks.resources[]
  │            (workspace-scope) with user-chosen scope. Scope ack.
  │
  ├─[UI→API] [保存草稿] → PUT /api/tasks/:id → reverse @@spec_updated
  │           (Story A step 6 — same BREAK A6)
  │
  └─[UI→API] [入队] → ready → dispatch seam
           → materializeTaskSpecToConfig propagates tasks.resources[] /
             subunit.resources[] to config.requires
           → EngineInitPhase + ResourceProvisioner provision to ws
           ← BREAK C3 [HIGH]: materializeTaskSpecToConfig does NOT propagate
  │            resources[] to config.requires (confirmed: function has zero
  │            resources/requires handling). AND `config.requires` is NOT A
  │            REAL FIELD on WorkflowConfig (scheduler-job.ts:105-112 has
  │            schema_version/type/workspace_spec/workflow_chain/max_retain/
  │            task_spec — no `requires`). The `requires` field exists on
  │            WorkflowDef (workflow.ts:509) — the workflow YAML definition,
  │            NOT the schedule config. EngineInitPhase reads workflow.requires
  │            (from parsed WorkflowDef), not config.requires (from schedule).
  │            Magic Bridge + Orphan Field.
  │            FIX: spec must define ONE of:
  │            (a) Add `requires` field to WorkflowConfig schema
  │                (shared/src/types/scheduler-job.ts workflowConfigSchema),
  │                populate from tasks.resources[]/subunit.resources[] in
  │                materializeTaskSpecToConfig, AND modify EngineInitPhase to
  │                merge config.requires into workflow.requires before
  │                provisioning. (Most coherent.)
  │            (b) Pass resources as input_values.resources and have the
  │                workflow's first node provision them (entangles workflow
  │                with provisioning).
  │            (c) Dispatch seam writes resources to a separate sidecar table
  │                (over-engineering).
  │            Recommend (a). Add to Data Model Changes: "WorkflowConfig
  │            +requires?: {skills, agent_files, commands, rules} (mirrors
  │            WorkflowDef.requires)". Add to Implementation Decisions:
  │            "materializeTaskSpecToConfig extended to propagate
  │            tasks.resources[] + subunit.resources[] → config.requires."
  │            Add AC: "composite task with subunit.resources → child ws
  │            .claude/skills/ contains provisioned resources."
```

---

## Break Points Grouped by Severity

### CRITICAL (story cannot proceed — execution blocks)
*None.* All seams exist; all gaps are fixable with spec-level additions.

### HIGH (story proceeds but produces wrong/incomplete results — must fix before spec finalized)

| # | Title | Spec Claim that Breaks | Code Evidence | Recommended Fix |
|---|---|---|---|---|
| A2 | sessions.scope_id retarget has no writer | "sessions.scope_id→tasks.id" (Data Model Changes, Implementation Decisions) | scheduler.ts:259 sets scope_id=job.id (v1); clone/index.ts:187,196 accepts scope_id from body. No code path in v2 sets scope_id=tasks.id. | Add to Implementation Decisions: "autosave seam (clone/index.ts:406) and POST /api/tasks both call agentSessionDAO.updateSession(sessionId, {scope_id: task.id}) after creating tasks row." Add AC: "after first turn, sessions.scope_id matches tasks.id." |
| A6 | Reverse context msg mechanism undefined | "注入 `@@spec_updated: <field>=<value>` 到 task-author session" (Implementation Decisions, v2-D7) | Claude SDK session uses provider_session_id for resume (clone/index.ts:398). Injecting a messages row with source='spec_override' may not be read by SDK resume. | Add to Implementation Decisions: define mechanism — (a) server-side intercept at clone chat route start: prepend @@spec_updated to next user message, OR (b) verify SDK reads messages with source='spec_override' via spike, OR (c) use pi-sdk-adapter system prompt override to inject @@spec_updated as system note. Recommend (a). Add AC + spike. |
| A7 | materializeTaskSpecToConfig is file-private | "config=materializeTaskSpecToConfig" (dispatch seam, Implementation Decisions) | scheduler-service.ts:154 — no `export` keyword. Only called internally by createJob (503) + updateJob (690). | Add to Implementation Decisions: "export materializeTaskSpecToConfig from scheduler-service OR move to shared util OR implement dispatch seam inside scheduler-service." |
| A7b | materializeTaskSpecToConfig still embeds task_spec (contradicts schedules cleanup) | "schedules 清掉 config.task_spec" (Implementation Decisions, v2-D10) | scheduler-service.ts:181 — `task_spec,` written into config output. | Add to Implementation Decisions: "materializeTaskSpecToConfig MODIFIED to drop task_spec from output config (task_spec lives in tasks table; schedules no longer carry it)." Add AC: "schedules.config has no task_spec field post-dispatch." |
| A8/B5 | checkQueuedTasks trigger_source filter not amended | "runner 认领 schedules 'queued' 不变" (Implementation Decisions, dispatch seam) | scheduler-engine.ts:448 — `if ((schedule.trigger_source ?? 'cron') !== 'requirement') continue`. v2 removes trigger_source. New schedules (origin_type='task') won't be claimed. | Add to Implementation Decisions: "scheduler-engine.ts:448 filter amended to `origin_type IN ('task','manual','api')` (or drop filter entirely)." Correct the "不变" claim. Add AC: "schedules with origin_type='task' and status='queued' are claimed by runner." |
| A9 | tasks.status lifecycle transitions have no writer | "ready→running（runner 认领）→ done/failed/aborted" (User Stories 8, v2-D2) | scheduler-engine.ts + workflow-executor.ts write ONLY schedules.status. No callback propagates to tasks.status. | Add to Implementation Decisions: "dispatch seam registers a ScheduleStatusListener that maps schedule status → tasks.status (queued/claimed→running, done→done, failed→failed, aborted→aborted) and emits task_status SSE on /api/tasks/events." Add AC: "schedule status transition → tasks.status transition within 1s." |
| A9b | task_status SSE on /api/tasks/events has no emitter | "GET /api/tasks/events SSE task_status / spec_field_update" (API Contracts) | Scheduler emits schedule_status on /api/scheduler/events. No bridge to /api/tasks/events. | Folded into A9 fix: the ScheduleStatusListener also emits task_status SSE. spec_field_update SSE emitted by update_task_spec_field tool handler (already defined). Add AC. |
| B2 | materializeTaskSpecToConfig changes for composition-task config | "composite=coordinator schedule...+composition-task.yaml" (dispatch seam) | scheduler-service.ts:148 uses COMPOSITION_WF_REF='composition-task'; line 181 embeds task_spec. Needs: drop task_spec, inject subunit_count variable. | Folded into A7b fix + add: "materializeTaskSpecToConfig injects input_values.subunit_count = task_spec.subunits.length for composite tasks." |
| B4 | TaskDispatchService.dispatchChildSchedule uses v1 trigger_source path | "task_dispatch fan-out N 子(origin_role='subunit')" (dispatch seam) | TaskDispatchPort (shared/src/types/task-dispatch-port.ts:28) has no origin_role param. TaskDispatchService impl creates child schedules via v1 path. | Add to Implementation Decisions: "TaskDispatchService.dispatchChildSchedule REWRITTEN to create child schedules with origin_type='task', origin_role='subunit', origin_id=parent_task_id (replaces trigger_source='requirement')." |
| C1 | Mid-session resource injection mechanism undefined | "agent 可现场 加载已安装非-cwd 资源" (User Story 5, v2-D8) | pi-sdk-adapter.ts:84 createSession called once per session; getSystemPrompt closure captures opts.systemPrompt at creation time. | Add to Implementation Decisions: "clone chat route (clone/index.ts:242) re-reads tasks.authoring_resources[] at the START of each turn, resolves SKILL.md content via ResourceManager, calls _rebuildSystemPrompt (pi-sdk-adapter.ts:106) to re-inject before SDK call." Add AC + spike to verify SDK accepts mid-session prompt rebuild. |
| C3 | config.requires is not a real field; materializeTaskSpecToConfig doesn't propagate resources | "materializeTaskSpecToConfig 把 tasks.resources[]/subunit.resources[] 传播到 config.requires → EngineInitPhase+ResourceProvisioner 分发" (Implementation Decisions, v2-D8) | scheduler-job.ts:105-112 (WorkflowConfig) has NO `requires` field. workflow.ts:509 (WorkflowDef) HAS `requires: {skills, agent_files, commands, rules}`. EngineInitPhase reads workflow.requires, not config.requires. materializeTaskSpecToConfig has zero resources handling. | Add to Data Model Changes: "WorkflowConfig +requires?: {skills, agent_files, commands, rules} (mirrors WorkflowDef.requires)". Add to Implementation Decisions: "materializeTaskSpecToConfig EXTENDED to propagate tasks.resources[]/subunit.resources[] → config.requires; EngineInitPhase MODIFIED to merge config.requires into workflow.requires before provisioning." Add AC. |

### MEDIUM (story works but UX degraded — document in spec, fix during implementation)

| # | Title | Spec Claim | Code Evidence | Fix |
|---|---|---|---|---|
| A4 | autosave version/updated_at coordination | R2 "无竞态" | Tool bumps version; autosave writes updated_at on same row. Correct for spec fields but DAO must use targeted UPDATE. | Spec explicitly: "autosave UPDATEs title+updated_at columns only; does NOT bump version, does NOT touch task_spec/resources." |
| B3 | isCompositeTask threshold N≥1 vs spec's N≥2 | "简单/单 subunit 跳过 coordinator-ws" + "复合 N≥2" (v2-D9, dispatch seam) | workflow-executor.ts:491 — `subunits?.length` (N≥1 = composite). | Spec explicitly: "isCompositeTask threshold changed to `subunits.length >= 2`; 1-subunit tasks materialize as simple workflow_chain." |
| B6 | SSE running transition not emitted for children | AC#9 "全转换点" | task-dispatch-service emits queued + done/failed, NOT running for child start. | Either add running SSE emission in TaskDispatchService, OR relax AC#9 to "queued + terminal transitions". |
| C2 | enhancePromptWithSkills is dead code | "pi-sdk-adapter:99-112 + prompt-enhancer 注入" (Implementation Decisions, v2-D8) | prompt-enhancer.ts:6-23 defined but NEVER called in production. provider.ts:11 imports only parseVarsUpdate. | Spec acknowledge: "NEW TaskAuthorSessionAugmenter service wires ResourceManager → read SKILL.md → enhancePromptWithSkills → pi-sdk-adapter systemPrompt." |
| R-INT-reaper | Orphan reaper has no trigger | "孤儿 reaper" (R-INT mitigation) | cascade-reap on DELETE is concrete; reaper has no schedule/cron. | Spec define: "orphan reaper runs every N minutes (cron), scans schedules WHERE origin_type='task' AND origin_id NOT IN (SELECT id FROM tasks WHERE deleted_at IS NULL), deletes orphans." Add AC. |
| B1 | SubunitsEditor doesn't edit resources[]/workspace_spec | v2-D13 "two persisted scopes" | task-modal.tsx:481-503 — only name/workflow_ref/skills. | Add AC: "SubunitsEditor renders resources picker per subunit." Scope ack. |
| A5 | TaskModal data layer coupled to SchedulerJob | web-app project scope | task-modal.tsx:17 imports SchedulerJob; all modes read job.config.task_spec. | Scope ack — web-app rewrite to Task type. Not a break, just magnitude. |
| B7 | CompositeMode child click route | web-app | task-modal.tsx:641 — router.push(`/scheduler/jobs/${id}`). | Retarget to /tasks/:id/children/:scheduleId. Low effort. |

### LOW (cosmetic / convenience)

| # | Title | Fix |
|---|---|---|
| L1 | TaskDispatchService not re-exported from barrel index.ts | Add re-export. |
| L2 | composition-task.yaml subunit_count default=3 | v1 inherited; scheduler overrides at materialize time. Not a v2 break. |
| L3 | Spec's "isCompositeTask around lines 142-170" line ref imprecise | Method at 490-497; call site at 142. Cosmetic. |

---

## Recommendations

1. **Add a "Lifecycle Bridge" section to spec.md** defining the schedule↔task status propagation (A9, A9b) and the schedule-status listener pattern. This is the single biggest architectural gap — without it, `tasks.status` never transitions and the kanban shows stale states.

2. **Add a "Mechanism Details" subsection for each NEW tool/seam** specifying the DAO-level operations:
   - Autosave: targeted UPDATE on title+updated_at columns only (A4).
   - update_task_spec_field: patch task_spec field, bump version, emit SSE (A4).
   - Reverse context msg: server-side intercept at clone chat route (A6).

3. **Export or relocate materializeTaskSpecToConfig** (A7) and **modify it to drop task_spec + propagate resources** (A7b, B2, C3). This single function is the crux of 4 break points.

4. **Amend scheduler-engine.ts:448 filter** explicitly in the spec (A8). The "runner认领不变" claim is incorrect and will silently break all v2 task dispatch.

5. **Define the origin_role propagation** in TaskDispatchService (B4) — the port signature is fine, but the impl must set origin_type/origin_id/origin_role on child schedule creation.

6. **Run a spike on Claude SDK mid-session prompt rebuild** (C1) BEFORE pipeline execution. If `_rebuildSystemPrompt` doesn't pick up new authoring_resources[] mid-session, the v2-D8 draft-time resource loading is blocked.

7. **Run a spike on Claude SDK message injection** (A6) — verify whether a messages row with source='spec_override' is read by SDK resume. If not, use server-side intercept.

8. **Add WorkflowConfig.requires field** to shared schema (C3) — this is a clean schema addition that unblocks the resource propagation story.

9. **Threshold change for isCompositeTask** (B3) — explicitly state N≥2 for coordinator-ws.

10. **Orphan reaper schedule** (R-INT) — define the cron expression + scan query.

---

## Anti-Pattern Summary

| Anti-Pattern | Where it Manifests | Severity |
|---|---|---|
| **Magic Bridge** | config.requires (C3), task_status SSE emitter (A9b), reverse context msg (A6) | HIGH |
| **Orphan Field** | sessions.scope_id (A2), tasks.status (A9), WorkflowConfig.requires (C3) | HIGH |
| **Silent Failure** | (not prominent — most paths have error handling) | — |
| **Missing Trigger** | checkQueuedTasks filter (A8), orphan reaper (R-INT), tasks.status writer (A9) | HIGH |
| **Unversioned State** | autosave vs tool version coordination (A4) — asserted safe but DAO-unspecified | MEDIUM |
| **Unconnected Feedback** | enhancePromptWithSkills dead code (C2), pi-sdk-adapter + prompt-enhancer not wired (C1) | MEDIUM-HIGH |

---

## Verdict

**The spec is fundamentally sound but underspecified at the integration layer.** The decision-level design (v2-D1 through v2-D14, ADR-0009) is coherent and the inherited v1 decisions are correctly carried forward. The 11 HIGH break points are all fixable with spec-level additions (new fields, new writers, new listeners, explicit threshold changes) — none require re-architecting. The 8 MEDIUM issues are mostly UX-degradation or scope acknowledgments.

**Recommend spec revision pass** to address the 11 HIGH break points before pipeline execution. The most critical (in order): A9 (tasks.status writer + task_status SSE emitter), A8 (checkQueuedTasks filter), C3 (config.requires field + materializeTaskSpecToConfig resources propagation), A2 (sessions.scope_id writer), A6 (reverse context msg mechanism). Run the two SDK spikes (A6, C1) in parallel with spec revision — they may force mechanism changes.
