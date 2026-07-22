# Ticket 2: Engine init module — core logic

## Status: DONE

## Description

Create a standalone `EngineInitPhase` class in the engine package that encapsulates the engine_init logic: analyzing a workflow for resource references, provisioning them, and optionally syncing git. This class is called by the server before `engine.run()`.

## Files

- `packages/engine/src/engine-init.ts` (new)
- `packages/engine/src/index.ts` (export)
- `packages/engine/src/__tests__/engine-init.test.ts` (new)

## Interface

```typescript
export interface EngineInitOptions {
  workspacePath: string
  workflow: WorkflowDef
  callbacks: EngineCallbacks
  syncMainBranch?: boolean  // default true
  gitOps?: GitOpsLike       // injected for testability
  resourceProvisioner?: ResourceProvisionerLike  // injected for testability
  resourcePreflight?: ResourcePreFlightLike      // injected for testability
}

export interface EngineInitResult {
  status: 'completed' | 'failed'
  durationMs: number
  skillsCopied: number
  agentsCopied: number
  gitSyncResults: Array<{ project: string; success: boolean; error?: string }>
}

export class EngineInitPhase {
  async run(options: EngineInitOptions): Promise<EngineInitResult>
}
```

## Behavior

1. Fire `onNodeStart('__engine_init__', 'bash')`
2. Run `ResourcePreFlight.analyze(workflow)` to get manifest
3. Run `ResourcePreFlight.check(manifest, workspacePath)` to find missing
4. If missing resources exist, run `ResourceProvisioner.provision(missing, workspacePath)`
   - If provision fails → fire error log, fire `onNodeEnd('failed')`, throw
5. If `syncMainBranch` is true, iterate workspace projects and call `gitOps.pullLatest()`
   - If pull fails for a project → fire warning log, continue
6. Fire `onNodeEnd('completed', durationMs)`

## TDD Seams

- **Seam 1**: `EngineInitPhase.run()` — public interface
- **Seam 2**: Callbacks are observed via mock EngineCallbacks
- **Seam 3**: Dependencies (gitOps, preflight, provisioner) are injected

## Unit Tests

1. Given a workflow with 2 skills and 1 agent, verifies preflight.analyze is called
2. Given missing resources, verifies provisioner.provision is called with correct args
3. Given provision failure, verifies onNodeEnd is called with 'failed' and error is thrown
4. Given syncMainBranch=true and 3 projects, verifies pullLatest called for each
5. Given pull failure for one project, verifies warning log and continued execution
6. Given syncMainBranch=false, verifies no git operations
7. Verifies onNodeStart is called with '__engine_init__' and 'bash'
8. Verifies duration is tracked

## Verification

- `pnpm test -- packages/engine/src/__tests__/engine-init.test.ts` passes
- `pnpm build` succeeds
