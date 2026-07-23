## Problem Statement

`ExecutionLifecycle` is a 2047-line God Class with ~40 methods covering 8+ distinct responsibilities. It is the single largest class in the codebase and the central orchestrator of all execution behavior. This makes it:

- **Hard to modify/extend**: Adding new execution behavior (e.g., a new lifecycle event) risks breaking unrelated functionality. Every change touches this file.
- **Hard to test**: Zero test coverage exists. The class depends on 10 injected services, inline filesystem operations, git operations, and SSE — making unit testing infeasible without decomposition.
- **Hard to understand**: A developer reading this class must hold engine construction, callback building, git branching, hook execution, event querying, background runners, token tracking, and CRUD all in their head simultaneously.

Previous extraction work created `EngineFactory`, `EngineCallbacks`, `HookExecutor`, `GitBranchManager`, and `StateFileManager` as standalone classes with interfaces, but **they were never wired into** `ExecutionLifecycle`. The god class retains all original code alongside the unused extracted classes. The extracted `EngineCallbacks` is a simplified version missing observability, branch timing, and knowledge service integration.

## Solution

Complete the decomposition by:
1. **Aligning** the already-extracted classes with the God Class behavior (they are simplified versions)
2. **Wiring them in** to replace the inline implementations in `ExecutionLifecycle`
3. **Extracting** the remaining unseparated responsibilities into focused classes
4. **Writing characterization tests** at each step to ensure behavioral parity

Target: `ExecutionLifecycle` becomes a ~500-line orchestrator that delegates to focused collaborators.

## Commits

### Phase 0: Characterization Tests (lock existing behavior)

**Commit 0.1**: Create `ExecutionLifecycle.test.ts` with smoke tests for `create()` and `delete()` — the simplest methods. Use mock DAO and mock SSE. These tests document the current contract.

**Commit 0.2**: Add tests for `buildCallbacks()` — verify that `onNodeStart`, `onNodeEnd`, `onStatusChange`, `onComplete`, and `onAgentEvent` call the correct DAO methods and emit the correct SSE events. This is critical because the extracted `EngineCallbacks` is a simplified version and we need to lock the real behavior before replacing.

**Commit 0.3**: Add tests for `reconstructEngine()` — verify that it reads from snapshot path, falls back to workflow service, and restores var_pool. Lock the engine creation contract.

**Commit 0.4**: Add tests for the query methods: `getLogEvents()`, `getAgentEvents()`, `getLoopIterationSummary()`, `getTokenUsagesPerStep()`, `getTokenUsagesForExecution()`. These are read-only and safe to test.

**Commit 0.5**: Add tests for `syncStateJson()` and `getStateJson()` — document the filesystem contract.

### Phase 1: Wire in EngineFactory

**Commit 1.1**: Update `EngineFactory` to match the God Class behavior. Specifically, `reconstructEngine()` in the God Class reads from snapshot files on disk (not just workflow service), resolves providers using `collectNodeEngines`, and handles the `PipelineConfig`. Align the extracted class.

**Commit 1.2**: Add `engineFactory: IEngineFactory` parameter to `ExecutionLifecycle` constructor. In the constructor, default to `new EngineFactory(...)` if not provided (backward compat).

**Commit 1.3**: Replace `reconstructEngine()` and `resolveProviders()` in `ExecutionLifecycle` with delegation to `this.engineFactory`. Remove the inline implementations.

**Commit 1.4**: Update `ExecutionService` to construct `EngineFactory` and pass it to `ExecutionLifecycle`. Run tests to verify parity.

### Phase 2: Align and Wire in EngineCallbacks

**Commit 2.1**: Port the missing behavior from God Class `buildCallbacks()` into `EngineCallbacks`:
- Branch start time tracking (`branchStartTimes` map + `durationMs` computation)
- Observability integration (`this.observability.resetDegraded()`, `recordNodeEvent`)
- Agent event deduplication and persistence to DB (`this.dao.insertAgentEvent`)
- Knowledge service retire throttle on `onComplete`
- Error tracker integration on node failure
- `cleanupOrphanedNodes` call on completion
- External callback merging (`_externalCallbacks`)
- Privacy filter application to agent events

**Commit 2.2**: Add tests for the enhanced `EngineCallbacks` that verify all the above behaviors using mocks.

**Commit 2.3**: Wire `EngineCallbacks` into `ExecutionLifecycle` — replace `buildCallbacks()` with delegation. Pass `_externalCallbacks` and required services.

**Commit 2.4**: Remove the inline `buildCallbacks()` from `ExecutionLifecycle`. Run tests.

### Phase 3: Wire in HookExecutor

**Commit 3.1**: Port `executeAgentHookServer()` from `ExecutionLifecycle` into `HookExecutor`. The extracted version currently throws for agent hooks; the God Class version uses `AgentExecutor` and `AgentNodeRunner`.

**Commit 3.2**: Port `drainPendingHooks()` logic into `HookExecutor` or keep in `ExecutionLifecycle` as a thin delegation.

**Commit 3.3**: Wire `HookExecutor` into `ExecutionLifecycle` — replace inline hook execution methods with delegation.

**Commit 3.4**: Remove `executeWorkflowHooks()`, `executeBashHookServer()`, `executeAgentHookServer()` from `ExecutionLifecycle`. Run tests.

### Phase 4: Wire in GitBranchManager

**Commit 4.1**: Compare `GitBranchManager` interface with the God Class git methods. The God Class uses `gitOps` service (which wraps `execFile`), while `GitBranchManager` uses `execFile` directly. Align them — prefer `gitOps` for consistency with the rest of the codebase.

**Commit 4.2**: Wire `GitBranchManager` (or adapted version) into `ExecutionLifecycle` for `ensureCleanWorkspace()`, `createForkBranch()`, `switchToExecutionBranch()`, `recordStartCommits()`, `recordEndCommits()`, `rollbackToStart()`.

**Commit 4.3**: Remove inline git methods from `ExecutionLifecycle`. Run tests.

### Phase 5: Wire in StateFileManager

**Commit 5.1**: Port the complex `syncStateJson()` from `ExecutionLifecycle` into `StateFileManager`. The extracted version saves per-execution JSON; the God Class version writes a unified `executions.json` aggregating all workspace executions.

**Commit 5.2**: Wire `StateFileManager` into `ExecutionLifecycle` for `syncStateJson()` and `getStateJson()`.

**Commit 5.3**: Remove inline state file methods from `ExecutionLifecycle`. Run tests.

### Phase 6: Extract ExecutionQueryService

**Commit 6.1**: Create `ExecutionQueryService` class with interface `IExecutionQueryService`. Move `getLogEvents()`, `getAgentEvents()`, `getLoopIterationSummary()`, `getWorkflowContent()`, `getTokenUsagesPerStep()`, `getTokenUsagesForExecution()`, and `streamEvents()` into it.

**Commit 6.2**: Add tests for `ExecutionQueryService` — it is read-only so testing is straightforward (mock DAO, verify output format).

**Commit 6.3**: Wire `ExecutionQueryService` into `ExecutionLifecycle` — delegate all query methods.

**Commit 6.4**: Remove inline query methods from `ExecutionLifecycle`. Update `ExecutionService` facade to delegate queries directly to `ExecutionQueryService` instead of through `ExecutionLifecycle`. Run tests.

### Phase 7: Extract ExecutionRunner

**Commit 7.1**: Create `ExecutionRunner` class. Move `runResumeInBackground()`, `runApproveInBackground()`, `runRejectInBackground()`, and `abortAndWait()` into it. These methods share a pattern: they wrap async engine execution with error handling, status updates, and cleanup.

**Commit 7.2**: Add tests for `ExecutionRunner` — mock the engine and verify the error handling / status update / cleanup pattern.

**Commit 7.3**: Wire `ExecutionRunner` into `ExecutionLifecycle` — the lifecycle methods (`start`, `retry`, `resume`, `approve`) delegate async engine execution to the runner.

**Commit 7.4**: Remove inline runner methods from `ExecutionLifecycle`. Run tests.

### Phase 8: Final Cleanup

**Commit 8.1**: Move remaining node helper methods (`findPausedNode`, `findFailedNode`, `findFailedNodeError`, `findNodeDef`, `isWorkflowNodeId`, `collectAllNodes`, `ensureNodeExecutions`, `ensureNodeEdges`, `computeBranch`) into a `NodeHelper` utility module (pure functions, no class needed).

**Commit 8.2**: Update `interfaces.ts` — add `IExecutionQueryService`, `IExecutionRunner` interfaces. Remove stale `// Task N` comments. Update `IExecutionLifecycle` to reflect the simplified interface.

**Commit 8.3**: Update `ExecutionService` facade to use the new dependency graph. Each method should delegate to the most specific collaborator.

**Commit 8.4**: Remove dead code, unused imports, and `lastRetireAt` / `RETIRE_INTERVAL_MS` from `ExecutionLifecycle` (moved to `EngineCallbacks` or `KnowledgeService`).

**Commit 8.5**: Final verification — run all tests, verify `ExecutionLifecycle` is under ~500 lines, update `CONTEXT.md` with the new architecture.

## Decision Document

- **Extraction strategy**: "Complete the started extractions" — the previous attempt identified the right seams; we align behavior and wire them in rather than redesigning from scratch.
- **EngineCallbacks alignment**: The God Class version is authoritative. All missing behavior (observability, branch timing, knowledge retire, external callbacks, privacy filter, error tracker) must be ported to the extracted class before wiring in.
- **GitBranchManager interface mismatch**: The God Class uses `gitOps` (a shared service), the extracted class uses raw `execFile`. We align to `gitOps` for consistency with the rest of the server codebase.
- **ExecutionQueryService separation**: Read-only query methods are separated from write/mutation methods. This allows the `ExecutionService` facade to bypass `ExecutionLifecycle` for queries, reducing coupling.
- **ExecutionRunner separation**: Background async runners are the most complex part of the lifecycle (error handling, cleanup, status transitions). Extracting them makes the core lifecycle methods (start/retry/resume/approve) readable as orchestration-only.
- **NodeHelper as pure functions**: Node traversal helpers (`findPausedNode`, `findNodeDef`, etc.) have no state — they are pure functions on node arrays. A utility module is more appropriate than a class.
- **`create()` and `delete()` stay in ExecutionLifecycle**: These are thin wrappers around DAO calls with some side effects. They belong to the lifecycle orchestrator.
- **`ServiceContext` pattern**: The extracted classes use a shared `ServiceContext` object rather than individual service injections. This keeps constructor signatures manageable.
- **Backward compatibility**: Constructor parameters default to `new ...()` if not provided, allowing gradual migration without breaking existing callers.

## Testing Decisions

- **What makes a good test**: Tests should verify external behavior (DAO calls, SSE events, filesystem writes) not internal implementation details. Mock at the boundary: mock `ExecutionDAO`, mock `SSEService`, mock filesystem.
- **Phase 0 characterization tests**: Written BEFORE any refactoring. They lock the current behavior of `ExecutionLifecycle` so we can safely replace internals. These are integration-style tests with the real `ExecutionLifecycle` and mocked dependencies.
- **Per-extraction unit tests**: Each extracted class gets its own test file testing the class in isolation with mocked dependencies. Written BEFORE wiring in (commits x.2).
- **Wiring-in verification**: After each wiring commit, run the Phase 0 characterization tests to verify behavioral parity. These serve as regression tests.
- **Modules tested**:
  - `ExecutionLifecycle` (characterization, Phase 0)
  - `EngineFactory` (unit tests, Phase 1)
  - `EngineCallbacks` (unit tests, Phase 2)
  - `HookExecutor` (unit tests, Phase 3)
  - `ExecutionQueryService` (unit tests, Phase 6)
  - `ExecutionRunner` (unit tests, Phase 7)
- **Prior art**: `packages/engine/src/__tests__/` has patterns for mocking `WorkflowEngine`, `VarPool`, and `parseWorkflow`. Server-side service tests should follow similar patterns with Vitest.

## Out of Scope

- **Refactoring `ExecutionService` facade**: The facade is already thin and well-structured. Minor updates to use new collaborators are in scope; redesigning the facade API is not.
- **Refactoring `RecoveryManager`**: It is 257 lines and reasonably scoped. Leave it alone.
- **Changing the public API**: `ExecutionService` public methods must remain unchanged. All refactoring is internal.
- **Adding new execution features**: This refactor is purely structural. No new lifecycle events, no new query methods, no new hook types.
- **Database schema changes**: All DAO interactions remain unchanged.
- **SSE event format changes**: The SSE event contract with the frontend must remain unchanged.
- **Engine package changes**: `@octopus/engine` is not modified. All changes are in `@octopus/server`.

## Further Notes

- The `buildCallbacks()` method in the God Class is the single most complex method (~220 lines) with the most hidden behavior. Phase 2 (aligning `EngineCallbacks`) is the highest-risk step and should get the most review attention.
- `ExecutionLifecycle` has a circular-ish dependency with `RecoveryManager` (RecoveryManager imports ExecutionLifecycle type). This should be monitored during refactoring but is not a blocker.
- The `_externalCallbacks` map allows external code to register additional engine callbacks per execution. This feature is used by the agent session system and must be preserved.
- `lastRetireAt` / `RETIRE_INTERVAL_MS` throttle for knowledge rule retirement is a cross-cutting concern that currently lives in `ExecutionLifecycle` but conceptually belongs with the knowledge service integration. Consider moving the throttle to `KnowledgeService` itself.
