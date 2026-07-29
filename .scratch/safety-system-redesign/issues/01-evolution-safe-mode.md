# Ticket 1: Evolution routes safe_mode guard

**Status**: done
**Scope**: `packages/server/src/routes/agent/evolution-routes.ts`
**Acceptance**: `POST /evolution/feedback`, `POST /evolution/process-marks`, `POST /self-check/evolve` return 409 when `safe_mode.enabled` is true.
**Verification**: `pnpm build` passes.
**Commit**: (see git log)
