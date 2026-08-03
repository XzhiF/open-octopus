# Ticket 2: EngineInitPhase Uses `requires` First, Scan as Fallback

## Status: Ready

## Summary

Modify `EngineInitPhase.run()` to first provision resources declared in `workflow.requires`, then run `ResourcePreFlight.analyze()` as a fallback scan.

## Scope

- **Package**: `@octopus/engine`
- **Files**: `packages/engine/src/engine-init.ts`
- **Type**: Logic modification

## Acceptance Criteria

1. When `workflow.requires` exists, resources from it are provisioned first
2. Log message: "Provisioning from requires: X skills, Y agents" appears before scan
3. `ResourcePreFlight.analyze()` runs after requires provisioning (scan fallback)
4. Log message: "Scanning for additional resources..." appears after requires
5. Scanned resources that overlap with requires are not double-provisioned
6. When `workflow.requires` is absent, behavior is identical to current (scan only)

## Implementation Plan

### Step 1: Write tests (RED)

Add tests to `packages/engine/src/__tests__/engine-init.test.ts`:
- Test: requires resources provisioned first, logs correct message
- Test: scan runs after requires, logs "Scanning for additional resources..."
- Test: scanned resources merge without duplicates
- Test: requires absent → scan only (backward compat)
- Test: requires + scan both find resources → only missing ones provisioned

### Step 2: Implement (GREEN)

Modify `EngineInitPhase.run()` in `packages/engine/src/engine-init.ts`:

1. After `onNodeStart`, check if `workflow.requires` exists
2. If yes:
   - Build manifest from `requires.skills` (extract names) and `requires.agent_files` (extract names without .md)
   - Log: "Provisioning from requires: X skills, Y agents"
   - Check + provision these resources
   - Track what was already provisioned
3. Then: run `ResourcePreFlight.analyze(workflow)` as before
   - Log: "Scanning for additional resources..."
   - Merge scanned manifest with already-provisioned (dedup)
   - Check + provision any new missing resources

### Step 3: Verify

Run `pnpm test --filter @octopus/engine` to ensure all tests pass.

## Verification Method

```bash
pnpm test --filter @octopus/engine -- engine-init
```

## Dependencies

- Ticket 1: `requires` field must exist in WorkflowSchema
