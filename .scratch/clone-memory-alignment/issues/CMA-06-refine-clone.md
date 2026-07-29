# Ticket: MemoryService.refineLongTerm() Clone Directory Support

## ID
CMA-06

## Status
done

## Summary
Extend `MemoryService.refineLongTerm()` to accept optional `cloneDir` parameter, enabling refinement of clone long-term memory files.

## Scope
- Add `cloneDir?: string` parameter to `refineLongTerm()`
- If `cloneDir` provided, operate on `{cloneDir}/memory/long-term.md`
- If `cloneDir` omitted, operate on main agent long-term memory (existing behavior)
- Backup created at `{filePath}.bak` (same logic, different base path)

## Files
- `packages/server/src/services/agent/memory-service.ts` — update refineLongTerm()

## Acceptance Criteria
- AC1: Clone long-term memory refined when cloneDir provided
- AC2: Backup created at `{cloneDir}/memory/long-term.md.bak`
- AC3: Main agent refine unaffected when cloneDir omitted
- AC4: Non-existent clone long-term file returns `{ refined: false }`

## Verification Method
```bash
# Unit test
pnpm test -- --run packages/server/src/services/agent/__tests__/memory-service.test.ts

# E2E: create clone long-term.md with duplicates, trigger refine, verify .bak exists
```

## Dependencies
None

## Implementation Notes
- Path routing: `cloneDir ? path.join(cloneDir, 'memory', 'long-term.md') : this.getMemoryPath('long-term')`
- All existing refine logic (parse, deduplicate, truncate) works on any file path
- Defensive: check file exists before processing
