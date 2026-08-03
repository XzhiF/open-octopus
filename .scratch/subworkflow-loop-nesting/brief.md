# Requirement Brief — Nested Execution Hierarchy

## Overview

Fix two gaps in sub-workflow + loop nesting support: (1) add `parent_node_id` and `iteration_index` columns to `node_executions` for explicit hierarchy tracking, (2) fix UI grouping so sub-workflow children inside loop iterations display per-iteration instead of merged.

## Projects Involved

- [x] packages/engine (executors + callbacks — populate new DB columns)
- [x] packages/server (DB schema + query service — new columns + API response)
- [x] packages/web-app (execution-log-viewer — iteration grouping fix)

## Feature Scope

**Do:**

- Add `parent_node_id TEXT` and `iteration_index INTEGER` columns to `node_executions` (nullable, new data only)
- Populate `parent_node_id` when creating sub-workflow child node_executions
- Populate `iteration_index` when creating loop inner node_executions
- Fix execution-log-viewer UI: sub-workflow children inside a loop iteration grouped per iteration, not merged across iterations
- Handle 3 test scenarios: loop+sub-workflow, 3-layer sub-workflow nesting, sub-workflow+loop

**Don't:**

- No backfill migration for existing data (new columns nullable, old data stays null)
- No tree/collapsible UI (flat grouping only)
- No per-iteration VarPool isolation in loop executor
- No 4+ level deep nesting test scenarios

## Key Decisions

| # | Decision | Conclusion | Reason |
|---|---------|-----------|--------|
| D1 | Old data | No backfill — new columns nullable | Low value for historical data, adds migration complexity |
| D2 | UI rendering | Flat grouping, no tree | "Limited support" scope; tree UI is separate UX work |
| D3 | iteration_index semantics | Nearest loop's iteration | Outer loop info already encoded in parent_node_id chain |
| D4 | Test data | E2E script creates YAML → executes → verifies → cleans | Self-contained, R7 data isolation, repeatable |

## Data Model Changes

| Table | Operation | Details |
|-------|-----------|---------|
| `node_executions` | ADD COLUMN | `parent_node_id TEXT` — nullable, set for sub-workflow children |
| `node_executions` | ADD COLUMN | `iteration_index INTEGER` — nullable, set for loop inner nodes |

## API Contracts

| Method | Path | Side | Params | Response | Notes |
|--------|------|------|--------|----------|-------|
| GET | `/api/executions/:id/nodes` | Server | execution_id | Add `parent_node_id`, `iteration_index` fields to each node_execution item | Existing endpoint, additive change |

## Acceptance Criteria

| # | User Story | AC | Verification Method |
|---|-----------|-----|---------------------|
| AC1 | As a developer, I want to query parent-child relationships of nested nodes | Sub-workflow child nodes have `parent_node_id` = the sub_workflow node's ID | Integration: SQL query after executing test workflow |
| AC2 | As a developer, I want to know which iteration a node belongs to | Loop inner nodes have `iteration_index` correctly populated (nearest loop's iteration number) | Integration: SQL query after executing test workflow |
| AC3 | As a user, I want to see sub-workflow children grouped by iteration in the UI | Sub-workflow child events inside a loop are displayed per-iteration, not merged across iterations | Browser E2E: group headers contain iteration number |
| AC4 | As a user, 3-layer nested sub-workflows execute and display correctly | A→B→C nesting executes successfully, node_id scoped correctly (`B:C:nodeId`), parent_node_id chain complete | Integration + Browser E2E |
| AC5 | As a user, sub-workflows containing loops work correctly | Loop iterations inside a sub-workflow execute normally, UI renders correctly | Integration + Browser E2E |
| AC6 | As a user, existing non-nested workflows are unaffected | Nodes without parent_node_id/iteration_index have null values in new columns, UI behavior unchanged | Regression: run existing test workflow |

## Verification Strategy

### Global Config

- Environment: local dev (`pnpm dev --isolated`)
- Test user: admin account
- Data prefix: `E2E_TEST_NESTING_`
- Cleanup: DELETE test executions + node_executions after each test

### Per-layer Methods

#### Integration Tests (API + DB)

For each test scenario (loop+sub-workflow, 3-layer nesting, sub-workflow+loop):

1. Create test workflow YAML via API or file write
2. Execute workflow via API: `POST /api/executions`
3. Wait for completion (poll execution status)
4. SQL verification:
   ```sql
   SELECT node_id, node_type, parent_node_id, iteration_index
   FROM node_executions
   WHERE execution_id = ? AND node_id LIKE 'E2E_TEST_NESTING_%'
   ```
5. Assert:
   - Sub-workflow children: `parent_node_id IS NOT NULL`
   - Loop inner nodes: `iteration_index IS NOT NULL`
   - Iteration numbers sequential (0, 1, 2, ...)
6. Cleanup: DELETE execution and cascade

#### Browser E2E

1. Execute test workflow with loop+sub-workflow
2. Navigate to execution detail page
3. Open execution log viewer
4. Verify sub-workflow children appear in iteration-specific groups
5. Screenshot each iteration group as evidence
6. Cross-validate: UI groups ↔ API response ↔ DB records

### Prerequisites

- [ ] Server running on isolated port
- [ ] Web-app running
- [ ] E2E harness loaded (api.mjs, execution.mjs, browser.mjs, db.mjs)
- [ ] Test workflow YAML files prepared (3 scenarios)

## Test Workflow Scenarios

### Scenario 1: Loop containing Sub-workflow

```yaml
name: E2E_TEST_NESTING_loop_subwf
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
        bash: echo "Iteration $iteration prep"

      - id: call-analysis
        type: sub_workflow
        workflow: E2E_TEST_NESTING_child_analysis
        input_mapping:
          round: "$vars.iteration"
        output_mapping:
          result: analysis_result
```

### Scenario 2: 3-Layer Sub-workflow Nesting

```yaml
# E2E_TEST_NESTING_layer_a
name: E2E_TEST_NESTING_layer_a
nodes:
  - id: call-b
    type: sub_workflow
    workflow: E2E_TEST_NESTING_layer_b

# E2E_TEST_NESTING_layer_b
name: E2E_TEST_NESTING_layer_b
nodes:
  - id: call-c
    type: sub_workflow
    workflow: E2E_TEST_NESTING_layer_c

# E2E_TEST_NESTING_layer_c
name: E2E_TEST_NESTING_layer_c
nodes:
  - id: leaf
    type: bash
    bash: echo "Deepest level"
```

### Scenario 3: Sub-workflow containing Loop

```yaml
# E2E_TEST_NESTING_parent
name: E2E_TEST_NESTING_parent
nodes:
  - id: call-loop-wf
    type: sub_workflow
    workflow: E2E_TEST_NESTING_with_loop

# E2E_TEST_NESTING_with_loop
name: E2E_TEST_NESTING_with_loop
nodes:
  - id: inner-loop
    type: loop
    max_iterations: 2
    nodes:
      - id: step
        type: bash
        bash: echo "Loop step $iteration"
```

## Risks & Notes

- R1: New columns are nullable — existing queries must handle NULL gracefully
- R2: JSONL logger already writes iteration info; DB column is redundant but enables SQL queries
- R3: Frontend grouping fix depends on `node_log` events carrying iteration context — verify this is already the case before implementation

## Glossary

| Term | Meaning |
|------|---------|
| parent_node_id | The node ID of the immediate parent container (sub_workflow node or loop node) |
| iteration_index | The iteration number of the nearest containing loop (0-based) |
| Scoped ID | Node ID with parent prefix using `:` delimiter (e.g., `call-analysis:greet`) |
