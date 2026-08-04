# T2 — Provisioner + Engine-Init Integration

## What to build
1. Expand `ResourceProvisioner` to handle `command` and `rule` types (copy `.md` files to `.claude/commands/` and `.claude/rules/`), return `byType` counts instead of ratio estimation.
2. Wire new requires types into `EngineInitPhase.run()`:
   - Clone hard-fail gate: check clones BEFORE provisioning, fail immediately if any missing
   - Read commands/rules from requires, add to manifest, provision missing ones
   - Update counters using `byType` from provisioner result (replaces fragile ratio estimation)
   - Add `cloneErrors` to `EngineInitResult` for SSE error detail
3. Fix bare `catch {}` to capture and log error details.

## Blocked by
T1 — Schema + Type Expansion + Preflight Check (provides the expanded types that T2 consumes)

## Status
done

## Exploration
- `packages/shared/src/resource/resource-provisioner.ts:23-109` — provision() and directCopy() (only agent|skill)
- `packages/engine/src/engine-init.ts:104-138` — provisionMissing() ratio-based counter logic
- `packages/engine/src/engine-init.ts:140-231` — run() method (only reads skills + agent_files from requires)
- `packages/engine/src/engine-init.ts:60-66` — EngineInitResult interface
- `packages/engine/src/engine-init.ts:75-79` — ProvisionContext interface
- `packages/engine/src/engine-init.ts:225-230` — bare catch block
- `packages/server/src/services/execution/ExecutionLifecycle.ts:271-292` — initResult wiring + SSE emit
- `packages/engine/src/__tests__/engine-init.test.ts` — existing engine init tests (351 lines)

## Acceptance Criteria
- [ ] AC-8: Provisioner copies command `.md` file to `.claude/commands/{name}.md`
- [ ] AC-9: Provisioner copies rule `.md` file to `.claude/rules/{name}.md`
- [ ] AC-10: Clone missing → engine-init returns `status: "failed"` with cloneErrors
- [ ] AC-11: Mixed requires (skills + agents + commands + rules + clones) works end-to-end
- [ ] AC-12: Clone error message includes clone name and install hint
- [ ] AC-13: Scan-fallback `analyze()` unchanged — still only scans skills + agents
- [ ] AC-14: Provisioner returns `byType` with exact per-type counts
- [ ] AC-15: `provisionMissing()` uses `byType` instead of ratio estimation
- [ ] AC-16: `EngineInitResult` includes `commandsCopied`, `rulesCopied`, `cloneErrors`
- [ ] AC-17: Bare `catch` in engine-init captures and logs error message
- [ ] AC-18: `cloneErrors` propagated to EngineInitResult for SSE event enrichment

## Verification Method
**Verification type**: Unit tests + Integration tests

**Verification steps**:
1. Run `pnpm test -- packages/engine/src/__tests__/engine-init.test.ts` — all existing + new tests pass
2. New engine-init test cases:
   - Clone hard-fail: workflow with missing clone → `status: "failed"`, `cloneErrors` contains clone name
   - Clone available: workflow with installed clone → proceeds to provisioning
   - Mixed requires: all 5 types → correct counters, clone gate first
   - Command provisioning: missing command → copied from registry
   - Rule provisioning: missing rule → copied from registry
   - Error logging: bare catch captures error message
3. New provisioner test cases (in `resource-provisioner.test.ts` or existing test file):
   - Command copy: creates `.claude/commands/{name}.md`
   - Rule copy: creates `.claude/rules/{name}.md`
   - byType return: `{ agent: 1, command: 1 }` exact counts
   - Clone exclusion: clone type rejected by provisioner

**Pass criteria**: All unit + integration tests PASS
**Failure handling**: Max 3 fix attempts, then mark SKIP with reason
