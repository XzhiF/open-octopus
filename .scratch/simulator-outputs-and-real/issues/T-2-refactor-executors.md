# T-2: Refactor real executors to use shared applyOutputsMapping

## Status: [DONE]

## Scope
Replace private `applyOutputsMapping` methods in bash.ts, python.ts, agent.ts, and approval.ts with calls to the shared function from `@octopus/shared`.

## Dependencies
- T-1

## Implementation
- Import `applyOutputsMapping` from `@octopus/shared`
- bash.ts: replace lines 145-188, call `applyOutputsMapping(this.node.outputs!, outputs, this.pool, outputs.last_output, outputs.exit_code)`
- python.ts: replace lines 99-142, same pattern
- agent.ts: replace lines 455-485, call with `undefined` for exitCode. Note: agent currently doesn't strip `$vars.` from poolKey — shared function does.
- approval.ts: replace lines 115-141, call with `undefined` for exitCode

## Files Changed
- [ ] `packages/engine/src/executors/bash.ts`
- [ ] `packages/engine/src/executors/python.ts`
- [ ] `packages/engine/src/executors/agent.ts`
- [ ] `packages/engine/src/executors/approval.ts`

## Verification Method
```bash
pnpm build
npx vitest run packages/engine/src/__tests__/bash.test.ts packages/engine/src/__tests__/python.test.ts packages/engine/src/__tests__/approval.test.ts packages/engine/src/__tests__/agent.test.ts
```
All 27 existing executor tests must pass.
