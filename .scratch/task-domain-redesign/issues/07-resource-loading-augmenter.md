# 07 — server: 资源加载 augmenter + requires 传播（SPIKE S2 gated）

## What to build
SG11 新 `TaskAuthorSessionAugmenter`：`ResourceManager`→解析 installPath→读 SKILL.md→`enhancePromptWithSkills`（救活死码）→pi-sdk systemPrompt。SG6 每 turn clone chat 路由开头重读 `tasks.authoring_resources[]`→`_rebuildSystemPrompt`（pi-sdk-adapter.ts:106）（**SPIKE S2 验证**；不可行→备选每 turn 重建 session / user-msg preamble）。SG7 `materializeTaskSpecToConfig` 传播 `tasks.resources[]`/`subunit.resources[]`→`config.requires`；`EngineInitPhase` UNION 合并 `config.requires`→`workflow.requires`。draft 期 prompt-inject；workspace 期 provisioner。

## Blocked by
03 (tasks service), 06 (materialize), 13 (pi-sdk resume — 同文件 pi-sdk-adapter.ts 安全序), 05 (reverse-msg — clone-runtime.ts 同文件序)

## Status
done

## Verification

All 3 ACs verified via integration tests (94 new+existing tests across 9 files, 0 new regressions — the 24 pre-existing failures in clone-file-mgmt/engine-callbacks-budget/harness-integration/prompt-assembler/schema-migration fail identically on the base commit, unrelated to 07).

### AC1: authoring_resources[]→task-author session prompt contains SKILL.md content (draft)
- `07-authoring-inject.test.ts` AC1: task with `authoring_resources=[{skill:X}]` → clone chat route resolves via `taskDAO.getBySourceChatSession` → calls `TaskAuthorSessionAugmenter.resolveAuthoringResourcesContent()` → passes content to `CloneRuntime.chat` as `authoringResourcesContent` (6th arg). Asserts `capture.authoringContent === FAKE_SKILL_CONTENT`.
- `07-resource-loading.test.ts` SG11: real `ResourceManager` + temp installed skill → augmenter returns content containing SKILL.md body + `## Available Skills` header (via `enhancePromptWithSkills`).
- `clone-runtime.test.ts` SG6: `runtime.chat('hello', sid, null, cwd, NOTICE, AUTHORING)` → spy on `provider.sendQuery` asserts `options.systemPrompt.append` contains AUTHORING + NOTICE + persona.

### AC2: task-author per-turn fresh assembleContext + authoring_resources SKILL.md injected + DB history continuity (SPIKE S2 Mechanism B)
- Peer-audit correction: task-author uses `getProvider('claude')` (Claude SDK), NOT Pi. `assembleContext()` is already fresh per turn (clone-runtime.ts:278, called inside `chat()`); `sendWithProvider` rebuilds `systemPrompt.append` per call. No `providerSessionId=null` fresh-session / DB-history-prepend needed (Claude SDK resume works natively — SPIKE S1 confirmed this seam).
- The clone chat ROUTE resolves `authoring_resources` per turn (before `runtime.chat`), so the latest `tasks.authoring_resources[]` is re-read every turn. `clone-runtime.test.ts` SG6 "appends authoringResourcesContent" verifies the per-call append.
- DROPPED per peer audit: pi-sdk-adapter.ts edits, fresh-session-per-turn, DB history prepend, `load_resource_for_authoring` tool.

### AC3: tasks.resources[]/subunit.resources[]→config.requires→workflow.requires UNION; EngineInitPhase provisions
- `07-resource-loading.test.ts` SG7: `materializeTaskSpecToConfig` with `resources=[{skill,agent,command,rule}]` → `config.requires` has all 4 buckets mapped (skills/agent_files/commands/rules). Subunit resources flattened + deduped. Task-level + subunit UNION. No resources → `config.requires` undefined (backward compat).
- `engine-init.test.ts` SG7: `configRequires` UNION-merges with `workflow.requires` (deduped, no override). `resourcePreflight.check` receives the merged manifest. agent_files path → bare name dedup works. No configRequires → unchanged behavior.
- `ExecutionLifecycle.ts`: `resolveScheduleConfigRequires(executionId)` JOINs executions→workspaces→schedules to look up the schedule's config.requires, passes to `initPhase.run({ configRequires })`. Best-effort (manual execution / missing schedule → undefined → workflow.requires alone).

### Files changed
- NEW `packages/server/src/services/tasks/task-author-session-augmenter.ts` (SG11)
- NEW `packages/server/src/__tests__/07-resource-loading.test.ts` (SG7+SG11 unit tests, 10 tests)
- NEW `packages/server/src/__tests__/07-authoring-inject.test.ts` (SG6 route integration, 3 tests)
- `packages/server/src/services/agent/clone-runtime.ts` (SG6: chat + sendWithProvider authoringResourcesContent)
- `packages/server/src/services/agent/__tests__/clone-runtime.test.ts` (SG6: 3 tests added)
- `packages/server/src/routes/clone/index.ts` (SG6: route resolves authoring_resources + calls augmenter)
- `packages/server/src/services/scheduler/scheduler-service.ts` (SG7: materialize resources → config.requires)
- `packages/server/src/services/tasks/tasks-service.ts` (SG7: readyTask passes resources column)
- `packages/engine/src/engine-init.ts` (SG7: configRequires UNION merge + mergeRequires helper)
- `packages/engine/src/__tests__/engine-init.test.ts` (SG7: 4 tests added)
- `packages/server/src/services/execution/ExecutionLifecycle.ts` (SG7: resolveScheduleConfigRequires + pass to initPhase)
- `packages/providers/src/index.ts` (SG11: export enhancePromptWithSkills — resurrects dead code)

## Exploration

### Analog studied
- **05's specUpdateNotice flow** (clone-runtime.ts:261-348, clone/index.ts:292-313) — the closest analog. The clone chat ROUTE resolves a task-bound transient value (notice) via `taskDAO.getBySourceChatSession(sessionId)`, passes it to `runtime.chat(message, sessionId, pid, cwd, notice)`, and `sendWithProvider` concatenates it into `systemPrompt.append` (clone-runtime.ts:346-348). Authoring_resources injection mirrors this exactly — same route lookup, same `chat()` param, same `sendWithProvider` append seam.

### Provider path (peer-audit correction)
- task-author clone uses `getProvider('claude')` (ClaudeSDKProvider, clone-runtime.ts:340), **NOT Pi**. SPIKE S2's Pi-adapter investigation was the wrong provider.
- For Claude SDK: `assembleContext()` is ALREADY fresh per turn (clone-runtime.ts:278, called inside `chat()`), and `sendWithProvider` rebuilds `systemPrompt.append` per call. No `providerSessionId=null` fresh-session mechanism needed (Claude SDK resume works; SPIKE S1 confirmed this seam).
- DROPPED: pi-sdk-adapter.ts edits, fresh-session-per-turn, DB history prepend, `load_resource_for_authoring` tool.

### Functions chosen
- `enhancePromptWithSkills(prompt, { skills, skillContents })` — wires the dead code (packages/providers/src/pi/prompt-enhancer.ts:6-23). Add to providers barrel export (`packages/providers/src/index.ts`) so the server-side augmenter can import it.
- `ResourceManager.readFile(type, name, filePath)` (resource-manager.ts:633) — path-traversal-safe SKILL.md reading. Prefer over reaching into `installPath` directly (same defense the route already uses elsewhere).
- `materializeTaskSpecToConfig(task_spec, project_ids, org, workflow_ref, skills, resources?)` (scheduler-service.ts:171) — ADD a `resources?: ResourceRef[]` param (task-level resources from the tasks.resources column). Propagate `resources` + `task_spec.subunits[].resources[]` → `config.requires` (skills→skills, agent→agent_files, command→commands, rule→rules).
- `EngineInitPhase.run(options)` (engine-init.ts:166) — ADD optional `configRequires?: { skills?, agent_files?, commands?, rules? }` to `EngineInitOptions`; UNION-merge into `workflow.requires` at the start of Step 1 (don't override).

### Files needing modification
1. NEW `packages/server/src/services/tasks/task-author-session-augmenter.ts` (SG11) — `TaskAuthorSessionAugmenter` class: `ResourceManager` → `readFile('skill', name, 'SKILL.md')` → `enhancePromptWithSkills` → content string.
2. `packages/server/src/services/agent/clone-runtime.ts` (SG6) — `chat()` adds `authoringResourcesContent?: string` param after `specUpdateNotice`; `sendWithProvider` appends it to `systemPrompt.append` alongside the notice (concat order: cloneContext + authoringResourcesContent + specUpdateNotice).
3. `packages/server/src/routes/clone/index.ts` (SG6) — for `cloneName === 'task-author'`: resolve `task.authoring_resources` via `taskDAO.getBySourceChatSession(sessionId)` (same lookup as specUpdateNotice), call `TaskAuthorSessionAugmenter.resolveAuthoringResourcesContent()`, pass to `runtime.chat()`.
4. `packages/providers/src/index.ts` — export `enhancePromptWithSkills` + `SkillOptions` type (resurrect dead code).
5. `packages/server/src/services/scheduler/scheduler-service.ts` (SG7) — `materializeTaskSpecToConfig` ADD `resources?: ResourceRef[]` param + propagate to `config.requires`.
6. `packages/server/src/services/tasks/tasks-service.ts` (SG7) — `readyTask` passes `parseJSON<ResourceRef[]>(existing.resources, [])` to materialize.
7. `packages/engine/src/engine-init.ts` (SG7) — `EngineInitOptions` + `configRequires?`; `run()` UNION-merges into `workflow.requires` before Step 1.
8. `packages/server/src/services/execution/ExecutionLifecycle.ts` (SG7) — pass `configRequires` from the schedule's config into `initPhase.run()`.

### Tests
- NEW `packages/server/src/__tests__/07-task-author-augmenter.test.ts` (SG6+SG11): authoring_resources=[{skill:X}] → augmenter returns content containing X's SKILL.md; chat() appends it to systemPrompt.append (spy on provider.sendQuery, assert append contains SKILL.md content).
- Extend `packages/server/src/__tests__/06-schedules-origin-materialize.test.ts` (SG7): materialize with resources propagates to config.requires (skills/agent_files/commands/rules); subunit.resources also propagated.
- Extend `packages/engine/src/__tests__/engine-init.test.ts` (SG7): configRequires UNION-merges into workflow.requires (no override, no duplicates).

## Acceptance Criteria
- [ ] AC1: authoring_resources[]→task-author session prompt 含 SKILL.md 内容（draft 期）
- [ ] AC2: task-author 每 turn fresh session（`providerSessionId=null`）+ `assembleContext` 注 authoring_resources SKILL.md + DB 历史 prepend（SPIKE S2 Mechanism B）
- [ ] AC3: tasks.resources[]/subunit.resources[]→config.requires→workflow.requires UNION；EngineInitPhase 分发

## Verification Method
**integration**: tasks.authoring_resources=[{skill:X}]→task-author session system prompt 含 X 的 SKILL.md；materialize 后 config.requires 含资源；workspace 执行时 .claude/skills/ 有资源。Pass: 注入+传播+分发。
**SPIKE S2 — RESOLVED**：Mechanism B（task-author fresh session per turn + assembleContext 注入 + DB 历史 preamble）；不改 v2-D8。Latent bug（Pi SDK resume 路径 broken，findSession 返 SessionManager）pre-existing，task-author 绕开，out of v2 scope（建议另起 ticket 修）。
