# Verified Spec — Agent Config Optimization

## Summary

Upgrade the Agent Config module from "functional but broken UX" to "closed-loop usable". Six focused changes: fix toast feedback, relocate debug mode toggle, enhance debug log with pagination+search, add collapsible prompt detail, create octo-notify skill, reorder panels by scenario grouping.

## Scope

### In Scope

| # | Change | Packages |
|---|--------|----------|
| 1 | Toast system fix | web-app |
| 2 | Debug Mode relocation | web-app |
| 3 | Debug log enhancement (pagination + search) | server, shared, web-app |
| 4 | Prompt detail collapsible | server, shared, web-app |
| 5 | octo-notify skill | core-pack |
| 6 | Panel layout reorder | web-app |

### Out of Scope
- Backend business logic refactoring
- New config fields
- i18n

## Detailed Design

### 1. Toast System Fix

**Root cause**: Sonner `<Toaster>` is not mounted in root layout or agent layout. Only `system/layout.tsx` and `resource-layout.tsx` mount it, so all agent/workspace/scheduler toast calls are silent no-ops.

**Changes:**
1. Add `<Toaster position="top-right" richColors closeButton />` to `components/providers/app-shell.tsx` (wraps all pages)
2. Remove duplicate `<Toaster>` from `app/system/layout.tsx` and `components/resource/resource-layout.tsx`
3. Fix `PersonaEditor.tsx`: add `else { toast.error('保存失败') }` branch
4. Migrate scheduler pages from Radix toast to sonner:
   - `app/scheduler/page.tsx` — change `import { toast } from "@/hooks/use-toast"` → `import { toast } from "sonner"`
   - `app/scheduler/jobs/[id]/page.tsx` — same migration, remove `useToast()` destructuring
   - `components/scheduler/export-dialog.tsx` — same
   - `components/scheduler/toggle-switch.tsx` — same (if applicable)
   - `hooks/use-scheduler-submit.ts` — same
5. Delete Radix toast dead code:
   - `components/ui/toaster.tsx`
   - `components/ui/toast.tsx`
   - `components/ui/use-toast.ts`
   - `hooks/use-toast.ts`
6. Remove `@radix-ui/react-toast` from `package.json`

### 2. Debug Mode Relocation

**Move** the Debug Mode `Switch` from `GeneralConfig.tsx` to the top of `DebugLogViewer.tsx`.

**Changes:**
- `GeneralConfig.tsx`: Remove `debugEnabled` state and the Switch UI block. Remove `debug: { enabled: debugEnabled }` from `handleSave` payload. Update description to remove "调试模式" mention.
- `DebugLogViewer.tsx`: Add debug mode toggle at top of panel. Read `config.debug.enabled` from `useAgentConfig` (or fetch separately). Save via `updateConfig({ debug: { enabled } })`.
- `ConfigTab.tsx`: Pass `config` and `saveConfig` to `DebugLogViewer` so it can toggle debug mode.

### 3. Debug Log Enhancement

**Backend** (`agent-service.ts` `getDebugLog()`):
- Implement real cursor-based pagination: cursor = ISO timestamp, read all JSONL files, sort by timestamp desc, apply cursor filter (entries before cursor), slice to `limit`
- Add `search` param: case-insensitive substring match on `message` field
- Add `start_date` / `end_date` params: filter by timestamp range
- Return `{ items, total, has_more, next_cursor }` where `total` = total matching entries, `next_cursor` = timestamp of last item in page

**Route** (`misc-routes.ts`):
- Accept new query params: `search`, `start_date`, `end_date`, `cursor`

**Shared types** (`shared/src/types/agent.ts`):
- No type changes needed (DebugLogEntry and pagination response already defined)

**Frontend** (`DebugLogViewer.tsx`):
- Add search input at top of log list
- Add "加载更多" button at bottom of log list
- Track `cursor`, `has_more`, `search` state
- On "加载更多": fetch next page with cursor, append to existing items
- On search change: reset list, fetch with search param (debounced 300ms)
- Replace `max-h-[400px]` with larger `max-h-[600px]`

**Frontend API** (`lib/agent/api.ts`):
- Extend `getDebugLog()` query params to include `search`, `start_date`, `end_date`

### 4. Prompt Detail Collapsible

**Backend** (`agent-service.ts` `getAssembleDetail()`):
- Add `content: seg.content` to each segment (full content alongside existing `content_preview`)

**Shared types** (`shared/src/types/agent.ts`):
- Add `content: string` to `DebugSegment` interface

**Frontend types** (`lib/agent/types.ts`):
- Add `content: string` to `DebugSegment` interface

**Frontend** (`DebugLogViewer.tsx`):
- Each segment: default collapsed showing `content_preview`
- Click to expand, showing full `content` in a `<pre>` block
- Use a simple `useState<Set<number>>` for expanded indices
- Right-side detail panel: use `ScrollArea` instead of native `overflow-auto`

### 5. octo-notify Skill

Create `packages/core-pack/skills/octo-notify/SKILL.md` following the format of existing skills (e.g., `octo-agent-sessions`).

Content should cover:
- What notification channels are configured (platform + target)
- When Agent should proactively notify (long tasks, errors, milestones)
- How to trigger notifications (via the notification config test endpoint or CLI)
- Reference to NotificationConfig in agent config

### 6. Panel Layout Reorder

**New order** in `ConfigTab.tsx`:
1. GeneralConfig (通用配置)
2. PersonaEditor (人格设定)
3. NotificationConfig (通知渠道)
4. MemoryStrategyConfig (记忆策略)
5. SafeModePanel (安全降级)
6. SafetyAudit (安全审计)
7. DebugLogViewer (调试日志)

Just reordering the JSX elements.

## Verification Strategy

- Unit tests: Backend pagination logic (`getDebugLog`), backend content field (`getAssembleDetail`)
- Build check: `pnpm build` passes after each ticket
- Test check: `pnpm test` passes after each ticket
- Manual: Visual check for panel order, debug mode position, toast display

## Risks

| # | Risk | Mitigation |
|---|------|-----------|
| R1 | JSONL full-read for pagination | Still reads all files but applies pagination in memory; acceptable for debug traces volume |
| R2 | Radix toast migration may break scheduler | Test each scheduler page's toast calls after migration |
| R3 | octo-notify skill format | Follow exact format of existing skills |
