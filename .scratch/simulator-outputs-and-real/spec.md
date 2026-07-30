# Verified Spec: Simulator Outputs Shared Resolver + --real Execution

## Problem Statement

Two behavioral bugs and one missing feature in the workflow simulator:

1. **Bug #1**: The simulator's `applyNodeOutputsMapping()` (simulator-engine.ts:452-478) does not handle `$last_output.field`, `$exit_code`, or `$vars.x = expr` expressions. The real engine's executors handle these correctly.

2. **Bug #2**: Real engine executors pass inconsistent `nodeOutputs` to `substituteVars` (bash/python/approval pass `undefined`, agent passes `this.buildNodeOutputs()`). The shared function should NOT pass nodeOutputs since `$nodeId.output.key` is not part of the outputs DSL.

3. **Feature**: `simulate --real <node-ids>` currently throws "not yet supported" in `mock-factory.ts`. It should instantiate real `BashExecutor`/`PythonExecutor` for specified nodes.

4. **Fixture fix**: `xzf-dev.test.yaml` scenarios may need adjustments after the outputs resolver fix.

## Design

### Shared Resolver: `packages/shared/src/variables/outputs-resolver.ts`

Two functions:

- `resolveOutputsExpression(expr, pool, lastOutput, exitCode)` — resolves a single expression string to a value.
- `applyOutputsMapping(outputs, nodeOutputsDef, pool, lastOutput, exitCode)` — iterates `node.outputs` entries, resolves each via `resolveOutputsExpression`, writes to pool, and populates the `outputs` record.

**Resolution order** (matches bash.ts / python.ts behavior which is the most complete):

1. `$last_output` → return `lastOutput` directly
2. `$last_output.field` → `JSON.parse(lastOutput)` → extract `.field`; return `undefined` if parse fails
3. `$exit_code` → return `exitCode`
4. `$vars.x = expr` (regex `^\$vars\.(\w+)\s*=\s*(.+)$`) → `evaluateExpression(rhs, pool)` → return result
5. `$vars.xxx` (regex `^\$vars\.\w+$`) → `pool.get(key)`
6. Starts with `$` → `substituteVars(expr, pool)` (no nodeOutputs)
7. Otherwise → literal string

### Executor Refactoring

Each executor's private `applyOutputsMapping` is replaced with a call to the shared function. The `outputs` record is still populated locally (used for `__status` check etc.).

Changes per executor:
- **bash.ts**: Replace lines 145-188 with `applyOutputsMapping(this.node.outputs, outputs, this.pool, outputs.last_output, outputs.exit_code)`. Remove private method.
- **python.ts**: Same pattern.
- **agent.ts**: Replace lines 455-485. Agent doesn't have `exit_code`. Remove private method. Note: agent currently does NOT strip `$vars.` prefix from poolKey (line 470: `this.pool.set(key, ...)` not `poolKey`). The shared function should handle this consistently — strip `$vars.` prefix (matching bash/python/approval).
- **approval.ts**: Replace lines 115-141. No exit_code. Note: approval's `$last_output.field` currently does `outputs.last_output?.[field] ?? outputs[field]` (doesn't JSON.parse). The shared function JSON.parses, which is the correct behavior per the brief.

### Simulator Refactoring

Replace `applyNodeOutputsMapping` (simulator-engine.ts:452-478) with a call to the shared `applyOutputsMapping`. The simulator has `result.lastOutput` and `result.exitCode` available.

### --real Implementation

In `mock-factory.ts`, when `realExecution.includes(node.id)`:
- `bash` → `new BashExecutor(node, pool, { signal, onLog, cwd })`
- `python` → `new PythonExecutor(node, pool, { signal, onLog })`
- other types → throw error

The mock-factory needs additional constructor params: `signal?`, `onLog?`, `cwd?`. Add these to `MockFactoryOptions` or as separate constructor params.

### xzf-dev.test.yaml Fix

After the shared resolver is in place, run `octopus workflow test packages/core-pack/workflows/xzf-dev.yaml` and analyze failures. Likely issues:
- Scenario 2 assertions reference loop inner nodes (e2e-notify, e2e-approval) in `skipped` but the simulator may handle loop-skipped inner nodes differently.
- The `execution` node has `outputs: { $vars.spec_status: "$last_output" }` — the shared resolver handles this correctly now.

## Constraints

- Do NOT modify `substituteVars` or `evaluateExpression`
- Do NOT add sandbox/container isolation for --real
- Keep `simulate` command output format unchanged
- Run `pnpm build` after each ticket
- Run `pnpm test` to verify existing tests pass

## Acceptance Criteria

| # | Criterion | Verification |
|---|-----------|-------------|
| 1 | `$last_output.field`, `$exit_code`, `$vars.x = expr` resolve correctly in simulator | Unit tests for `resolveOutputsExpression` |
| 2 | Existing executor behavior unchanged (bash/agent/python/approval) | `pnpm test` — 27 executor tests pass |
| 3 | Existing simulator tests pass | `pnpm test` — 65 simulator tests pass |
| 4 | `--real bash-node` executes real bash on host | Manual test |
| 5 | `--real python-node` executes real python on host | Manual test |
| 6 | xzf-dev.test.yaml 3 scenarios pass | `octopus workflow test xzf-dev.yaml` |
