# Ticket: ArchiveService.archiveMemoryBatch() Clone Directory Scanning

## ID
CMA-04

## Status
done

## Summary
Extend `ArchiveService.archiveMemoryBatch()` to scan and archive daily files from all clone directories (both built-in and user clones).

## Scope
- After main agent daily archive, scan `~/.octopus/agent/clones/*/memory/daily/`
- Scan `~/.octopus/agent/built-in/*/memory/daily/`
- Archive clone daily files older than retention days
- Move to `{cloneDir}/memory/daily/archive/`
- Trigger `refineLongTerm()` for each clone's long-term memory if stale
- Each clone gets independent `archive/` directory

## Files
- `packages/server/src/services/archive/archive-service.ts` — update archiveMemoryBatch()

## Acceptance Criteria
- AC1: Clone daily files older than retention are moved to `archive/`
- AC2: Each clone has independent `archive/` directory
- AC3: Clone long-term memory refined when stale
- AC4: Archive event emitted for each clone daily file
- AC5: Non-existent clone directories handled gracefully (no error)

## Verification Method
```bash
# Unit test
pnpm test -- --run packages/server/src/services/archive/__tests__/archive-service.test.ts

# E2E: create old daily file in clone dir, trigger archive, verify moved
touch -d "30 days ago" ~/.octopus/agent/clones/E2E_TEST_clone/memory/daily/2026-06-01.md
curl -X POST http://localhost:3001/api/memory/archive
ls ~/.octopus/agent/clones/E2E_TEST_clone/memory/daily/archive/2026-06-01.md
```

## Dependencies
CMA-07 (refineLongTerm must accept cloneDir)

## Implementation Notes
- Use `getClonesDir()` and `getBuiltInClonesDir()` from paths.ts
- Defensive: skip non-existent directories
- Archive dir per clone: `{cloneDir}/memory/daily/archive/`
- Refine trigger: check long-term.md mtime against config threshold
