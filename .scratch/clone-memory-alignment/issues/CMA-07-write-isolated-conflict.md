# Ticket: CloneRuntime.writeIsolatedMemory() Mtime Conflict Detection

## ID
CMA-07

## Status
done

## Summary
Add mtime-based conflict detection to `CloneRuntime.writeIsolatedMemory()`, matching the pattern used by `MemoryService.writeMemory()`.

## Scope
- Add `expectedLastModified?: string` parameter to `writeIsolatedMemory()`
- Before writing, compare file mtime against expectedLastModified
- If server mtime > expectedLastModified, throw MEMORY_CONFLICT error
- Re-throw MEMORY_CONFLICT errors (don't swallow them)
- Other errors remain non-fatal (log only)

## Files
- `packages/server/src/services/agent/clone-runtime.ts` — update writeIsolatedMemory()

## Acceptance Criteria
- AC1: Write with stale expectedLastModified throws MEMORY_CONFLICT
- AC2: Write with current expectedLastModified succeeds
- AC3: Write without expectedLastModified succeeds (no conflict check)
- AC4: MEMORY_CONFLICT errors propagated to caller
- AC5: Other write errors logged but not thrown

## Verification Method
```bash
# Unit test
pnpm test -- --run packages/server/src/services/agent/__tests__/clone-runtime.test.ts

# Test scenario:
# 1. Write to clone daily file
# 2. Read mtime
# 3. Write again with old mtime → expect MEMORY_CONFLICT
# 4. Write again with current mtime → expect success
```

## Dependencies
None

## Implementation Notes
- Same pattern as `MemoryService.writeMemory()` — compare `new Date(serverModified).getTime() > new Date(expectedLastModified).getTime()`
- Error shape: `{ code: 'MEMORY_CONFLICT', message: string }`
- Must re-throw MEMORY_CONFLICT specifically, not swallow it in catch block
