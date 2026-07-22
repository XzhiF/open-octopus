# Ticket 5: Event rendering truncation in ExecutionLogViewer

## Status: DONE

## Description

In ExecutionLogViewer, when a node group has more than 100 events, display the real count in the header but only render the latest 100 events.

## Files

- `packages/web-app/components/workspace/execution-log-viewer.tsx`
- `packages/web-app/components/workspace/__tests__/execution-log-viewer.test.tsx` (new or extend)

## Changes

### Truncation Logic

Add a constant and apply slice before rendering:

```typescript
const MAX_RENDERED_EVENTS = 100

// In the render section:
const totalEvents = group.events.length
const eventsToRender = totalEvents > MAX_RENDERED_EVENTS
  ? group.events.slice(-MAX_RENDERED_EVENTS)
  : group.events
```

### Header Display

The header already shows `{group.events.length} events`. No change needed — it will show the real count (e.g., "237 events").

### Optional: Truncation Indicator

When truncated, show a subtle indicator:

```tsx
{totalEvents > MAX_RENDERED_EVENTS && (
  <span className="text-muted-foreground/60 text-[10px] ml-1">
    (显示最新 {MAX_RENDERED_EVENTS} 条)
  </span>
)}
```

## Unit Tests

1. Given 200 events in a group, verify only 100 are rendered (count DOM nodes)
2. Given 50 events in a group, verify all 50 are rendered
3. Given 200 events, verify header shows "200 events"
4. Given exactly 100 events, verify all 100 are rendered (boundary)

## Verification

- `pnpm test -- packages/web-app` passes
- `pnpm build` succeeds
- Manual E2E: Long task node shows real count, renders only 100 items
