# Issue 01: Remove Tasks Tab

**Status:** pending
**Scope:** web-app
**Files:** `packages/web-app/components/agent/layout/AgentTabs.tsx`

## Description
Remove the Tasks tab from the Main Agent tab navigation. It overlaps with the Scheduler feature.

## Acceptance Criteria
- `task` entry removed from `TAB_CONFIG`
- Tasks tab no longer renders in the agent layout
- No unused imports

## Verification
- `pnpm build` succeeds
- Manual check: Tasks tab not visible
