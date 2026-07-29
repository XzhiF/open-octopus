# Ticket 06 — Panel Layout Reorder

Status: done (commit 9f0a7d7)
Priority: P2
Blocked by: 02 (debug mode relocation changes DebugLogViewer props)
Packages: web-app

## Scope

Reorder the 7 config panels in ConfigTab by scenario grouping.

## Changes

### Reorder panels in ConfigTab.tsx
**File: `packages/web-app/components/agent/config/ConfigTab.tsx`**

Current order:
1. GeneralConfig
2. SafeModePanel
3. PersonaEditor
4. NotificationConfig
5. MemoryStrategyConfig
6. SafetyAudit
7. DebugLogViewer

New order:
1. GeneralConfig (通用配置) — basic settings
2. PersonaEditor (人格设定) — agent personality
3. NotificationConfig (通知渠道) — external communication
4. MemoryStrategyConfig (记忆策略) — data management
5. SafeModePanel (安全降级) ┐
6. SafetyAudit (安全审计)    ┘ safety group
7. DebugLogViewer (调试日志) — with debug mode toggle, last

## Verification
- `pnpm build` passes
- `pnpm test` passes
- Visual: panels appear in the specified order
