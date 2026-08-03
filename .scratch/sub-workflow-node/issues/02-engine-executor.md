# Ticket 2: Engine — SubWorkflowExecutor + Config + Factory Registration

## Status: DONE
## Priority: P0 (blocks server + UI)
## Depends on: Ticket 1
## Verification: `pnpm build` passes

### Changes

1. `packages/engine/src/executors/executor-config.ts`:
   - Add `SubWorkflowConfig` interface (extends CoreConfig)
   - Includes `workflowResolver`, `engineNodeResults`, `globalSessionId`, `branchSessionIds`, `inputs`

2. `packages/engine/src/executors/sub-workflow.ts` (NEW):
   - `SubWorkflowExecutor implements NodeExecutor`
   - Resolves child workflow via `workflowResolver`
   - Creates scoped child VarPool
   - Applies `input_mapping` (evaluate expressions from parent pool → child pool)
   - Creates child `WorkflowEngine` with child workflow + child pool
   - Executes child workflow
   - Applies `output_mapping` (read child pool → parent pool)
   - Handles `on_error`: `fail` (default) or `continue`
   - Recursion detection via visited workflow name stack
   - Returns `NodeExecutionResult`

3. `packages/engine/src/executor-factory.ts`:
   - Add `workflowResolver` to `ExecutorFactoryContext`
   - Add `case "sub_workflow"` in `createExecutor()`

4. `packages/engine/src/executors/loop.ts`:
   - Add `case "sub_workflow"` in inner `createExecutor()`

5. `packages/engine/src/engine.ts`:
   - Accept optional `workflowResolver` in constructor
   - Pass to `ExecutorFactoryContext`

### Acceptance Criteria
- SubWorkflowExecutor handles inline execution mode
- input_mapping evaluates `$vars.xxx` expressions
- output_mapping writes back to parent pool
- on_error: continue allows parent to proceed on child failure
- Recursion is detected and rejected
- `pnpm build` passes for `@octopus/engine`
