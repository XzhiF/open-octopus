# Ticket 9: Golden Workflow Integration Tests

## Scope
- `packages/engine/src/__tests__/simulator/golden/` — 5 inline workflow tests
- golden-linear, golden-branch, golden-loop, golden-swarm, golden-failure

## Acceptance Criteria
- All 5 golden workflows pass with hand-calculated expectations
- Tests verify end-to-end: parse → simulate → assert
