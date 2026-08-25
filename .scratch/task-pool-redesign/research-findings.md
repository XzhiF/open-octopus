# Task Pool Redesign — Research Findings (Current-State Map)

Scope: PR #50 (`test-task-board` → `main`, OPEN, 6 commits, clean tree). This doc traces the **actual** state of the task-pool feature against primary source only. All claims cite `file:line`.

## 0. Branch / lineage context

- Current branch = `test-task-board` = PR #50 head (`gh pr view 50`: head `test-task-board`, base `main`, state OPEN). Working tree clean, so the file tree IS PR #50's current state.
- An earlier "DemandService + TaskPoolDispatcher + demands DAO + 12-endpoint task-board API" approach exists in `git log --all` (commits `54a1adc`, `098f0a4`, `687067e`) but is **NOT on `test-task-board`** (`git branch --contains` returns nothing). PR #50 abandoned it for the simpler "reuse the `schedules` table + `trigger_source='requirement'` + WorkflowConfig preview" approach. The only task-pool source files on the branch are `task-pool-system-prompt.ts` and `web-app/lib/task-pool.ts`.

## 1. Current-state map

### A. The `/tasks` chatbot stack (frontend → backend)

- `packages/web-app/app/tasks/page.tsx:27-30` — page calls `useChatStream(null, activeSessionId, { apiBase: '/api/chat/global', onSessionCreated })`. `workspaceId` is `null`, so `use-chat-stream.ts:293` falls through to `/api/chat/global`.
- `tasks/page.tsx:8,35` — the only scheduler call from the page is `listJobs({ page:1, limit:100, trigger_source:'requirement' })` (kanban read path). `tasks/page.tsx:54-60` subscribes to SSE `/api/scheduler/events` (`schedule_status`).
- `tasks/page.tsx:112` — the "新建任务" button is a non-functional placeholder: `toast.info('在右侧对话面板描述需求，AI 会生成 WorkflowConfig，预览后点入队')`. No enqueue wired here.
- `components/workspace/chat/chat-panel.tsx:216-225` — renders `MessageBubble` per message; does NOT directly render the preview.
- `components/workspace/chat/assistant-message.tsx:12-29` — mounts `<WorkflowConfigPreview content={message.content} onRetry={onRetry} />` after every assistant text bubble.
- `components/workspace/chat/use-chat-stream.ts:595-615` — SSE-over-POST-response streaming; parses `event:`/`data:` lines. **Does NOT parse fenced-JSON**; it accumulates raw `content`. Fenced-JSON extraction is delegated to the render layer.
- `components/workspace/chat/workflow-config-preview.tsx:17-52` — **display-only**. Success branch renders `workspace_spec.org`, `branch_prefix`, `workflow_chain`, `max_retain` in a `<dl>`. No buttons, no fetch. `:61-71` has only a "重新生成" retry button calling `onRetry` (which re-sends the prior user message to the chat API — NOT a scheduler call).
- `lib/workflow-config-extract.ts:7` — regex `` ```json\s*([\s\S]*?)\s*``` `` then Zod `workflowConfigSchema` (`@octopus/shared`) at `:20`.
- `lib/scheduler-api.ts:89-96` — `createJob` POSTs `/api/scheduler/jobs`; `:133` `triggerJob` POSTs `/jobs/:id/trigger`. **Neither is called anywhere in the `/tasks` or chat path** (grep of `app/tasks/` + `components/workspace/chat/` for `createJob|triggerJob|enqueue` = 0 hits).
- `lib/task-pool.ts:3` — `TaskPoolStatus = 'draft'|'queued'|'claimed'|'running'|'done'`; `:10-16` kanban columns; pure grouping helper, calls no endpoints.

### B. The chatbot backend + system prompt

- `packages/server/src/index.ts:411` — `app.route("/api/chat/global", globalChatRoutes(sse, chatSvc))` (no `:id`, no `WorkspaceService`). Contrast `:410` `/api/workspaces/:id/chat`.
- `routes/global-chat.ts:24-44` — `loadSchedulerSystemPrompt()` reads `packages/core-pack/skills/octo-scheduler/SKILL.md`, strips frontmatter, stores as `SYSTEM_PROMPT`.
- `routes/global-chat.ts:47` — `GLOBAL_SCOPE_ID = 'global-scheduler-chat'` (sentinel used as `workspace_id` for chat sessions only — a namespace, not a real workspace).
- `routes/global-chat.ts:119-127` — `schedulerClonePrompt = SYSTEM_PROMPT`; then **overwritten** by `new CloneRuntime(getBuiltinCloneDef('scheduler'),'default').assembleContext()` if it succeeds. `:159` sends `systemPrompt: { type:'preset', preset:'claude_code', append: schedulerClonePrompt }`.
- `routes/global-chat.ts:105` — `cwd = getBuiltInCloneDir('scheduler')` = `~/.octopus/agent/built-in/scheduler/` (`services/agent/paths.ts:91-93`). `:162-164` plugins = `[getAgentDir(), getBuiltInCloneDir('scheduler')]`. No explicit tool whitelist → Claude Code SDK defaults (Bash→`curl`, Read, Edit, …).
- **`task-pool-system-prompt.ts` is NOT dead, but is NOT wired into global-chat.** Grep `taskPoolSystemPrompt` in `packages/server/src/`: hits only at `routes/chat.ts:10,105` and `__tests__/t2-chatpanel-workflow-config.test.ts:9,185`. Zero hits in `global-chat.ts`.
- `routes/global-chat.ts` consumes only `body.content` (`:99`). No `project_id`/`workspace_id`/`org`/repo read from request or session. Fully global/context-free.
- `routes/scheduler.ts:287-295` — `POST /jobs/:id/enqueue` exists → `service.enqueueJob(id)`. `:193` `POST /jobs` (generic create). `:197-207` auto-creates a chat session scoped `TASKPOOL_DRAFT_CHAT_SCOPE='taskpool-draft'` (`:22`) when `trigger_source==='requirement'` and no `source_chat_session_id`. `:169` `GET /jobs` defaults `trigger_source=cron` (`:183`) so requirement-drafts are hidden unless explicitly requested.
- `routes/chat.ts:102-106` — T-2 hatch: `const systemPromptAppend = body.purpose === 'requirement' ? taskPoolSystemPrompt : (workspaceClonePrompt || undefined)` (comment: "replace (not append)"). `:94` uses `getBuiltinCloneDef('workspace')`; `:79` cwd=`workspace.path`; `:138` one plugin `getAgentDir()`.

### C. Clone agent system + customizability

- Clones defined in `packages/server/src/services/agent/builtin-clones.ts:103-149` (`BUILTIN_CLONES`), NOT in `packages/core-pack/agents/*.md` (those are swarm roles). Five built-ins: `workspace` (`:104-112`), `scheduler` (`:113-121`), `archive` (`:122-130`), `resource` (`:131-139`), `harness-agent` (`:140-148`). User clones live on disk at `~/.octopus/agent/clones/{name}/` (`clone-resolver.ts:71-97,103-156`).
- `scheduler` clone: `persona: SCHEDULER_PERSONA` (`builtin-clones.ts:26-41`), `skills: ['octo-scheduler']`, `memoryScope: 'isolated'`. `CloneRuntime.loadPersona()` (`clone-runtime.ts:334-353`) prefers `built-in/scheduler/persona.md` over inline.
- ADR-006 (`clone-runtime.ts:118-121`): skills are **not** injected as prompt text; the SDK discovers them via `plugins`. `loadSkills()` (`:366-439`, honors the whitelist) is **dead** — not called from `assembleContext()`. `getPlugins()` (`:237-246`) returns `[getAgentDir(), clonePath]`; the SDK scans each `skills/` subdir. So `skills: ['octo-scheduler']` is vestigial — the scheduler clone inherits ALL of `~/.octopus/agent/skills/`.
- **Clone selection is hardcoded per surface, not per-project.** `chat.ts:94` hardcodes `'workspace'`; `global-chat.ts:121` hardcodes `'scheduler'`. Only `routes/clone/index.ts:241-267` (`POST /api/clones/:name/sessions/:id/chat`) is clone-polymorphic, via URL `:name`. No project/workspace→clone mapping table anywhere.
- `octo-scheduler/SKILL.md` (319 lines) is a curl-driven REST API reference. It is the **fallback** `SYSTEM_PROMPT` in `global-chat.ts:24-44`, shadowed by `assembleContext()` in the normal path. Grep of SKILL.md for `WorkflowConfig|workflow_chain|入队|enqueue|```json` = 0 hits — it does NOT instruct emitting WorkflowConfig JSON.
- No per-project/per-workspace skill injection. Two-tier global model only: `~/.octopus/agent/skills/` (shared) + `~/.octopus/agent/built-in/{name}/skills/` (per-clone) (`paths.ts:16-38`).

### D. Workspace + project linkage for tasks

- `db/schema.sql:264-296` — `schedules` table (schema v37). Columns: `org`, `workspace_id` (**nullable**, FK→`workspaces(id)`), `workflow_ref`, `config` (JSON holding `WorkspaceSpec`+`workflow_chain`), `status` (default `'queued'`, task-pool lifecycle), `trigger_source` (`'cron'|'requirement'`), `source_chat_session_id` (**the only chat linkage**), `claimed_at`, `max_retain`. **No `project_id`** (projects live inside `config.workspace_spec.projects`). No other chat column.
- `schedule_executions` (`schema.sql:299-324`): `workspace_id` nullable, set at dispatch. `schedule_workspaces` (`:360-373`): `schedule_id`/`workspace_id`/`execution_id` FKs — the real schedule↔workspace relation. `workspaces` (`:14-26`): `source` default `'user'`, `source_schedule_id` back-reference.
- `db/dao/schedule-config-dao.ts` — no `createFromSpec`/`createDraft`. `insertSchedule` (`:75-103`) is the primary insert; caller `SchedulerService.createJob` (`scheduler-service.ts:339-355`) never passes `workspace_id` → every schedule starts `workspace_id=NULL`.
- `services/scheduler/executors/workflow-executor.ts:67` `execute`; `:112` parses `config` from `schedule.config` JSON as `WorkflowConfig`; `:114` validates `type==='workflow' && workspace_spec && workflow_chain.length`. `:140-149` calls `workspaceService.createFromSpec({ org, name, projects, branch_prefix, branch_suffix, source:'scheduler', source_schedule_id, workflow_chain })` — "spec" here = `WorkspaceSpec` (a Zod sub-object), NOT a xzf-dev spec doc. `createFromSpec` (`services/workspace.ts:315-387`) calls `git.initWorktreesFromSpec` (`workspace-git.ts:99-166`, `spawnSync("git",["worktree","add","-f",wtDir,"--detach"])`). The executor does **not** update `schedule.workspace_id`; linkage lives in `schedule_workspaces` (`:167-174`) + `schedule_executions.workspace_id` (`:177`).
- CLI `packages/cli/src/commands/workspace-cmd.ts:31-58` — `workspace create` POSTs minimal body to `/api/workspaces`. `setup.ts` scaffolds `~/.octopus/{org}/`. **A chat session cannot spawn/own a workspace.** The `'taskpool-draft'` sentinel passed as `workspace_id` to `chatService.createSession` (`scheduler.ts:205`) is a fake id — a FK violation waiting to surface if `PRAGMA foreign_keys=ON` on the chat connection (unverifiable from code).
- Chat↔schedule link is one-way and dangling: `source_chat_session_id` points schedule→chat_session, but the chat_session's `workspace_id` is the `'taskpool-draft'` sentinel, and the dispatched workspace is never written back to the chat session.

### E. The xzf-dev planning pipeline — disconnected

- `packages/core-pack/workflows/xzf-dev.yaml:19` (`serial`). 11 stages: `init`(`:184-199`)→`idea-research`(`:206-305`)→`requirements-clarify`(`:310-354`)→`verification-clarify`(`:365-407`)→`spec-planner`(`:413-437`)→`spec-audit`(`:443-476`)→`spec-to-tasks`(`:482-512`)→`execution`(`:518-622`)→`impl-walkthrough-fix`(`:628-659`)→`e2e-verify`(`:665-716`)→`ship`(`:722-745`). Uses all 9 `octo-xzf-*` skills (`:24-32`).
- **Final output**: a PR/MR + archived docs under `{project}/.octopus/xzf/{slug}` (`:727-745`). Emits **no** workflow YAML and **no** `workflow_ref`-shaped artifact. Its `dag.json` (`:501-504`) is a private format consumed only by its own `dynamic_sub_workflow` node (`:554-555`).
- **xzf-dev is referenced from the task pool / scheduler / global-chat: NO.** Grep `xzf-dev` in `packages/server/src/services/scheduler/` + `packages/server/src/routes/` = `NO_HITS`. The only `xzf-dev` string in web-app is a coincidental org-slug default (`ExperienceLibrary.tsx:22`).
- Task-pool task body = `workflow_ref` to an **existing** YAML (`task-pool-system-prompt.ts:25,35`; `WorkflowRef` path-string `shared/src/resource/workflow-ref.ts:16,48-53`); executor consumes verbatim (`workflow-executor.ts:195,209-212,470-471`).
- **The two worlds are fully disjoint** — share neither data flow nor schema. xzf-dev produces specs/tasks/PRs; the task pool consumes a pre-existing `workflow_ref` YAML. No bridge transforms one into the other.

## 2. Interaction gaps (verified wiring breaks)

1. The `/tasks` chat uses the **wrong prompt**: `tasks/page.tsx:28` calls `/api/chat/global`, whose backend (`global-chat.ts:121,159`) uses the `scheduler` clone + `octo-scheduler` SKILL.md (a curl REST manager). The WorkflowConfig-JSON producer (`task-pool-system-prompt.ts`) is wired only into `chat.ts:105` (`purpose:'requirement'`), a route the `/tasks` page never calls.
2. `workflow-config-preview.tsx:17-52` is **display-only** — no enqueue/入队 button, no `POST /jobs`, no `POST /jobs/:id/enqueue`, no `createJob` call (grep of `app/tasks/` + `components/workspace/chat/` for `createJob|triggerJob|enqueue` = 0 hits).
3. The backend enqueue endpoint `POST /jobs/:id/enqueue` exists (`scheduler.ts:287-295`) and `createJob` exists client-side (`scheduler-api.ts:89-96`), but **nothing in the chat→preview path invokes either** — the commit path from chat to draft to dispatch is unbroken only on paper.
4. `global-chat.ts` is **fully context-free** (`:411` mount has no `:id`; factory takes no `WorkspaceService`; `:47` `GLOBAL_SCOPE_ID`; `:99` consumes only `body.content`; `:105` cwd is the clone dir) — the chatbot has no project/workspace/org/repo awareness to bind a task to.
5. `task-pool-system-prompt.ts` instructs the model to emit WorkflowConfig JSON in a ```` ```json ```` fence (`:9,38`) with `workflow_ref` to an existing YAML (`:25,35`), but that prompt is **unreachable from the `/tasks` page** — the global chat the page uses is never told to produce it (SKILL.md has no `WorkflowConfig`/`workflow_chain`/```` ```json ```` references).
6. The chat↔schedule link is **dangling**: `source_chat_session_id` is the only link (`schema.sql:293`), and the auto-created chat session's `workspace_id` is the sentinel `'taskpool-draft'` (`scheduler.ts:22,205`) — not a real workspace. The dispatched execution workspace (`workflow-executor.ts:140-149,167-177`) is never written back to the chat session.
7. `schedules.workspace_id` is **nullable and never set** for task-pool drafts (`schedule-config-dao.ts:75-103`; `createJob` passes no `workspace_id`) — the schedule row itself carries no workspace binding until a join through `schedule_workspaces`/`schedule_executions`.
8. Clone selection is **hardcoded, not per-project**: `chat.ts:94` `'workspace'`, `global-chat.ts:121` `'scheduler'`. No project/workspace→clone mapping exists, so "per-project skills/persona" is impossible today without new wiring.
9. The `CloneDef.skills` whitelist (`builtin-clones.ts:117`) is **dead** in the runtime path (ADR-006, `clone-runtime.ts:118-121`); the SDK injects all skills in scanned dirs — skill scoping cannot be enforced via config.
10. xzf-dev and the task pool share **zero** references (grep `xzf-dev` in `services/scheduler/` + `routes/` = `NO_HITS`); xzf-dev emits no `workflow_ref`-consumable artifact, so its spec output cannot feed the task pool.

## 3. The design fork

Requirement-authoring today is a **context-free global chat** (`/api/chat/global`, scheduler clone) that produces no WorkflowConfig, while the actual WorkflowConfig-JSON-producer prompt (`task-pool-system-prompt.ts`) is wired into the **workspace** chat route (`chat.ts`, `purpose:'requirement'`) that the `/tasks` page never calls — and even there the rendered preview is display-only with no enqueue button, so there is no commit path from chat → draft → queued → dispatch. In parallel, a complete 11-stage spec pipeline (`xzf-dev`) exists but is fully disjoint: it generates specs/tasks/PRs while the task pool consumes a `workflow_ref` to a pre-existing YAML, and the two share neither schema nor data flow. An elegant solution must reconcile four things at once: **which chat route/prompt feeds the board**, **the enqueue commit path** (currently no button + no `createJob` call), **whether requirement-authoring consumes xzf-dev spec artifacts or stays a workflow_ref pointer**, and **the chat↔workspace binding** (currently a dangling `'taskpool-draft'` sentinel).

## 4. Open factual questions (could not verify from code)

- **Intent of the `/api/chat/global` wiring**: is the `/tasks` page *supposed* to use the workspace hatch route (`chat.ts` + `purpose:'requirement'`) and the global route is a mis-wiring, or is the global scheduler-clone chat intentional and the WorkflowConfig preview merely decorative? Code shows the break, not the intent.
- **`PRAGMA foreign_keys=ON` on the chat DB connection**: the `'taskpool-draft'` sentinel stored as `chat_sessions.workspace_id` (`scheduler.ts:205`) is a FK violation if enforced. Could not verify the chat-connection pragma from code.
- **Intended happy-path for populating the board**: does the user chat in `/tasks`, the scheduler clone use `curl` to `POST /api/scheduler/jobs` with `trigger_source:'requirement'` (auto-creating the `'taskpool-draft'` session), and the board refresh via SSE? If so the WorkflowConfig preview is decorative; if the preview is meant to be the enqueue trigger, it is unimplemented. The code supports neither cleanly.
- **Abandoned DemandService approach**: is the `DemandService`/`TaskPoolDispatcher`/demands-DAO/12-endpoint task-board design (on other branches) intended to return, or is PR #50's "reuse schedules + `trigger_source='requirement'`" the final direction?
- **Whether `createFromSpec`'s "spec" should ever become a xzf-dev spec doc** — currently it is `WorkspaceSpec` (`scheduler-job.ts:33-37`); any bridge from xzf-dev specs would need a distinct name to avoid the existing collision.
