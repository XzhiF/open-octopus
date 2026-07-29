# Ticket 2: Scheduler engine safe_mode guard

**Status**: done
**Scope**: `packages/server/src/services/scheduler/scheduler-engine.ts`
**Acceptance**: `triggerSchedule()` checks safe_mode, logs skip, returns early.
**Verification**: `pnpm build` passes.
**Commit**: (see git log)
