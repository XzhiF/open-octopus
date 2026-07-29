# Ticket: GET /memory/search Source Filter Parameter

## ID
CMA-08

## Status
done

## Summary
Add optional `source` query parameter to `GET /memory/search` endpoint, allowing filtering of search results by memory source (main agent vs specific clone).

## Scope
- Add `source?: string` query parameter to route handler
- Pass source to `MemoryService.searchMemory()`
- Update `searchMemory()` to accept source filter
- Update `AgentSessionDAO.searchSessionMemory()` to filter by source
- Update FTS queries to include `AND source = ?` when source provided
- Update text search on daily/long-term files to filter by clone dir when source provided

## Files
- `packages/server/src/routes/agent/memory.ts` — add source query param
- `packages/server/src/services/agent/memory-service.ts` — update searchMemory()
- `packages/server/src/db/dao/agent-session-dao.ts` — update searchSessionMemory()

## Acceptance Criteria
- AC1: `GET /memory/search?q=test` returns all results (main + clones)
- AC2: `GET /memory/search?q=test&source=main` returns only main agent results
- AC3: `GET /memory/search?q=test&source=clone-name` returns only that clone's results
- AC4: Invalid source returns empty results (not error)
- AC5: Source field included in search result objects

## Verification Method
```bash
# E2E test
# 1. Record daily memory as main agent
# 2. Record daily memory as clone (via clone chat)
# 3. Search without source → both results
curl "http://localhost:3001/api/memory/search?q=E2E_TEST&top_k=5"
# 4. Search with source=main → only main result
curl "http://localhost:3001/api/memory/search?q=E2E_TEST&source=main&top_k=5"
# 5. Search with source=clone-name → only clone result
curl "http://localhost:3001/api/memory/search?q=E2E_TEST&source=E2E_TEST_clone&top_k=5"
```

## Dependencies
CMA-01 (FTS source column), CMA-02 (recordDaily with source)

## Implementation Notes
- Source filter is optional — when omitted, return all sources
- FTS MATCH + AND source = ? for combined search
- Text search on files: when source='main', search main dirs; when source=clone-name, search clone dir
- Add source field to MemorySearchResult type
