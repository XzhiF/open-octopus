# T2: Core DynamicSubWorkflowExecutor

**Status:** done
**Priority:** P0
**Depends on:** T1

## Scope

Build the `DynamicSubWorkflowExecutor` class with:
- File name resolution (plain / loop / custom)
- Context-aware rerun detection (input hash)
- Agent-based DAG generation (mocked in tests)
- Validation harness integration with correction loop
- YAML + meta.json persistence
- DAG execution via child WorkflowEngine delegation

## Changes

### engine/src/executors/executor-config.ts
- Add `DynamicSubWorkflowConfig` interface (extends CoreConfig)

### engine/src/executors/dynamic-sub-workflow.ts (NEW)
- `DynamicSubWorkflowExecutor` class implementing `NodeExecutor`
- File name resolution logic
- Input hash comparison with meta.json
- Agent call for DAG generation (with structured prompt including DAG schema contract)
- Validation + correction loop (max 3 rounds)
- YAML serialization and file persistence
- Meta.json creation and update
- Child WorkflowEngine delegation for execution

### engine/src/executor-factory.ts
- Add `case "dynamic_sub_workflow"` in the switch statement
- Import `DynamicSubWorkflowExecutor`
- Wire up config similar to sub_workflow but with `outputDir`

### engine/src/index.ts
- Export `DynamicSubWorkflowExecutor` and `DynamicSubWorkflowConfig`

## Tests (Write First)

### Extend packages/engine/src/__tests__/dynamic-sub-workflow.test.ts

```
describe("DynamicSubWorkflowExecutor")
  describe("File name resolution")
    ✅ plain: parent "pipeline" + node "plan" → "pipeline__plan.yaml"
    ✅ custom: node.workflow = "ticket-dag" → "ticket-dag.yaml"
    ✅ loop iter 2: "pipeline__plan-iter2.yaml"

  describe("Rerun detection")
    ✅ meta.json exists + same hash → skip generation, load existing YAML
    ✅ meta.json exists + different hash → regenerate
    ✅ no meta.json → generate fresh

  describe("Generation + Validation")
    ✅ mock agent returns valid DAG JSON → L1/L2/L3 pass → persist YAML
    ✅ mock agent returns DAG with cycle → L2 fails → correction agent fixes → pass
    ✅ mock agent always returns invalid → 3 rounds → node fails

  describe("Persistence")
    ✅ YAML file written to workflows/ directory
    ✅ meta.json written with correct fields
    ✅ meta.json updated with execution_status after run

  describe("Execution")
    ✅ generated DAG executed via child engine → results propagated
    ✅ child nodes registered via ensureNodeExecution with scoped IDs
    ✅ on_error: continue → node completes even if child fails
```

## Verification Method

```bash
pnpm test -- packages/engine/src/__tests__/dynamic-sub-workflow.test.ts
pnpm build --filter @octopus/engine
```
