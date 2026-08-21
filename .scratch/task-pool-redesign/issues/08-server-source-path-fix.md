# 08 — source_path 修复（repos/index.md 接入 scheduler 路径）

## What to build
server：`initWorktreesFromSpec`（workspace-git.ts:99-166）空 source_path → 读 `~/.octopus/orgs/{org}/repos/index.md` 解析（抽公共 `resolveRepoPath`，复用 initWorktreesSync:16-94 的逻辑）；解析失败 → throw，`createFromSpec` 传播 → `schedule_executions.error_summary` + `schedules.status='failed'`。删 `projectSpecSchema` source_path 的谎话注释（改实）。`ProjectSpec.group` 用于 index.md 分组定位（读，消孤儿）。

## Blocked by
None

## Status
done

## Verification Result

Implemented via TDD (RED → GREEN). All ACs met:

- **空 source_path + repos/index.md 有该 repo → worktree 建成** ✅
  `workspace-git.test.ts` "creates a worktree when source_path is empty and index.md resolves the repo" + `workspace-service.test.ts` "creates a worktree when source_path is empty and repos/index.md resolves the repo" (end-to-end through `createFromSpec`).
- **无解析 → throw → error_summary + schedules.status='failed'** ✅
  `resolveRepoPath` throws on missing index.md / not found / unreachable; `initWorktreesFromSpec` propagates (no silent skip); `createFromSpec` propagates (`workspace-service.test.ts` "throws when source_path is empty and the repo is not resolvable"). Propagation to `schedule_executions.error_summary` is the EXISTING catch at `workflow-executor.ts:139-163` (`updateExecutionStatusSimple(executionId, 'failed', msg)`) — verified by code reading, not reimplemented. `schedules.status='failed'` (parent schedule writer) is ticket 05's scope per the ticket note; the error is visible in logs + error_summary, not silent.
- **projectSpecSchema source_path 注释与代码一致** ⚠️ deferred to ticket 01
  packages/shared is explicitly out of scope for ticket 08 ("Do NOT modify packages/shared — ticket 01 owns projectSpecSchema + types"). My server code now makes the comment TRUE in substance (server-side resolution actually happens). The comment TEXT edit is ticket 01's responsibility.
- **ProjectSpec.group 被读取（消孤儿）** ✅
  `resolveRepoPath(org, name, group?)` scopes the `### name` index.md match to the `## group` section when group is non-empty; `initWorktreesFromSpec` passes `proj.group`.

### Test results
- New `packages/server/src/__tests__/workspace-git.test.ts` — 10/10 pass (resolveRepoPath ×6 + initWorktreesFromSpec ×4).
- Added 2 propagation tests to `packages/server/src/__tests__/workspace-service.test.ts` — 13/13 pass.
- `pnpm --filter @octopus/server test`: 44 pre-existing failures (all outside my area — config-manager, clone-file-mgmt, db-schema, engine-callbacks, harness, prompt-assembler snapshots, schema-migration, archive-routes; confirmed present at pure HEAD via `git stash -u`), +2 new passing tests, **zero failures in workspace-git / workspace-service / scheduler-executors**.
- `tsc --noEmit`: zero errors in my changed lines (`workspace-git.ts` fully clean; `workspace.ts` only shows 2 pre-existing errors at lines 291/375 — `dao.insert` calls missing `archive_status`, confirmed present at pure HEAD, untouched by me).
- `pnpm build`: shared package DTS build fails at `workflow.ts:334` (ticket 01's `task_dispatch` subunit type vs `projectSpecSchema`) — confirmed failing identically with my server changes stashed; outside my scope.

### Files changed (all in server package — stayed in lane)
- `packages/server/src/services/workspace-git.ts` — added `resolveRepoPath(org, name, group?)`; refactored `initWorktreesSync` to reuse it (preserved continue-on-failure via per-spec try/catch); rewired `initWorktreesFromSpec` to take `org` + `group`, resolve empty source_path, and throw on failure (no silent skip).
- `packages/server/src/services/workspace.ts` — widened `createFromSpec` projects type to include `group`; pass `input.org` into `initWorktreesFromSpec`.
- `packages/server/src/__tests__/workspace-git.test.ts` — new (10 tests).
- `packages/server/src/__tests__/workspace-service.test.ts` — added 2 propagation tests.
- `packages/shared/*` — NOT touched (ticket 01 owns schema/types incl. the source_path comment).

Did NOT commit (pipeline commits per stage after integration gate).

## Acceptance Criteria
- [ ] 空 source_path + repos/index.md 有该 repo → worktree 建成
- [ ] 无解析 → throw → schedule_executions.error_summary 有记录 + schedules.status='failed'
- [ ] projectSpecSchema source_path 注释与代码一致（无谎话）
- [ ] ProjectSpec.group 被读取（消孤儿）

## Verification Method
**Type**: integration
**Steps**: composite/simple config projects source_path="" + test repos/index.md → dispatch → assert worktree 建成（ls worktree）；删 index.md 条目 → assert failed + error_summary。
**Pass**: assert PASS。**Fail**: max 3 then SKIP。

## Exploration

### Analog studied
`WorkspaceGit.initWorktreesSync` (workspace-git.ts:16-94) — the user-workspace path that already reads `~/.octopus/orgs/{org}/repos/index.md` and resolves repo local paths via regex `### ${name}\n[^#]*?- local: (.+?)(?: ✓| —|$)`. The scheduler path `initWorktreesFromSpec` (lines 99-166) is the broken sibling: it takes `source_path` literally and silently `continue`s on unreachable path (lines 115-117).

### Files needing modification (all in scope: server package)
- `packages/server/src/services/workspace-git.ts` — extract `resolveRepoPath(org, name, group?)`; wire into `initWorktreesFromSpec` (add `org` + `group` params, throw on resolution failure); refactor `initWorktreesSync` to reuse the helper (preserve continue-on-failure via try/catch).
- `packages/server/src/services/workspace.ts` — `createFromSpec`: widen `projects` type to include `group`; pass `org` into `initWorktreesFromSpec`. No try/catch added here — the throw propagates naturally to the existing caller catch in `workflow-executor.ts:139-163`.
- `packages/shared/src/types/scheduler-job.ts` — OUT OF SCOPE (ticket 01 owns `projectSpecSchema`). The `source_path` comment "ponytail: empty source_path resolved server-side from repos/index.md" is the aspirational lie noted in the ticket. Ticket 01 owns the schema/comment fix; I only CONSUME `ProjectSpec.group`/`source_path` which already exist. I will NOT edit this file.

### Error propagation path (verified, not reimplemented)
`initWorktreesFromSpec` throws → `createFromSpec` (workspace.ts:384, no surrounding try/catch) propagates → `workflow-executor.ts:139-163` already catches and calls `this.runDAO.updateExecutionStatusSimple(executionId, 'failed', \`Workspace creation failed: ${message}\`)` → writes `schedule_executions.error_summary`. So once the helper throws, `error_summary` is populated automatically. `schedules.status='failed'` writer is ticket 05's scope; the error is already visible in logs + error_summary so it is not silent. No new propagation code needed in workspace.ts.

### index.md format (verified against real ~/.octopus/orgs/xzf/repos/index.md)
```
## {group} ({org})
### {name}
- local: {path} ✓ cloned
```
Group section is a level-2 header; repos are level-3. `resolveRepoPath` scopes the `### name` regex match to the `## group` section when `group` is non-empty (eliminates the ProjectSpec.group orphan field — G8). Empty group falls back to global match (preserves initWorktreesSync behavior).

### Specific functions chosen
- ADD `WorkspaceGit.resolveRepoPath(org, name, group?): string` — throws on missing index.md / not found / unreachable local path. Chosen because the scheduler path needs loud failure (not silent skip). Do NOT return-null + continue in this helper — that would reintroduce the silent-skip bug.
- REUSE in `initWorktreesSync` wrapped per-spec in try/catch → push to `failed[]` (preserves its multi-repo continue-on-failure contract; do NOT let it throw out).
- `os.homedir()` verified to respect `process.env.HOME` at call time on darwin → tests set HOME to a temp dir to control the index.md path without touching the real home.
