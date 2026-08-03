# Requirement Brief — dynamic-sub-workflow Iteration 2

## Overview
Gap-fix iteration for dynamic-sub-workflow. Targets 2 gaps from iteration 1 verification report (score 85/100).

## Context
- Root feature: dynamic-sub-workflow
- Previous iteration: dynamic-sub-workflow (score 85, GO)
- Branch: feat/dynamic-sub-workflow (same branch)

## Gap Targets

### Gap 1: Integration test with full mock agent → DAG → execute cycle (P1)
**What failed**: AC-2 only tested with isolated mock data. No test exercises the full DynamicSubWorkflowExecutor with a mock provider that simulates an agent response.
**Required fix**: Add integration test in `dynamic-sub-workflow.test.ts` that:
1. Creates a DynamicSubWorkflowExecutor with a mock provider
2. Mock provider returns valid DAG JSON
3. Executor generates, validates, persists, and executes the DAG
4. Asserts on NodeExecutionResult outputs (generated_workflow, node_count)
5. Asserts YAML file and meta.json are created in a temp directory

### Gap 2: Test mock data extraction (P3)
**What failed**: Assertion density 0.105 (below 0.15 threshold) due to large inline mock objects
**Required fix**: Extract shared mock fixtures to a `fixtures` block at top of file or separate file to reduce line count in test bodies

## Feature Scope
**Do:**
- Add 3-5 integration tests for full executor lifecycle with mock provider
- Extract mock data fixtures
- Improve assertion density to ≥ 0.15

**Don't:**
- Don't modify executor logic
- Don't modify UI code
- Don't fix E2E Playwright selectors (deferred — needs workspace component data-testid, separate effort)

## Acceptance Criteria
| # | AC | Verification Method |
|---|-----|-------------------|
| G1 | Integration test: mock provider → valid DAG → persist → execute → result | Unit test passes |
| G2 | Integration test: mock provider → invalid DAG → correction → execute | Unit test passes |
| G3 | Integration test: no meta.json → fresh generation | Unit test passes |
| G4 | Assertion density ≥ 0.15 | grep -c expect / wc -l |
