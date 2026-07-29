# Ticket 04 — Prompt Detail Collapsible

Status: done (commit 65d3671)
Priority: P2
Packages: server, shared, web-app

## Scope

Add full `content` field to debug segment detail and make each segment collapsible in the UI.

## Changes

### Backend
**File: `packages/server/src/services/agent/agent-service.ts`** — `getAssembleDetail()`:
- Add `content: seg.content` alongside `content_preview` in the segment mapping

### Shared Types
**File: `packages/shared/src/types/agent.ts`** — `DebugSegment`:
- Add `content: string` field

### Frontend Types
**File: `packages/web-app/lib/agent/types.ts`** — `DebugSegment`:
- Add `content: string` field

### Frontend UI
**File: `packages/web-app/components/agent/config/DebugLogViewer.tsx`**:
- Each segment card: default collapsed showing `content_preview`
- Click header to toggle expanded state showing full `content`
- Track expanded state with `useState<Set<number>>`
- Right-side detail panel: replace `overflow-auto` with Radix `ScrollArea`

## Verification
- `pnpm build` passes
- `pnpm test` passes
- Each segment shows preview by default, expands to full content on click
