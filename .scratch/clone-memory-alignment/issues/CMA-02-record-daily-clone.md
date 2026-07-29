# Ticket: MemoryService.recordDaily() Clone Path Routing

## ID
CMA-02

## Status
done

## Summary
Extend `MemoryService.recordDaily()` to accept optional `cloneDir` parameter, routing daily file writes to clone's memory directory instead of main agent's.

## Scope
- Add `cloneDir?: string` parameter to `recordDaily()`
- If `cloneDir` provided, write to `{cloneDir}/memory/daily/YYYY-MM-DD.md`
- Extract source name from cloneDir path (path.basename)
- Insert FTS record with `source=clone-name`
- If `cloneDir` omitted, preserve existing behavior (source='main')

## Files
- `packages/server/src/services/agent/memory-service.ts` — update recordDaily()

## Acceptance Criteria
- AC1: Clone record_daily writes to `{cloneDir}/memory/daily/YYYY-MM-DD.md`
- AC2: Main agent record_daily still writes to `~/.octopus/agent/memory/daily/YYYY-MM-DD.md`
- AC3: FTS insert includes correct source field
- AC4: Daily file directory created if not exists

## Verification Method
```bash
# Unit test
pnpm test -- --run packages/server/src/services/agent/__tests__/memory-service.test.ts

# Verify clone daily file created at correct path
ls ~/.octopus/agent/clones/E2E_TEST_clone/memory/daily/
```

## Dependencies
CMA-01 (FTS source column must exist)

## Implementation Notes
- Path routing: `cloneDir ? path.join(cloneDir, 'memory', 'daily') : getDailyMemoryDir()`
- Source extraction: `cloneDir ? path.basename(cloneDir) : 'main'`
- Defensive: create directory if not exists
