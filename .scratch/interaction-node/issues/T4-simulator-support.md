# T4: Simulator Support — MockInteractionExecutor

## Status: done

## Scope
Add interaction node support to the workflow simulator:

1. **InteractionMockDef** (`packages/engine/src/simulator/types.ts`):
   ```ts
   export interface InteractionMockDef {
     summary: string
     rounds?: number
     vars_update?: Record<string, any>
     outputs?: Record<string, any>
   }
   ```

2. **MockInteractionExecutor** (`packages/engine/src/simulator/mock-executors.ts`):
   - Takes node, pool, mockDef
   - Returns completed result with summary as lastOutput
   - Applies vars_update to pool
   - Applies outputs mapping

3. **SimulatorExecutorFactory** (`packages/engine/src/simulator/mock-factory.ts`):
   - Add `"interaction"` case in createMockExecutor switch

4. **MockDef union**: Add `InteractionMockDef`

5. **Simulator schema** (if applicable): Add interaction mock schema for YAML test fixtures

## Files
- Modify: `packages/engine/src/simulator/types.ts`
- Modify: `packages/engine/src/simulator/mock-executors.ts`
- Modify: `packages/engine/src/simulator/mock-factory.ts`

## Verification Method
- Unit test: MockInteractionExecutor returns correct output
- Simulator can process a workflow with an interaction node
- `pnpm build` passes
