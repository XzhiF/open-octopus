# Ticket 01 — Toast System Fix

Status: done (commit c6de813)
Priority: P0 (blocks all save feedback)
Packages: web-app

## Scope

Fix the toast feedback system so users see success/error notifications when saving config.

## Changes

### 1. Mount `<Toaster>` in AppShell
- File: `packages/web-app/components/providers/app-shell.tsx`
- Add `import { Toaster } from "@/components/ui/sonner"`
- Add `<Toaster position="top-right" richColors closeButton />` inside the AppShell component

### 2. Remove duplicate Toaster from sub-layouts
- File: `packages/web-app/app/system/layout.tsx` — remove `<Toaster position="top-right" />` and its import
- File: `packages/web-app/components/resource/resource-layout.tsx` — remove `<Toaster position="top-right" />` and its import

### 3. Fix PersonaEditor error toast
- File: `packages/web-app/components/agent/config/PersonaEditor.tsx`
- Add `else { toast.error('保存失败') }` after the `if (ok) toast.success(...)` line

### 4. Migrate scheduler from Radix toast to sonner
- `packages/web-app/app/scheduler/page.tsx` — `import { toast } from "@/hooks/use-toast"` → `import { toast } from "sonner"`
- `packages/web-app/app/scheduler/jobs/[id]/page.tsx` — replace `useToast()` with `toast` from sonner
- `packages/web-app/components/scheduler/export-dialog.tsx` — same
- `packages/web-app/components/scheduler/toggle-switch.tsx` — same (if uses Radix toast)
- `packages/web-app/hooks/use-scheduler-submit.ts` — same

### 5. Delete Radix toast dead code
- Delete `packages/web-app/components/ui/toaster.tsx`
- Delete `packages/web-app/components/ui/toast.tsx`
- Delete `packages/web-app/components/ui/use-toast.ts`
- Delete `packages/web-app/hooks/use-toast.ts`

### 6. Remove dependency
- `packages/web-app/package.json` — remove `@radix-ui/react-toast`

## Verification
- `pnpm build` passes
- `pnpm test` passes
- No remaining imports of `@radix-ui/react-toast`, `use-toast`, or `ui/toast`
