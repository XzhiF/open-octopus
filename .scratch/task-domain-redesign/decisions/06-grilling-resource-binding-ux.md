# 06 — Resource-binding UX: draft-scope vs workspace-scope, user + agent

Type: grilling
Status: resolved (user chose a → v2-D13)
Blocked by: None

## Answer

User selected **(a) two persisted scopes**. `tasks.authoring_resources[]` (draft-scope: prompt-injected into
task-author session each turn, reloaded on draft reopen) + `tasks.resources[]`/`subunitSpec.resources[]`
(workspace-scope: propagated to `workflow.requires` at materialize, provisioned at execution). Both editable by
user (resource picker via `/api/resources/*`) AND agent (`update_task_spec_field` field='authoring_resources'|
'resources' + ad-hoc `load_resource_for_authoring`). Mechanism per research ④. Matches the user's draft/workspace split. (was 05, resolved)

## Question

Concrete UX for "user specifies + agent assists" resource binding, across the two scopes the user named:
**draft** (task-author chatbot loads resources to use during authoring) vs **target workspace** (resources the
workflow `require`s at execution). Research ④ fixed the mechanism: draft-time = prompt-inject SKILL.md from global
`installPath` into the task-author session; workspace-time = propagate to `workflow.requires` + `ResourceProvisioner`.
O4=(a) makes `resources` an auto-bindable field via `update_task_spec_field`. This ticket decides the **two-scope
UX shape** + whether authoring aids persist.

## Options

### (a) [Recommended] Two persisted scopes
- `tasks.authoring_resources[]` — **draft-scope**: prompt-injected into the task-author session each turn; reloaded
  on draft reopen. Resources the agent uses to author a better spec (domain knowledge skills, reference workflows).
- `tasks.resources[]` / `subunitSpec.resources[]` — **workspace-scope**: propagated to `workflow.requires` at
  `materializeTaskSpecToConfig`; provisioned into the target workspace at execution.
- Both editable by **user** (resource picker in SpecPanel, listing installed resources via `/api/resources/*`) AND
  **agent** (`update_task_spec_field` field='authoring_resources'|'resources'; ad-hoc `load_resource_for_authoring`
  tool for ephemeral session-load).
- Clean separation: authoring aids don't pollute execution requirements; reload-safe.

### (b) One list, dual-use
- Single `tasks.resources[]` — prompt-injected at authoring AND propagated to `workflow.requires` at execution.
- Simpler (one list, one picker). But conflates authoring aids with execution requirements (execution over-requires
  authoring-only skills; or authoring loses skills you only want at execution).

### (c) Ephemeral authoring load + execution-only persistence
- Authoring aids loaded ad-hoc via `load_resource_for_authoring(name)` tool (session-scoped, NOT persisted); only
  `tasks.resources[]` (workspace-scope) persisted.
- Lightest schema; but authoring aids don't reload on draft reopen (agent must re-load).

## Recommendation

**(a).** Matches the user's explicit split ("draft时chatbot可加载resources使用; workspace里由workflows require") with
reload-safety. Two persisted lists keep authoring aids from polluting execution requirements. User picker + agent
tool cover "用户指定 + agent协助" for both scopes. (b) conflates; (c) loses reload-persistence.

## Note
- Mechanism (draft prompt-inject / workspace provisioner) fixed by research ④ → v2-D8. This ticket only fixes UX scope.
- Resource picker UI lists installed resources from the global registry (`/api/resources/*`); binding writes the
  relevant `tasks` array; agent `load_resource_for_authoring` resolves `installPath` → injects SKILL.md via
  `pi-sdk-adapter.ts:99-112` / `prompt-enhancer.ts`.
- `tasks.authoring_resources[]` reload on draft open = re-inject into the task-author session prompt at session load.
