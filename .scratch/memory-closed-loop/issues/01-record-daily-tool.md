# Issue 1: `record_daily` tool implementation

## Summary
Add `recordDaily()` method to MemoryService and tool handler in main-agent-route.ts.

## Changes
1. `packages/server/src/services/agent/memory-service.ts` — add `recordDaily(org, content, sessionId)` method
2. `packages/server/src/routes/agent/main-agent-route.ts` — add tool call handler for `record_daily`

## Details

### MemoryService.recordDaily()
```typescript
recordDaily(org: string, content: string, sessionId: string): { ok: boolean; date: string } {
  // 1. Compute today and time
  // 2. Append to daily/{today}.md
  // 3. Insert summary message (is_summary=1) into messages table
  // 4. Rebuild FTS index
  // 5. Return { ok: true, date: today }
}
```

### Tool handler in main-agent-route.ts
- Detect `record_daily` in tool_call events (similar to evolution tools)
- Extract `content` from input
- Call `getMemoryService().recordDaily(org, content, sessionId)`
- Stream back tool_result

## Verification Method
- Build: `pnpm build` succeeds
- Unit: `recordDaily()` writes daily file + inserts DB row
