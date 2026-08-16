# 03 — authoring clone + skill injection

Type: research
Status: resolved

## Answer

### 1. Established pattern for a clone chatbot to call server REST APIs

**Pattern: curl tools + SKILL.md as API reference, cwd = clone's own dir, systemPrompt = `claude_code` preset + assembled clone context (persona + memory).**

The scheduler clone (`global-chat.ts`) is the canonical example. Three layers compose it:

- **cwd** — `global-chat.ts:105`: `const cwd = getBuiltInCloneDir('scheduler')` → `~/.octopus/agent/built-in/scheduler/`. The clone runs in its own directory, not a workspace repo.
- **systemPrompt** — `global-chat.ts:119-127,158-159`: instantiate `new CloneRuntime(getBuiltinCloneDef('scheduler'), 'default').assembleContext()`, then pass to the provider as `{ type: 'preset', preset: 'claude_code', append: schedulerClonePrompt }`. The `claude_code` preset gives the clone the full Claude Code tool surface (Bash/curl, Read, Write, Edit, etc.); the appended clone context adds persona + memory.
- **plugins (skill discovery)** — `global-chat.ts:161-164`: `[{ type: 'local', path: getAgentDir() }, { type: 'local', path: getBuiltInCloneDir('scheduler') }]`. The Claude Agent SDK natively scans each plugin's `skills/` subdirectory and injects discovered SKILL.md content into the system prompt.
- **the SKILL.md as API reference** — `packages/core-pack/skills/octo-scheduler/SKILL.md`: the entire REST surface (`/api/scheduler/jobs`, `/cron/parse`, `/dashboard`, …) is documented as curl recipes. The clone reads this skill, then issues `curl -s -X POST "http://localhost:$PORT/api/scheduler/jobs" ...` via its Bash tool. It does NOT call server APIs in-process; it shells out to curl against `http://localhost:<PORT>/api/scheduler/*`.

So the chatbot never imports server services. It is a Claude Code session that (a) reads a SKILL.md describing the REST contract, (b) uses Bash+curl against `localhost:3001` (or worktree/prod port) to hit the same HTTP routes any external client would. `SKILL.md:28-29` codifies the constraint: "所有写操作使用 `curl` + `Content-Type: application/json`".

**Yes, a "task-author" chatbot can call `POST /api/scheduler/jobs` + `GET projects/skills` lists the same way.** The route `POST /api/scheduler/jobs` exists (`scheduler.ts:193-214`, mounted at `index.ts:671` as `/api/scheduler`). A task-author clone needs:
1. A built-in CloneDef (like `scheduler` in `builtin-clones.ts:113-121`) with a persona + a skills whitelist pointing at a task-authoring SKILL.md.
2. That SKILL.md documents the REST contract for job creation + enqueue (`POST /jobs`, `POST /jobs/:id/enqueue` at `scheduler.ts:287-295`) plus whatever project/skill listing endpoints the author needs.
3. The same `getBuiltInCloneDir(name)` cwd + `preset: 'claude_code'` + plugins wiring as `global-chat.ts`.

The one prerequisite: the task-author SKILL.md must be present in a `skills/` subdir of one of the clone's plugin paths so the SDK discovers it.

### 2. Per-task skills selection — can it be scoped per session?

**Not currently. `CloneDef.skills` is a whitelist filter that is effectively dead under ADR-006, and there is no per-session override.**

The mechanism that LOOKS like it does this:

- `CloneDef.skills: string[]` (`shared/src/types/agent.ts:149`) — documented as "skill names" whitelist. The scheduler clone sets `skills: ['octo-scheduler']` (`builtin-clones.ts:118`).
- `CloneRuntime.loadSkills()` (`clone-runtime.ts:366-439`) reads `this.cloneDef.skills`, and at `clone-runtime.ts:392` applies: `filterSet = filter.length > 0 ? new Set(filter) : null` — empty array = include all, non-empty = whitelist. This is the intended scoping mechanism.

**But `loadSkills()` is no longer called.** `assembleContext()` (`clone-runtime.ts:91-123`) explicitly comments at lines 118-121:

```
// Skills are no longer included as prompt text.
// The Claude Agent SDK discovers skills natively via the `plugins` option
// (see getPlugins() + sendWithProvider()). See ADR-006.
```

Skills now flow through `getPlugins()` (`clone-runtime.ts:237-246`), which returns two *directory paths* — `getAgentDir()` (shared tier, `~/.octopus/agent/skills/`) and the clone's own dir — and lets the SDK scan their `skills/` subdirs. **`getPlugins()` does NOT consult `CloneDef.skills` at all.** At runtime, `~/.octopus/agent/skills/` contains all 33 shared skills (verified: octo-scheduler, octo-resource-manager, octo-xzf-*, …), so every clone currently inherits the full shared skill set regardless of its `skills` whitelist. The clone-specific tier (`~/.octopus/agent/built-in/scheduler/skills/`) is empty, so the whitelist has no clone-specific skills to gate either.

**Consequence for per-task scoping:** there is no per-session/per-task skills parameter anywhere in the call chain. `CloneRuntime` is constructed with a static `CloneDef` (`clone-runtime.ts:56-59`), and both `assembleContext()` and `getPlugins()` derive solely from `this.cloneDef`. To scope skills per-task you would need one of:

- **(a) Rewire the filter into the plugin path** — add a per-instance `skillsFilter?: string[]` to `CloneRuntime` (constructor or setter), and have `getPlugins()` either return a synthetic plugin dir containing only the selected skills (e.g. symlinks under a temp/per-task `skills/` dir) or pass an SDK-level allowlist if the plugin API supports one. This is the cleanest: keeps ADR-006 native discovery, restores the `CloneDef.skills` semantics, and adds per-task override.
- **(b) Re-enable `loadSkills()` text injection** with the filter for the task-author route only — regresses from ADR-006's "native discovery" but is the smallest diff and gives full control over which SKILL.md bodies land in the prompt.
- **(c) Per-task CloneDef synthesis** — build a `CloneDef` per task with `skills: [...]` set to the task's selected skills and rely on (a) to actually enforce it.

The `CloneDef.skills` field and the `loadSkills()` filter logic are the right *vocabulary* to reuse; they just need to be wired back into the active skill-discovery path.

### 3. Project/codebase context as cwd or refs — can it be given to the authoring chatbot?

**Yes, as cwd — already proven by the workspace-clone path. As refs, it needs a persona/prompt injection.**

Three cwd strategies exist today, one per chat route:

- **Workspace chat** (`chat.ts:79`): `const cwd = workspace.path.replace(/^~/, os.homedir())` — the clone runs in the **workspace's repo directory**, NOT the clone's own dir. This is the precedent for "give the chatbot a codebase as cwd." The workspace clone then gets `preset: 'claude_code'` so it can Read/Edit/Bash inside that repo.
- **Scheduler clone** (`global-chat.ts:105`): `cwd = getBuiltInCloneDir('scheduler')` — clone's own dir, no repo context (correct: it talks to APIs, not code).
- **Clone-session chat** (`clone/index.ts:280`): `cwd = runtime.getDefaultCwd()` — clone's own dir.

For a task-author chatbot that should reason about a selected project's codebase while authoring a spec, the workspace-chat pattern (`chat.ts:79`) is the model: set `cwd` to the selected project's `source_path`. The data exists: `WorkspaceService.createFromSpec` (`workspace.ts:315-324`) takes `projects: Array<{ name: string; source_path: string }>`, and scheduler jobs carry `workspace_spec.projects` (`SKILL.md:79-84`, `task-pool-system-prompt.ts:19-22`). So a task-author route could resolve the selected projects' `source_path` and pass the first (or a multi-root) as cwd.

**What it would need:**
- If single project: pass `projects[0].source_path` as `cwd` to `agent.sendQuery(...)` exactly like `chat.ts:79` + `chat.ts:135` (`agent.sendQuery(body.content, cwd, ...)`).
- If multiple projects: cwd is a single path in the Claude SDK, so either pick the primary repo as cwd and list the others as refs in the persona/prompt, or create a parent dir containing worktree checkouts (heavier).
- The clone must keep `preset: 'claude_code'` so it has Read/Bash/Grep tools to inspect the codebase while authoring.
- Plugins should still include the task-authoring skill (so it knows the spec schema + the enqueue API).

### 4. Is `task-pool-system-prompt.ts` the right producer prompt, or does it need revision?

**It is the right injection point and the right shape, but it needs revision for the new spec/subunits model and for the authoring-clone-via-API pattern.**

What it currently is (`task-pool-system-prompt.ts:9-41`):
- Injected at `chat.ts:104-106` when `body.purpose === 'requirement'` — and it **replaces** (not appends) the workspace clone persona (`chat.ts:103` comment: "replace because task-pool chat doesn't need workspace persona"). So the producer-prompt injection seam already exists; a task-author route can reuse the same `purpose`-switch pattern.
- It instructs the model to produce **`WorkflowConfig` JSON** (`schema_version: "2.0"`, `type: "workflow"`, `workspace_spec`, `workflow_chain`, `max_retain`) in a fenced code block and nothing else.

Where it falls short for the new spec/subunits model:

- **Hardcoded to `schema_version: "2.0"` / `type: "workflow"`** (`task-pool-system-prompt.ts:15-16,32-33`) — if the new model introduces subunits, a different `type`, or a new schema version, these literals and the JSON skeleton must change.
- **No mention of subunits** — the prompt only knows `workflow_chain` (array of `{ workflow_ref, input_values }`). A subunits model needs the prompt to emit the subunit structure.
- **No enqueue instruction** — the prompt tells the model to *emit JSON*, not to *call `POST /api/scheduler/jobs` then `POST /jobs/:id/enqueue`* (`scheduler.ts:287-295`). The scheduler clone pattern (Q1) is "call curl"; this prompt is "print JSON." For an authoring clone that produces a spec AND enqueues it, the prompt must instruct the model to use curl (per the task-author SKILL.md) to POST the spec and enqueue, mirroring `SKILL.md`'s workflow A (`SKILL.md:235-242`).
- **No project/codebase context binding** — the prompt emits `workspace_spec.projects` with empty `source_path`/`group` defaults (`task-pool-system-prompt.ts:21`), but nothing tells the model to discover real `source_path` values from its cwd or from a projects-list API. If the authoring clone runs with `cwd = selected project path` (Q3), the prompt should tell it to read the repo to fill `source_path`/`branch_prefix` truthfully.
- **No skills scoping instruction** — if per-task skills selection (Q2) is wired, the prompt should tell the model which skills it may reference when decomposing the spec into subunits.
- **Route gap** — the `/tasks` kanban route (`agent/task-routes.ts:25`, mounted under `/api/agent`) does NOT inject `taskPoolSystemPrompt`; only the workspace chat route (`chat.ts:104`) does. The task trace notes "/tasks currently DOESN'T call" the producer prompt. If the authoring clone should launch from the tasks surface, that route (or a new dedicated authoring-chat route mirroring `global-chat.ts`) must wire the injection.

**Verdict:** keep `task-pool-system-prompt.ts` as the producer-prompt module and keep the `purpose === 'requirement'` injection seam in `chat.ts`; rewrite its body to (a) emit the new spec/subunits schema, (b) instruct curl-based POST + enqueue against `/api/scheduler/*` (like `octo-scheduler/SKILL.md`), (c) bind to the cwd project context, and (d) respect the per-task skills selection. The cleanest packaging is a new task-author SKILL.md (the API/schema reference, like `octo-scheduler/SKILL.md`) PLUS a thin system prompt (the producer persona, like `task-pool-system-prompt.ts`) that points at it — exactly the two-layer split the scheduler clone already uses.

### Summary table

| Question | Answer | Key file:line |
|---|---|---|
| 1. clone→REST pattern | curl tools + SKILL.md as API ref, `claude_code` preset, clone-dir cwd; yes task-author can reuse | `global-chat.ts:105,123,158-164`; `SKILL.md:28-29,235-242` |
| 2. per-task skills scoping | `CloneDef.skills` filter exists but dead under ADR-006; `getPlugins()` exposes all shared skills; no per-session override — needs rewiring | `clone-runtime.ts:118-121,237-246,366-439`; `agent.ts:149`; `builtin-clones.ts:118` |
| 3. project/codebase as cwd | Yes — workspace chat already uses `workspace.path` as cwd; pass `projects[].source_path` as cwd for task-author | `chat.ts:79,135`; `workspace.ts:315-324` |
| 4. `task-pool-system-prompt.ts` | Right injection point + shape, but must be revised for subunits schema + curl/enqueue + project context + skills scope | `task-pool-system-prompt.ts:9-41`; `chat.ts:102-106`; `scheduler.ts:287-295` |
