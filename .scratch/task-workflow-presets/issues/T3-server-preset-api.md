# T3 — server: preset catalog service + API route

## Status: done

## Depends on: T1 (shared types)

## Scope

1. **WorkflowPresetsService** (`packages/server/src/services/workflow-presets-service.ts`):
   - Constructor takes optional `baseDir` (test injection) → defaults to `~/.octopus`
   - `list(skillsGroup?: string[]): WorkflowPreset[]` — reads `{baseDir}/agent/built-in/task-author/workflow-presets.yaml`
   - Filter logic: if skillsGroup provided → presets where skills_group intersects + empty skills_group (general fallback). No param → all.
   - File missing → `{ presets: [] }`
   - Parse errors → warn + empty (don't crash)
   - Uses `yaml` package (already in deps) or `js-yaml`

2. **Route** (`packages/server/src/routes/workflow-presets.ts`):
   - `GET /api/workflow-presets?skills_group=a,b` → `{ presets: [...] }`
   - Register in server index (app.ts or similar)

3. **Wire in server init** — Create service instance, pass to route factory, register route

## Tests

- `packages/server/src/services/__tests__/workflow-presets-service.test.ts`:
  - Reads YAML from temp dir, returns presets
  - Filter by skills_group: matching + general fallback
  - No skills_group param: all presets
  - Missing file: empty presets
  - Malformed YAML: empty presets (no crash)
- `packages/server/src/routes/__tests__/workflow-presets-routes.test.ts`:
  - GET /api/workflow-presets returns presets
  - GET with skills_group filter works
  - Missing catalog returns empty

## Verification

```bash
pnpm --filter @octopus/server test -- workflow-presets
tsc --noEmit --project packages/server/tsconfig.json
```
