# Verified Spec — Safety System Redesign

## Summary

Honest simplification of the safety system: add `safe_mode` guards to evolution and scheduler entry points that were previously unguarded, and rename the UI from "安全审计" (Security Audit) to "操作审计" (Operation Audit) so its label matches what it actually does — a post-incident log, not an intercepting firewall.

## Scope

### In Scope

| Area | File | Change |
|------|------|--------|
| Evolution routes | `packages/server/src/routes/agent/evolution-routes.ts` | Add `safe_mode` check to `POST /evolution/feedback`, `POST /evolution/process-marks`, `POST /self-check/evolve` → return 409 |
| Scheduler engine | `packages/server/src/services/scheduler/scheduler-engine.ts` | In `triggerSchedule()`, check `safe_mode` before dispatching; log skip and return early |
| SafetyAudit component | `packages/web-app/components/agent/config/SafetyAudit.tsx` | Change heading "安全审计" → "操作审计"; change `intercept` decision label "拦截" → "已记录" |

### Out of Scope

- Tool-level interception (bypassPermissions stays as-is)
- `permission_mode` config switch
- Claude SDK provider changes
- SafetyInterceptor logic changes
- Schema/model changes

## Implementation Details

### 1. Evolution Routes — safe_mode guard

Use the same pattern as `memory.ts`:

```ts
import { getConfigManager } from '../../services/agent/config-manager'

// At top of each handler, after org resolution:
const configManager = getConfigManager()
const config = configManager.getConfig(org)
if (config.safe_mode.enabled) {
  return c.json(
    createAgentError('SAFE_MODE_READONLY', 'Safe mode is enabled. Evolution is paused.'),
    409,
  )
}
```

Apply to: `POST /evolution/feedback`, `POST /self-check/evolve`, `POST /evolution/process-marks`.

### 2. Scheduler Engine — safe_mode guard

In `triggerSchedule()`, after loading the schedule row and before creating the `schedule_execution` record:

```ts
import { getConfigManager } from '../agent/config-manager'

const configManager = getConfigManager()
const config = configManager.getConfig(schedule.org)
if (config.safe_mode.enabled) {
  console.log(`[SchedulerEngine] Skipping trigger for schedule ${schedule.id}: safe_mode enabled`)
  return
}
```

### 3. SafetyAudit — rename heading

```tsx
// Before
安全审计
// After
操作审计
```

### 4. SafetyAudit — decision label update

```ts
// Before
intercept: '拦截',
// After
intercept: '已记录',
```

## Verification

| # | Criterion | Method |
|---|-----------|--------|
| AC-01 | `POST /evolution/feedback` returns 409 when safe_mode on | Build + manual API test |
| AC-02 | `POST /evolution/process-marks` returns 409 when safe_mode on | Build + manual API test |
| AC-03 | `POST /self-check/evolve` returns 409 when safe_mode on | Build + manual API test |
| AC-04 | Scheduler skips dispatch when safe_mode on | Build + log inspection |
| AC-05 | UI shows "操作审计" | Visual check |
| AC-06 | Decision label shows "已记录" not "拦截" | Visual check |

## Risks

- R1: Scheduler skip must log to avoid silent failures — addressed by `console.log` in `triggerSchedule()`.
- R2: Three evolution route entry points need coverage — all three listed above.
