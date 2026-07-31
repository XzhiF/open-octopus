# T3: Executor Factory + Engine Integration

## Status: done

## Scope
Wire InteractionExecutor into the ExecutorFactory and WorkflowEngine:

1. **ExecutorFactory** (`packages/engine/src/executor-factory.ts`):
   - Add `"interaction"` case in the switch statement
   - Create InteractionExecutor with proper config (similar to agent case)

2. **WorkflowEngine** (`packages/engine/src/engine.ts`):
   - Handle `pending_interaction` status (same pattern as `pending_approval`)
   - Add `pendingInteractionNodeId` tracking
   - Support resume from interaction (analogous to resume from approval)
   - Add `interactionMetadata` to ExecutionResult when paused

3. **ExecutionResult** type:
   - Add `"pending_interaction"` to status union

## Files
- Modify: `packages/engine/src/executor-factory.ts`
- Modify: `packages/engine/src/engine.ts`

## Verification Method
- `pnpm build` passes for @octopus/engine
- Existing executor tests still pass (`pnpm test` in engine package)
