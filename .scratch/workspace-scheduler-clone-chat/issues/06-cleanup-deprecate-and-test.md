# Ticket 6: Cleanup -- deprecate assembleForClone + tests

**Phase**: 3 (Cleanup)
**Status**: done
**Files**: `packages/server/src/services/agent/system-prompt-assembler.ts`, test files

## Description

1. Mark `SystemPromptAssembler.assembleForClone()` as `@deprecated` with JSDoc comment directing callers to `CloneRuntime.assembleContext()`.
2. Update existing `clone-runtime.test.ts` tests to cover the new `loadSkills()` two-tier model.
3. Ensure all existing tests still pass.

## Implementation

### Deprecation

```typescript
/**
 * @deprecated Use CloneRuntime.assembleContext() instead.
 * This method uses the old SystemPromptAssembler pipeline which does not
 * support the two-tier skill model or clone-specific CWD.
 */
assembleForClone(cloneName: string, options: AssembleOptions = {}): string {
  // ... existing implementation unchanged
}
```

### Tests

Extend `clone-runtime.test.ts` with new test cases:

- Two-tier skill scanning (shared + clone skills)
- Same-name dedup: clone overrides shared
- Filtering: non-empty skills list filters to listed skills only
- Empty skills list: includes all found skills
- Output format: base directory declaration + grouped list
- `getDefaultCwd()`: built-in clone -> `built-in/{name}/`, user clone -> `clones/{name}/`

## Verification Method

- **Test**: `pnpm test` passes (all existing + new tests)
- **Build**: `pnpm build` passes
- **TypeScript**: `tsc --noEmit` passes
