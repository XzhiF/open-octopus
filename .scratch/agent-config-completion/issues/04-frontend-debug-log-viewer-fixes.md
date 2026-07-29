# Issue 4: Frontend — Fix DebugLogViewer bugs (B1, B4)

**Status:** done
**Priority:** high
**Depends on:** Issue 1, Issue 2
**Files:** `packages/web-app/components/agent/config/DebugLogViewer.tsx`

## Problem

- **B1 (line 105):** `Object.keys(selectedLog.skill_sources)` crashes when `skill_sources` is undefined. Fix: add `?? {}` guard.
- **B4 (line 64):** Selection highlight compares `selectedLog?.id === log.id` but `id` may be undefined on both sides, causing all items to highlight. Fix: compare `chat_id` instead.

## Acceptance Criteria

1. Line 105: `selectedLog.skill_sources` access is guarded with `?? {}` so undefined doesn't crash
2. Line 64: Selection comparison uses `chat_id` (which is always present) instead of `id`
3. Clicking a log entry highlights only that entry
4. Clicking a log entry shows segment details without crashing, even when skill_sources is empty/undefined
5. No TypeScript errors introduced

## Verification Method

```bash
cd packages/web-app && pnpm tsc --noEmit
# No type errors in DebugLogViewer.tsx

# Visual: Open Config tab → DebugLogViewer → click a log entry
# - Only clicked entry highlighted (not all)
# - Detail panel renders without crash
# - skill_sources section shows "SKILL 来源" or nothing (no crash)
```
