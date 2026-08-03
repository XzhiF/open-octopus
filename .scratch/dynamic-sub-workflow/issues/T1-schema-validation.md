# T1: Schema Extension + Validation Harness

**Status:** done
**Priority:** P0
**Depends on:** —

## Scope

Extend the shared type system and build the three-layer validation harness as pure functions.

## Changes

### shared/src/types/workflow.ts
- Add `"dynamic_sub_workflow"` to `NodeDef.type` union (line 152)
- Add `"dynamic_sub_workflow"` to `NodeSchema` z.enum (line 249)

### shared/src/types/workspace.ts
- Add `"dynamic_sub_workflow"` to `NodeTypeSchema` z.enum (line 79-81)

### engine/src/executors/dynamic-sub-workflow-validation.ts (NEW)
- `validateL1Structure(json: unknown): ValidationResult` — checks JSON shape, nodes array, required fields (id, type, prompt)
- `validateL2Graph(nodes: NodeDef[]): ValidationResult` — cycle detection (reuse `detectCycles` from graph-utils), depends_on reference checks
- `validateL3Semantics(nodes: NodeDef[]): ValidationResult` — type whitelist (agent only), prompt non-empty
- `runValidationPipeline(json: unknown): { result: ValidationResult; errors: string[] }` — runs L1→L2→L3 in sequence, collects all errors

### engine/src/executors/dynamic-sub-workflow-hash.ts (NEW)
- `computeInputHash(inputSnapshot: Record<string, unknown>): string` — SHA-256 of canonical JSON
- `buildInputSnapshot(node: NodeDef, pool: VarPool, nodeResults: Record<string, NodeExecutionResult>): Record<string, unknown>` — collect upstream data

## Tests (Write First)

### packages/engine/src/__tests__/dynamic-sub-workflow.test.ts

```
describe("Validation Harness")
  describe("L1 Structure")
    ✅ valid JSON with nodes array → valid
    ✅ missing nodes array → invalid
    ✅ node missing id → invalid
    ✅ node missing type → invalid
    ✅ node missing prompt → invalid
    ✅ non-object input → invalid

  describe("L2 Graph")
    ✅ valid DAG (no cycles) → valid
    ✅ circular dependency → invalid
    ✅ depends_on references non-existent node → invalid
    ✅ self-referencing node → invalid

  describe("L3 Semantics")
    ✅ all agent nodes → valid
    ✅ bash node in DAG → invalid
    ✅ empty prompt → invalid
    ✅ sub_workflow node in DAG → invalid

  describe("Input Hash")
    ✅ same input → same hash
    ✅ different input → different hash
    ✅ key ordering doesn't affect hash (canonical JSON)
```

## Verification Method

```bash
pnpm test -- packages/engine/src/__tests__/dynamic-sub-workflow.test.ts
pnpm build --filter @octopus/shared
```
