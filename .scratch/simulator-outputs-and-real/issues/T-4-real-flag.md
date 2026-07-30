# T-4: Implement --real flag in mock-factory

## Status: [DONE]

## Scope
Modify `SimulatorExecutorFactory.createExecutor()` to return real `BashExecutor`/`PythonExecutor` when node ID is in `realExecution` list, instead of throwing.

## Dependencies
- T-2 (executors must use shared function first)

## Implementation
- Add `signal`, `onLog`, `cwd` to `MockFactoryOptions` or as constructor params
- In `createExecutor()`, when `realExecution.includes(node.id)`:
  - bash → `new BashExecutor(node, this.pool, { signal, onLog, cwd })`
  - python → `new PythonExecutor(node, this.pool, { signal, onLog })`
  - other → throw "Only bash/python supported for --real"
- Remove the throw for bash/python

## Files Changed
- [ ] `packages/engine/src/simulator/mock-factory.ts`

## Verification Method
```bash
pnpm build
npx vitest run packages/engine/src/__tests__/simulator/mock-factory.test.ts
```
Existing mock-factory tests must pass.
