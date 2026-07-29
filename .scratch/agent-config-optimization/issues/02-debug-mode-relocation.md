# Ticket 02 — Debug Mode Relocation

Status: done (commit 173baac)
Priority: P1
Packages: web-app

## Scope

Move the Debug Mode toggle switch from GeneralConfig to the top of DebugLogViewer, so the toggle and the log viewer are in one unified "debug" section.

## Changes

### 1. Remove Debug Mode from GeneralConfig
- File: `packages/web-app/components/agent/config/GeneralConfig.tsx`
- Remove `debugEnabled` state and Switch UI
- Remove `debug: { enabled: debugEnabled }` from handleSave payload
- Update description text to remove "调试模式" mention

### 2. Add Debug Mode toggle to DebugLogViewer
- File: `packages/web-app/components/agent/config/DebugLogViewer.tsx`
- Accept `config` and `onSave` props (or use `useAgentConfig` directly)
- Add Switch at the top of the panel header area
- Toggle calls `onSave({ debug: { enabled } })`

### 3. Update ConfigTab to pass props
- File: `packages/web-app/components/agent/config/ConfigTab.tsx`
- Pass `config` and `saveConfig` to `<DebugLogViewer />`

## Verification
- `pnpm build` passes
- `pnpm test` passes
- GeneralConfig no longer contains Debug Mode switch
- DebugLogViewer has Debug Mode switch at top
