# Ticket 3: Server integration — call EngineInitPhase in ExecutionLifecycle.start

## Status: DONE

## Description

Wire `EngineInitPhase` into `ExecutionLifecycle.start()` so that it runs before `engine.run()`. Pass `syncMainBranch` from the API request body.

## Files

- `packages/server/src/services/execution/ExecutionLifecycle.ts` (modify `start()`)
- `packages/server/src/routes/execution.ts` (parse `syncMainBranch` from body)
- `packages/server/src/services/execution-service-registry.ts` (pass param through)

## Changes

### execution.ts route

```typescript
// Before
const body = await c.req.json<{ inputValues?: Record<string, string> }>().catch(() => ({}))
const result = await svc.service.start(executionId, body.inputValues)

// After
const body = await c.req.json<{ inputValues?: Record<string, string>; syncMainBranch?: boolean }>().catch(() => ({}))
const result = await svc.service.start(executionId, body.inputValues, body.syncMainBranch)
```

### ExecutionLifecycle.start

Add `syncMainBranch?: boolean` parameter. Before `engine.run()`, instantiate `EngineInitPhase` and call `run()`.

```typescript
async start(id: string, inputValues?: Record<string, string>, syncMainBranch?: boolean): Promise<ExecutionRow> {
  // ... existing setup up to engine creation ...
  
  // engine_init phase
  const initPhase = new EngineInitPhase()
  try {
    await initPhase.run({
      workspacePath: this.workspacePath,
      workflow: wf.parsed,
      callbacks: this.buildCallbacks(id),
      syncMainBranch: syncMainBranch ?? true,
      gitOps,
      resourcePreflight: new ResourcePreFlight(),
      resourceProvisioner: new ResourceProvisioner(getResourceRegistry().get()),
    })
  } catch (err) {
    // Init failure = workflow failure
    this.updateStatus(id, "failed", { completed_at: new Date().toISOString() })
    this.sse.emit(this.workspaceId, { event: "error", data: { executionId: id, error: err.message } })
    return this.dao.findById(id)!
  }
  
  // ... existing engine.run() ...
}
```

### Facade pass-through

The `start` method on the service facade must accept and forward `syncMainBranch`.

## Verification

- `pnpm build` succeeds
- `pnpm test -- packages/server` passes
- Manual E2E: execute workflow, see `__engine_init__` node in log viewer
