# Ticket 4: chat.ts -- Workspace clone prompt integration

**Phase**: 2 (Page Integration)
**Status**: done
**File**: `packages/server/src/routes/chat.ts`

## Description

Replace `SystemPromptAssembler.assembleForClone('workspace')` with `CloneRuntime(workspaceDef, org).assembleContext()` for the workspace chat route.

## Implementation

1. Add imports:
   ```typescript
   import { CloneRuntime } from '../services/agent/clone-runtime'
   import { getBuiltinCloneDef } from '../services/agent/builtin-clones'
   ```

2. Replace the assembler block (lines 89-95):
   ```typescript
   // Before
   let workspaceClonePrompt = ''
   try {
     const assembler = new SystemPromptAssembler('default')
     workspaceClonePrompt = assembler.assembleForClone('workspace')
   } catch {
     // Non-fatal
   }

   // After
   let workspaceClonePrompt = ''
   try {
     const cloneDef = getBuiltinCloneDef('workspace')
     if (cloneDef) {
       workspaceClonePrompt = new CloneRuntime(cloneDef, 'default').assembleContext()
     }
   } catch {
     // Non-fatal
   }
   ```

3. Remove unused `SystemPromptAssembler` import (line 7).

CWD stays as `workspace.path` (already correctly set on line 76).

## Verification Method

- **TypeScript**: `tsc --noEmit` passes
- **Grep**: `SystemPromptAssembler` is no longer imported in `chat.ts`
- **Build**: `pnpm build` passes
