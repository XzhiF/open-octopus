# T5 — server: ready-gate required inputs validation

## Status: done

## Depends on: T4 (resolveInputValues function)

## Scope

Extend `readyTask` in `packages/server/src/services/tasks/tasks-service.ts` to check required workflow inputs.

After the existing workflow_ref resolvability check (for v3 simple tasks), add:

```ts
// Resolve the workflow and check required inputs
if (subunits.length < 2 && ref) {
  const resolved = resolveWorkflowRef(ref, this.resolverDeps(id))
  if (resolved) {
    const wfInputDefs = parseWorkflowInputDefs(resolved.content) // new helper
    const materialized = resolveInputValues(taskSpec.input_values, taskSpec.goal, taskSpec.ac)
    for (const def of wfInputDefs) {
      if (def.required && !materialized[def.name]?.trim()) {
        missing.push(`input:${def.name}`)
      }
    }
  }
}
```

New helper `parseWorkflowInputDefs(content: string): {name: string, required: boolean}[]`:
- Parse the workflow YAML's `variables:` section
- An input is `required` if it has no default value (or default is empty string) AND is referenced in nodes
- Simple heuristic: any variable without a `: ` default = required (the workflow expects it to be provided)

## Tests

- `packages/server/src/services/tasks/__tests__/ready-gate-inputs.test.ts`:
  - Task with workflow requiring "requirement" input, no input_values → missing includes "input:requirement"
  - Task with input_values containing ${goal} → resolves → passes
  - Task with input_values containing literal value → passes
  - Task with all required inputs satisfied → no input:<name> in missing
  - Composite task (subunits >= 2) → skips input check

## Verification

```bash
pnpm --filter @octopus/server test -- tasks
tsc --noEmit --project packages/server/tsconfig.json
```
