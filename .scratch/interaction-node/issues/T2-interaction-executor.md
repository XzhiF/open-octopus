# T2: InteractionExecutor — Core Engine Executor

## Status: done

## Scope
Create the `InteractionExecutor` class in `packages/engine/src/executors/interaction.ts`:

1. **First call** (no completion data): Returns `pending_interaction` status with `interactionMetadata`
2. **Resume call** (with completion data): Processes vars_update, applies outputs mapping, returns `completed`

Follow the ApprovalExecutor pattern:
- Constructor: `(node, pool, config: InteractionConfig)`
- Config includes: `completionData?`, `signal?`, `loopContext?`, `crossExecResolver?`, `executionId?`, `nodeOutputs?`, `cwd?`
- `completionData: { summary: string, vars_update?: Record<string, any> }`

Key behaviors:
- Resolves `$file:` and `$vars` in the interaction_agent prompt
- Evaluates `interaction_exit_when` expression against VarPool
- Counts rounds via `interaction_max_rounds`
- Applies `outputs` mapping (same as Agent node)
- Updates VarPool with `vars_update` data

## Files
- Create: `packages/engine/src/executors/interaction.ts`
- Modify: `packages/engine/src/executors/executor-config.ts` (add InteractionConfig)
- Modify: `packages/engine/src/executors/types.ts` (add InteractionMetadata)
- Modify: `packages/engine/src/index.ts` (export new classes)

## Verification Method
- Unit test: first call returns `pending_interaction` with correct metadata
- Unit test: resume call with completion data returns `completed` with vars_update applied
- `pnpm build` passes for @octopus/engine
