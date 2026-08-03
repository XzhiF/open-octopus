# Ticket 5: Integration Test — Verify DB columns populated correctly

## Status: DONE

## Scope

Write a Vitest integration test that:
1. Creates and executes test workflows with nested sub-workflows and loops
2. Verifies `parent_node_id` and `iteration_index` are populated correctly in `node_executions`
3. Tests all 3 scenarios from the brief
4. Cleans up test data

## Dependencies

- Tickets 1-3 must be complete (schema + engine + server persistence)

## Files to Create/Change

| File | Change |
|------|--------|
| `packages/server/src/__tests__/nested-execution-hierarchy.test.ts` | New integration test file |

## Implementation Details

### Test Setup

Use existing test infrastructure from `packages/server/src/__tests__/execution-lifecycle.test.ts`. Set up:
- In-memory SQLite database with schema
- Mock workflow resolver for child workflows
- EngineCallbacks wired to DAO

### Test Scenarios

#### Scenario 1: Loop containing Sub-workflow
```yaml
name: test-loop-subwf
nodes:
  - id: greet
    type: bash
    bash: echo "Starting"
  - id: review-loop
    type: loop
    max_iterations: 3
    nodes:
      - id: prep
        type: bash
        bash: echo "prep"
      - id: call-analysis
        type: sub_workflow
        workflow: test-child-analysis
```

Assertions:
- `call-analysis` child nodes have `parent_node_id = "call-analysis"`
- `prep` nodes have `iteration_index` = 0, 1, 2 (one per iteration)
- `call-analysis` child nodes have `iteration_index` = 0, 1, 2 (matching their containing iteration)

#### Scenario 2: 3-Layer Sub-workflow Nesting
```yaml
# layer-a calls layer-b calls layer-c
```

Assertions:
- layer-b child: `parent_node_id = "call-b"`
- layer-c child: `parent_node_id = "call-c"`
- Full parent chain traceable

#### Scenario 3: Sub-workflow containing Loop
```yaml
# parent calls child-with-loop which has inner-loop with 2 iterations
```

Assertions:
- inner-loop's `step` node: `iteration_index` = 0, 1
- child-with-loop nodes: `parent_node_id = "call-loop-wf"`

### Test Structure

```ts
describe("Nested execution hierarchy", () => {
  let db: Database.Database
  let dao: ExecutionDAO

  beforeEach(() => {
    db = new Database(":memory:")
    applySchema(db)
    dao = new ExecutionDAO(db)
  })

  afterEach(() => { db.close() })

  it("populates parent_node_id for sub-workflow children", async () => {
    // Setup + execute workflow
    // Query node_executions
    // Assert parent_node_id values
  })

  it("populates iteration_index for loop inner nodes", async () => {
    // Setup + execute workflow
    // Query node_executions
    // Assert iteration_index values
  })

  it("handles 3-layer sub-workflow nesting", async () => {
    // Execute A → B → C
    // Verify parent_node_id chain
  })

  it("handles sub-workflow containing loop", async () => {
    // Execute parent → child-with-loop
    // Verify iteration_index for inner loop nodes
    // Verify parent_node_id for child nodes
  })

  it("leaves new columns null for non-nested nodes", async () => {
    // Execute simple workflow
    // Assert parent_node_id IS NULL and iteration_index IS NULL
  })
})
```

## Verification Method

```bash
pnpm test -- packages/server/src/__tests__/nested-execution-hierarchy.test.ts
```

## Acceptance Criteria

- [ ] All 3 scenarios pass
- [ ] parent_node_id correctly set for sub-workflow children
- [ ] iteration_index correctly set for loop inner nodes (0-based, sequential)
- [ ] 3-layer nesting: complete parent chain traceable
- [ ] Non-nested nodes have null values for new columns
- [ ] Test data cleaned up after each test
