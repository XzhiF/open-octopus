# T8: Unit Tests — InteractionExecutor + Schema

## Status: done

## Scope
Write comprehensive unit tests:

1. **InteractionExecutor tests** (`packages/engine/src/__tests__/interaction.test.ts`):
   - First call returns `pending_interaction` with correct metadata
   - Resume with completion data returns `completed`
   - `vars_update` applied to VarPool correctly
   - `outputs` mapping applied correctly
   - `interaction_exit_when` expression evaluation (true → complete, false → continue)
   - `interaction_max_rounds` counter logic
   - Cancel/abort handling
   - Prompt variable resolution ($vars, $file:)

2. **Schema validation tests**:
   - Valid interaction node passes schema
   - Invalid fields rejected
   - Default values applied correctly (display=modal, max_rounds=20)

3. **MockInteractionExecutor tests**:
   - Returns correct output from mock def
   - Applies vars_update
   - Applies outputs mapping

## Files
- Create: `packages/engine/src/__tests__/interaction.test.ts`

## Dependencies
- T2, T4

## Verification Method
- `pnpm test` passes all new tests
- All existing tests still pass (regression)
