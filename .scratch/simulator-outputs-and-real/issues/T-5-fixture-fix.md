# T-5: Fix xzf-dev.test.yaml fixture

## Status: [DONE]

## Notes
Only 2 scenarios exist (not 3 as mentioned in brief). Both pass without any fixture changes — the shared outputs resolver fix was sufficient.

## Scope
Fix the xzf-dev.test.yaml fixture so all 3 scenarios pass after the outputs resolver fix.

## Dependencies
- T-3 (simulator must use shared resolver first)

## Implementation
- Run `octopus workflow test packages/core-pack/workflows/xzf-dev.yaml`
- Analyze failures
- Fix fixture data (mock definitions, assertions) as needed

## Files Changed
- [ ] `packages/core-pack/workflows/xzf-dev.test.yaml`

## Verification Method
```bash
pnpm build
npx vitest run packages/engine/src/__tests__/simulator/
```
All simulator tests must pass including any new golden tests added for xzf-dev.
