# T4 — server: template materialization (${goal}/${ac} replacement)

## Status: done

## Depends on: T1 (shared types — input_values on taskSpecSchema)

## Scope

Modify `materializeTaskSpecToConfig` in `packages/server/src/services/scheduler/scheduler-service.ts`:

1. **New pure function** `resolveInputValues(inputValues, goal, ac)`:
   - Input: `Record<string,string> | undefined`, `goal: string`, `ac: string[]`
   - For each value in inputValues:
     - Replace `${goal}` → goal
     - Replace `${ac}` → ac.join('\n')
     - If any `${xxx}` remains → throw Error(`unknown placeholder: ${xxx}`)
   - Output: resolved Record<string,string>

2. **Integrate into materializeTaskSpecToConfig**:
   ```
   const resolvedInputs = resolveInputValues(task_spec.input_values, task_spec.goal, task_spec.ac)
   const simpleInputValues = {
     ...resolvedInputs,
     task_artifacts_dir,    // existing, takes priority
     task_workflows_dir,    // existing, takes priority
   }
   ```
   Same for compositeInputValues (composite also carries input_values? No — composite uses composition-task workflow which reads subunit_count. But for consistency, resolve input_values for the composite case too, since subunits carry their own input_values. Actually per spec §4, simple only. But we should still propagate to composite if needed later.)

3. **Export** `resolveInputValues` for reuse by ready-gate (T5) and tests.

## Tests

- `packages/server/src/services/scheduler/__tests__/template-resolver.test.ts`:
  - `${goal}` replaced with actual goal value
  - `${ac}` replaced with ac.join('\n')
  - Mixed text: "Goal: ${goal}" → "Goal: actual goal"
  - Unknown placeholder `${foo}` → throws
  - Empty input_values → empty output
  - Undefined input_values → empty output
  - No placeholders → pass-through
  - Management keys (task_artifacts_dir) not overridden by input_values

- `packages/server/src/services/scheduler/__tests__/materialize.test.ts` (extend existing or new):
  - materialize with input_values containing ${goal} → config.input_values has resolved value
  - task_artifacts_dir takes priority over input_values with same key

## Verification

```bash
pnpm --filter @octopus/server test -- scheduler
tsc --noEmit --project packages/server/tsconfig.json
```
