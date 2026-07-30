# T-3: Refactor simulator applyNodeOutputsMapping to use shared function

## Status: [DONE]

## Scope
Replace `applyNodeOutputsMapping` in simulator-engine.ts with a call to the shared `applyOutputsMapping`.

## Dependencies
- T-1

## Implementation
- Import `applyOutputsMapping` from `@octopus/shared`
- Replace the function body at simulator-engine.ts:452-478
- Call: `applyOutputsMapping(node.outputs!, outputs, pool, result.lastOutput, result.exitCode)`
- Need to build `outputs` record from `result` (lastOutput, exitCode, existing outputs)

## Files Changed
- [ ] `packages/engine/src/simulator/simulator-engine.ts`

## Verification Method
```bash
pnpm build
npx vitest run packages/engine/src/__tests__/simulator/
```
All 65 existing simulator tests must pass.
