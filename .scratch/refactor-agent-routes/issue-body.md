## Problem Statement

`routes/agent/index.ts` is a 2568-line monolithic route file containing 45+ route handlers for the agent API. All business logic is inline in the route handlers, making the file impossible to navigate, test, or modify safely.

The `/sessions/:id/chat` endpoint alone is 536 lines. The file mixes concerns across 10+ domains: sessions, clones, tasks, evolution, skills, memory, onboarding, safety, debug, recovery, notifications, and observability.

## Solution

Split the monolithic route file into domain-specific route modules. Each module exports a function that registers routes on a Hono sub-app. The `index.ts` becomes a thin aggregator that imports and mounts each sub-module.

## Commits

### Phase 0: Extract Chat Route (biggest win)

**Commit 0.1**: Create `routes/agent/chat-routes.ts`. Move the `/sessions/:id/chat` handler (lines 466-1001, 536 lines) and `/sessions/:id/stop` into it. Export `createChatRoutes(deps)` function.

**Commit 0.2**: Update `routes/agent/index.ts` to import and mount `createChatRoutes`. Verify tests pass.

### Phase 1: Extract Clone Routes

**Commit 1.1**: Create `routes/agent/clone-routes.ts`. Move all 7 clone endpoints (`/clones`, `/clones/:name`, `/clones/:name/merge`, `/clones/:name/delegate`, `/clones/:name/delegate/cancel`, `/clones/:name/experiences`, `/clones/:name/activate`, `/clones/active`).

**Commit 1.2**: Update `index.ts` to mount `createCloneRoutes`. Verify tests.

### Phase 2: Extract Task Routes

**Commit 2.1**: Create `routes/agent/task-routes.ts`. Move 6 task endpoints (`/tasks`, `/tasks/:id/cancel`, `/tasks/:id/workspace`, `/tasks/reports`, `/tasks/reports/:id`, `/tasks/progress`, `/tasks/history`).

**Commit 2.2**: Update `index.ts` to mount `createTaskRoutes`. Verify tests.

### Phase 3: Extract Evolution Routes

**Commit 3.1**: Create `routes/agent/evolution-routes.ts`. Move 6 evolution endpoints (`/evolution/feedback`, `/self-check/evolve`, `/evolution/changelog`, `/evolution/experiences`, `/evolution/rollback/:id`, `/evolution/record`, `/evolution/experience`).

**Commit 3.2**: Update `index.ts` to mount `createEvolutionRoutes`. Verify tests.

### Phase 4: Extract Remaining Domains

**Commit 4.1**: Create `routes/agent/skill-routes.ts` for 4 skill endpoints.

**Commit 4.2**: Create `routes/agent/memory-routes.ts` for 3 memory endpoints.

**Commit 4.3**: Create `routes/agent/onboarding-routes.ts` for 3 onboarding endpoints.

**Commit 4.4**: Create `routes/agent/debug-routes.ts` for 2 debug endpoints.

**Commit 4.5**: Create `routes/agent/schedule-routes.ts` for 2 schedule endpoints.

**Commit 4.6**: Update `index.ts` to mount all new modules. Verify tests.

### Phase 5: Final Cleanup

**Commit 5.1**: Move remaining small routes (safety, recovery, notifications, observability, boundary, workflows) into appropriate sub-modules or a `misc-routes.ts`.

**Commit 5.2**: Clean up `index.ts` — it should be under 100 lines, just importing and mounting sub-modules.

**Commit 5.3**: Shared utilities (`SAFE_NAME_RE`, `validateNameParam`, `notImplemented`) move to a `routes/agent/utils.ts`.

## Decision Document

- **Extraction strategy**: Split by domain prefix. Each domain gets its own route file with a `createXRoutes(deps)` export.
- **Dependency passing**: Each sub-module receives the same `AgentRouteDeps` object. This avoids creating service layer abstractions prematurely.
- **No behavior changes**: This is a pure structural refactor. Route paths, request/response formats, and business logic remain identical.
- **Chat route first**: The `/sessions/:id/chat` handler is 536 lines and the highest-value extraction. It also has the most complex inline logic (SSE streaming, session management, etc.).

## Testing Decisions

- **Existing tests**: `server.test.ts` and `chat-route.test.ts` already exercise these routes via HTTP. They serve as regression tests.
- **No new unit tests for route handlers**: Route handlers are thin HTTP adapters. The existing integration tests provide sufficient coverage.

## Out of Scope

- **Extracting business logic into services**: The route handlers contain business logic that should eventually move into service classes. That is a separate, larger refactoring effort.
- **Changing API contracts**: All route paths and request/response formats remain unchanged.
- **Adding new routes**: Pure structural refactoring only.
