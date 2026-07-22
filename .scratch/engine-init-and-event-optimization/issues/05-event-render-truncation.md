# Ticket 5: Event Render Truncation in ExecutionLogViewer

## Status: DONE

## Description

In ExecutionLogViewer, each node group shows the real event count in the header but only renders the latest 100 events when expanded. Pure frontend truncation — no server changes.

## Files

- `packages/web-app/components/workspace/execution-log-viewer.tsx`

## Implementation

In the group rendering section (inside the `Array.from(nodeGroups.entries()).map(...)` loop), apply truncation:

```tsx
const MAX_RENDERED_EVENTS = 100

// Inside the expanded group div:
{!collapsedNodes.has(key) && (
  <div className="px-2 py-1 space-y-1">
    {group.events.length > MAX_RENDERED_EVENTS && (
      <div className="text-[10px] text-muted-foreground/60 text-center py-0.5">
        显示最新 {MAX_RENDERED_EVENTS} 条（共 {group.events.length} 条）
      </div>
    )}
    {group.events
      .slice(-MAX_RENDERED_EVENTS)
      .map((entry, i) => (
        <ExpandableRow key={`${key}-${i}`} entry={entry} />
      ))
    }
  </div>
)}
```

The header `{group.events.length} events` already shows the real count — no change needed there.

## Acceptance Criteria

- [ ] Node group with 200+ events shows "显示最新 100 条（共 237 条）" indicator
- [ ] Only 100 events are rendered in the DOM for large groups
- [ ] Node group with ≤100 events shows all events, no truncation indicator
- [ ] The header still shows real count (e.g., "237 events")
- [ ] Oldest events are dropped, newest are kept

## Verification

- `pnpm build` succeeds
- Manual: run a workflow with a long agent node, verify truncation behavior
