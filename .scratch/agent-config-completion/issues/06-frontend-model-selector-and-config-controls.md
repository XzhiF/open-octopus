# Issue 6: Frontend — Add ModelSelector component + config controls

**Status:** done
**Priority:** high
**Depends on:** Issue 4, Issue 5
**Files:**
- `packages/web-app/components/agent/config/ModelSelector.tsx` (new)
- `packages/web-app/components/agent/config/ConfigTab.tsx`
- `packages/web-app/hooks/useAgentConfig.ts`
- `packages/web-app/lib/agent/api.ts`

## Problem

ConfigTab is missing:
1. Model selector (engine→model two-level dropdown, default claude/pro)
2. Timeout input (30–1800s, default 300)
3. max_clones input (1–20, default 5)
4. debug.enabled toggle

## Acceptance Criteria

1. **ModelSelector**: Fetches `GET /api/system/models`, parses YAML content to extract `providers` block. Two `<select>` dropdowns: engine (provider keys) and model (alias keys under selected engine). Default: `claude` / `pro`. On config save, model is stored as `"{engine}/{alias}"` string.
2. **Timeout**: Number input, min 30, max 1800, step 1. Default 300. Wired to `saveConfig({ timeout })`.
3. **max_clones**: Number input, min 1, max 20, step 1. Default 5. Wired to `saveConfig({ max_clones })`.
4. **debug.enabled**: Switch/toggle component. Wired to `saveConfig({ debug: { enabled } })`.
5. All controls show current config values on load.
6. All controls save via existing `saveConfig` callback.
7. Model selector handles YAML parse errors gracefully (shows error message, doesn't crash).

## Verification Method

```bash
cd packages/web-app && pnpm tsc --noEmit

# Visual: Open Config tab
# - Model selector shows "claude" in engine dropdown, "pro" in model dropdown
# - Changing engine updates model dropdown options
# - Timeout shows current value (default 300), accepts 30–1800
# - max_clones shows current value (default 5), accepts 1–20
# - debug.enabled toggle reflects current state
# - Click Save → refresh page → values persist
```
