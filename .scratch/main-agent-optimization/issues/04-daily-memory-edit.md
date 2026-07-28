# Issue 04: Daily Memory Edit

**Status:** pending
**Scope:** web-app
**Files:** `packages/web-app/components/agent/memory/DailyBrowser.tsx`

## Description
Add an edit button to DailyBrowser. When clicked, show a textarea editor for the daily memory content. Save via `addMemory({ layer: 'daily', content })` API.

## Acceptance Criteria
- Edit button visible on daily memory content
- Clicking edit shows textarea with current content
- Save calls API and refreshes content

## Verification
- `pnpm build` succeeds
