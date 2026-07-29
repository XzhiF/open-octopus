# Ticket 03 — Debug Log Enhancement (Pagination + Search)

Status: pending
Priority: P1
Packages: server, shared, web-app

## Scope

Implement real cursor-based pagination on the backend and "load more" + search on the frontend for debug logs.

## Changes

### Backend: Real Pagination

**File: `packages/server/src/services/agent/agent-service.ts`** — `getDebugLog()`:
- Read all JSONL files (not just 5), parse all entries
- Sort entries by timestamp descending
- Apply `search` filter: case-insensitive substring match on `summary` (mapped from `message`)
- Apply `start_date` / `end_date` filters on `timestamp`
- Apply `cursor` filter: only entries with timestamp < cursor
- Slice to `limit` (default 20, max 100)
- Return `{ items, total (matching count), has_more, next_cursor (last item's timestamp) }`

**File: `packages/server/src/routes/agent/misc-routes.ts`** — debug/log route:
- Accept new query params: `search`, `start_date`, `end_date`, `cursor`
- Pass to `getDebugLog()`
- Change limit default to 20, max to 100

### Frontend: Load More + Search

**File: `packages/web-app/lib/agent/api.ts`** — `getDebugLog()`:
- Add `search`, `start_date`, `end_date` to query params

**File: `packages/web-app/components/agent/config/DebugLogViewer.tsx`**:
- Add search `<Input>` above the log list
- Add "加载更多" `<Button>` at bottom of log list (when `has_more`)
- State: `cursor`, `hasMore`, `searchTerm`, `allLogs`
- On mount: fetch first page
- On "加载更多": fetch next page with cursor, append items
- On search: debounce 300ms, reset list, fetch with search param
- Increase list max-height from `max-h-[400px]` to `max-h-[600px]`

## API Contract

```
GET /api/agent/debug/log?limit=20&cursor=<timestamp>&search=<keyword>&start_date=<iso>&end_date=<iso>

Response: {
  items: [...],
  total: 150,
  has_more: true,
  next_cursor: "2026-07-29T10:30:00Z"
}
```

## Verification
- `pnpm build` passes
- `pnpm test` passes
- Unit test for pagination logic
