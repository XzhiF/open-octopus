# Ticket 5: global-chat.ts -- Scheduler clone prompt + CWD

**Phase**: 2 (Page Integration)
**Status**: done
**File**: `packages/server/src/routes/global-chat.ts`

## Description

Replace `SystemPromptAssembler.assembleForClone('scheduler')` with `CloneRuntime(schedulerDef, org).assembleContext()`. Change CWD from `process.cwd()` to `getBuiltInCloneDir('scheduler')`.

## Implementation

1. Add imports:
   ```typescript
   import { CloneRuntime } from '../services/agent/clone-runtime'
   import { getBuiltinCloneDef } from '../services/agent/builtin-clones'
   import { getBuiltInCloneDir } from '../services/agent/paths'
   ```

2. Replace the assembler block (lines 116-123):
   ```typescript
   // Before
   let schedulerClonePrompt = ''
   try {
     const assembler = new SystemPromptAssembler('default')
     schedulerClonePrompt = assembler.assembleForClone('scheduler')
   } catch {
     schedulerClonePrompt = SYSTEM_PROMPT
   }

   // After
   let schedulerClonePrompt = SYSTEM_PROMPT
   try {
     const cloneDef = getBuiltinCloneDef('scheduler')
     if (cloneDef) {
       schedulerClonePrompt = new CloneRuntime(cloneDef, 'default').assembleContext()
     }
   } catch {
     // Fallback to SYSTEM_PROMPT (already set as default)
   }
   ```

3. Change CWD (line 103):
   ```typescript
   // Before
   const cwd = process.cwd()

   // After
   const cwd = getBuiltInCloneDir('scheduler')
   ```

4. Remove unused `SystemPromptAssembler` import (line 6).

5. Keep `loadSchedulerSystemPrompt()` + `SKILL_SEARCH_PATHS` + `SYSTEM_PROMPT` as fallback -- do NOT delete.

## Verification Method

- **TypeScript**: `tsc --noEmit` passes
- **Grep**: `SystemPromptAssembler` is no longer imported in `global-chat.ts`
- **Build**: `pnpm build` passes
