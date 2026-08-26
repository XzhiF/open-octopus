# T1 — shared: input_values schema + preset types

## Status: done

## Depends on: none

## Scope

Add to `@octopus/shared`:

1. **taskSpecSchema extension** — Add `input_values?: z.record(z.string(), z.string())` field with validation:
   - Keys/values must be non-empty strings
   - Each value ≤ 2048 chars
   - Add to `taskSpecSchema` in `packages/shared/src/types/scheduler-job.ts`

2. **New file `packages/shared/src/types/workflow-presets.ts`** — Zod schemas + types:
   ```ts
   workflowPresetSchema = z.object({
     name: z.string().min(1),
     skills_group: z.array(z.string()).default([]),
     workflow: z.string().min(1),
     inputs: z.record(z.string(), z.string()).default({}),
   })
   workflowPresetsCatalogSchema = z.object({
     presets: z.array(workflowPresetSchema).default([]),
   })
   ```

3. **Export** from `packages/shared/src/index.ts` — types + schemas + `WorkflowPreset`, `WorkflowPresetsCatalog`

## Tests

- `packages/shared/src/__tests__/workflow-presets-schema.test.ts`:
  - Valid preset parses
  - Empty skills_group defaults to []
  - Empty inputs defaults to {}
  - Catalog with missing presets field defaults to []
  - Invalid preset (missing name/workflow) fails
- `packages/shared/src/__tests__/task-schema-v3.test.ts` (extend or new):
  - taskSpec with input_values parses
  - taskSpec without input_values parses (backward compat)
  - Empty string key in input_values fails
  - Value > 2048 chars fails

## Verification

```bash
pnpm --filter @octopus/shared test
```
