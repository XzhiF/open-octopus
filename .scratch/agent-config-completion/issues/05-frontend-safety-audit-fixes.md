# Issue 5: Frontend — Fix SafetyAudit UI (B6, B7)

**Status:** done
**Priority:** medium
**Depends on:** Issue 3
**Files:** `packages/web-app/components/agent/config/SafetyAudit.tsx`

## Problem

- **B6 (line 46):** `event.operation` text is truncated via CSS `truncate` class with no way to see the full text. Fix: add `title` attribute for native tooltip.
- **B7 (lines 41–53):** `event.context` field is never rendered. Fix: add collapsible detail panel.

## Acceptance Criteria

1. The operation span has `title={event.operation}` for native browser tooltip on hover
2. A collapsible `<details>` element renders `event.context` when present
3. Context display is formatted (JSON.stringify with indentation for objects, raw string otherwise)
4. When context is null/undefined, no collapsible panel is shown
5. No layout shift — existing row layout preserved

## Verification Method

```bash
cd packages/web-app && pnpm tsc --noEmit

# Visual: Open Config tab → SafetyAudit → hover over truncated operation text
# - Browser tooltip shows full operation text
# - Click to expand context panel (if context exists)
# - Context shows formatted JSON or string
```
