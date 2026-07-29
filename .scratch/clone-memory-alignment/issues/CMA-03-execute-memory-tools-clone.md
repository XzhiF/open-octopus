# Ticket: executeMemoryTools() Clone Context Detection

## ID
CMA-03

## Status
done

## Summary
Detect clone context from request headers in `executeMemoryTools()` and pass clone directory to `recordDaily()` handler.

## Scope
- Add `cloneName?: string` parameter to `executeMemoryTools()`
- Read `X-Clone-Name` header from chat request
- Resolve clone directory from clone name (built-in vs user clone)
- Pass clone directory to `memoryService.recordDaily()`

## Files
- `packages/server/src/routes/agent/main-agent-route.ts` — update executeMemoryTools() and callers

## Acceptance Criteria
- AC1: Clone chat requests with `X-Clone-Name` header route record_daily to clone dir
- AC2: Main agent requests (no header) route to main agent dir
- AC3: Invalid clone name falls back to main agent dir (graceful degradation)

## Verification Method
```bash
# E2E test: clone chat with record_daily tool call
curl -X POST http://localhost:3001/api/agent/chat \
  -H "Content-Type: application/json" \
  -H "X-Octopus-Org: test" \
  -H "X-Clone-Name: E2E_TEST_clone" \
  -d '{"message": "请记住：E2E_TEST_记忆内容"}'

# Verify file written to clone dir, not main dir
ls ~/.octopus/agent/clones/E2E_TEST_clone/memory/daily/
ls ~/.octopus/agent/memory/daily/  # should NOT contain clone entry
```

## Dependencies
CMA-02 (recordDaily must accept cloneDir)

## Implementation Notes
- Header: `X-Clone-Name` (already used for clone chat routing)
- Clone resolution: use `resolveCloneDefFromFs()` then compute dir from type
- Fallback: if clone not found, log warning and proceed with main agent path
