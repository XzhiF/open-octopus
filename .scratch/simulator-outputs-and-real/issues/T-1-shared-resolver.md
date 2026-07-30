# T-1: Shared outputs-resolver.ts + unit tests

## Status: [DONE]

## Scope
Create `packages/shared/src/variables/outputs-resolver.ts` with two exported functions and unit tests.

## Implementation
- `resolveOutputsExpression(expr, pool, lastOutput, exitCode)` — resolves one expression
- `applyOutputsMapping(nodeOutputs, outputs, pool, lastOutput, exitCode)` — iterates all outputs, resolves, writes to pool and outputs record
- Export from `packages/shared/src/index.ts`

## Resolution Order
1. `$last_output` → lastOutput
2. `$last_output.field` → JSON.parse(lastOutput) → .field
3. `$exit_code` → exitCode
4. `$vars.x = expr` → evaluateExpression(rhs, pool)
5. `$vars.xxx` → pool.get(key)
6. starts with `$` → substituteVars(expr, pool)
7. literal string

## Files Changed
- [ ] `packages/shared/src/variables/outputs-resolver.ts` (new)
- [ ] `packages/shared/src/index.ts` (export)
- [ ] `packages/engine/src/__tests__/outputs-resolver.test.ts` (new — tests)

## Verification Method
```bash
pnpm build
npx vitest run packages/engine/src/__tests__/outputs-resolver.test.ts
```
All new unit tests must pass. Build must succeed.
