# T9: Simulator Integration Tests

## Status: pending

## Scope
Create simulator test fixtures for interaction nodes:

1. **Test workflow** (`packages/engine/src/__tests__/fixtures/interaction.test.yaml`):
   - Simple workflow: bash → interaction → bash (verify data flow)
   - Multiple scenarios in one fixture

2. **Test scenarios**:
   - **Happy path**: interaction node completes with summary, downstream bash receives vars
   - **Multi-round**: mock 3 rounds of conversation, verify round count
   - **exit_when**: interaction_exit_when triggers exit, verify node completes
   - **max_rounds**: exceed max_rounds, verify auto-complete
   - **Output mapping**: verify outputs field maps correctly to VarPool

3. **Test runner**: Integrate with existing simulator test infrastructure

## Files
- Create: `packages/engine/src/__tests__/simulator/interaction.test.ts`
- Create: `packages/engine/src/__tests__/fixtures/interaction-workflow.yaml`

## Dependencies
- T4 (Simulator support)

## Verification Method
- `pnpm test` passes all simulator tests
- Existing simulator tests still pass
