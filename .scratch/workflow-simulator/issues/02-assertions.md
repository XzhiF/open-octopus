# Ticket 2: Assertion Engine

## Scope
- `packages/engine/src/simulator/assertions.ts`
- `packages/engine/src/__tests__/simulator/assertions.test.ts`

## Assertion Types
1. status match
2. vars match (key-value against VarPool snapshot)
3. node_trace (executed, skipped, order)
4. node_outputs (per-node lastOutput, outputs, status)
5. logs (contains, not_contains)

## Acceptance Criteria
- 18+ test cases from brief verification plan pass
- All edge cases handled (empty assertions, missing nodes, etc.)
