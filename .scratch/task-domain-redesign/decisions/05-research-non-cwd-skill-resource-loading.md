# 05 — Non-cwd skill/resource loading for the task-author agent at draft time

Type: research
Status: resolved
Blocked by: None

## Question

How does the task-author agent, during draft authoring, load INSTALLED skills/resources that are NOT in the
current cwd? And what is the resource reference model for binding a resource to a draft (authoring) vs a target
workspace (execution)? How does the workspace-time `require` path work?

## Answer (research ④ findings)

### How skills load into an agent run today (4-hop chain)
Workflow YAML `skills:` → engine `AgentExecutor` (`agent.ts:110`) → `AgentNodeRunner` (`agent-runner.ts:30,123`)
→ provider. **Pi path** (`pi-sdk-adapter.ts:61-82`): `DefaultResourceLoader({cwd, agentDir:'${cwd}/.claude'})`
+ `reload()` + filter by name — **skills must physically exist at `cwd/.claude/skills/{name}/`**. **Claude SDK
path** (`provider.ts:270`): passes `skills` to `query()`; SDK scans `~/.claude/skills/` + `cwd/.claude/skills/`.
**No data-pass mechanism — SDK reads files from disk.**

### What is a "resource"
`ResourceEntry` (`shared/src/resource/types.ts`): `{ name, type(skill|agent|workflow|rule|command|clone),
source(builtin|local|git), ref, group, installed, installPath(ABSOLUTE), dependsOn, activated, ... }`.
Global storage `~/.octopus/resources/{registry.json, installed/{type}/{group}/{name}/, sources/}`.
CLI `octopus resource list/install/...` via `/api/resources/*`; server `resource-registry.ts` + `resource-manager.ts`.
**Resources ALWAYS live outside cwd (global installPath)**; only copied into a workspace cwd by the provisioner.

### Resource binding today
**None.** `schedules.config.skills` is decorative (engine never reads it). `subunitSpecSchema.skills` stored but
`dispatchChildSchedule` doesn't pass it to the child. `project-selector.tsx` binds projects/repos, not resources.
No table/column/JSON links resource↔draft/session/workspace persistently. Only ephemeral copy at engine-init.

### Non-cwd loading at draft time
Today strictly cwd-scoped for the SDK. The ONE non-cwd mechanism = `ResourceProvisioner` (`shared/src/resource/
resource-provisioner.ts:64-117`, `directCopy` from `entry.installPath` → `workspace/.claude/skills/`) — but it is
**workspace-time only**, useless for draft-time (no workspace yet; task-author runs in user cwd/clone session).

### Recommendation (maps onto user's split decision exactly)
**(a) Draft-time (authoring)**: **prompt injection** — read SKILL.md from each resource's `installPath` (resolved
via global registry) and inject into the task-author session system prompt. Seams: `pi-sdk-adapter.ts:99-112`
(`getSystemPrompt` override, already monkey-patched to append) + `prompt-enhancer.ts:6-23` (`enhancePromptWithSkills`
already takes `skillContents: Record<string,string>`). Stateless, cwd-independent, no pollution.
**(b) Workspace-time (execution)**: keep `workflow.requires` + `ResourceProvisioner`. During
`materializeTaskSpecToConfig`, propagate `task_spec.resources` into the workflow's `requires` so existing
`EngineInitPhase` (`engine-init.ts:220-260`) provisions them.

### Resource reference model
`task_spec.resources[] = [{ type: "skill"|"agent"|"workflow", name: string }]` — declarative reference by name,
resolved via global registry at load time (mirrors `subunits[].skills` but more general). In v2 this lives on the
`tasks` table (e.g. a `resources` JSON column or within `task_spec`). Workspace-time: same array propagated to
`config.requires` during materialization.

### Key seams (minimal diff)
1. `shared/src/types/scheduler-job.ts` — add `resources` to `taskSpecSchema`.
2. `scheduler-service.ts:154-189` (`materializeTaskSpecToConfig`) — propagate `task_spec.resources` → `config.requires`.
3. `scheduler-service.ts:492-543` (`createJob`) — resolve resources at draft creation, inject SKILL.md content into
   the auto-created task-author clone session's system prompt.
4. `pi-sdk-adapter.ts:99-112` — extend `getSystemPrompt` override to accept skill-content array.
5. `task-dispatch-service.ts:90-166` — wire `subunit.skills` (currently unused) to child workspace provisioning
   (call `ResourceProvisioner.provision()` for child before start).

## Outcome → v2-D8 (tentative)
- `tasks.resources[]` declarative ref (by name+type, resolved via global registry).
- Draft-time: prompt-inject from `installPath` into task-author session (cwd-independent).
- Workspace-time: propagate to `workflow.requires` + existing provisioner.
- Unblocks ticket 06 (resource-binding UX: "user specifies + agent assists").
