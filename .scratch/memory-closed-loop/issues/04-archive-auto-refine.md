# Issue 4: Archive route auto-trigger refine after archive

## Summary
After `POST /memory/archive` succeeds, automatically call `refineLongTerm()` to deduplicate and compress long-term memory.

## Changes
1. `packages/server/src/routes/agent/memory.ts` — add refine call after archive success

## Details
- In the `POST /memory/archive` handler, after the file is moved and long-term is merged:
  ```typescript
  // Auto-refine long-term memory after archive
  let refineResult = null
  try {
    refineResult = getMemoryService().refineLongTerm(org)
  } catch {
    // Refine failure is non-fatal
  }
  ```
- Include refine result in the response:
  ```json
  { "ok": true, "archived": true, "refine": { "refined": true, "before_tokens": 100, "after_tokens": 80 } }
  ```

## Verification Method
- Build: `pnpm build` succeeds
- Manual: trigger archive, verify long-term.md is refined and .bak exists
