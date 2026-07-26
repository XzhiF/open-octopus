# Ticket 1: paths.ts -- add getCloneSkillsDir()

**Phase**: 1 (Infrastructure)
**Status**: done
**File**: `packages/server/src/services/agent/paths.ts`

## Description

Add a new path utility function `getCloneSkillsDir(name, type)` that returns the skills directory for a specific clone, respecting the built-in vs user type distinction.

## Implementation

```typescript
export function getCloneSkillsDir(name: string, type: 'built-in' | 'user'): string {
  if (type === 'built-in') {
    return path.join(getBuiltInCloneDir(name), 'skills')
  }
  return path.join(getCloneDir(name), 'skills')
}
```

## Verification Method

- **Unit test**: Verify `getCloneSkillsDir('scheduler', 'built-in')` returns `~/.octopus/agent/built-in/scheduler/skills`
- **Unit test**: Verify `getCloneSkillsDir('my-clone', 'user')` returns `~/.octopus/agent/clones/my-clone/skills`
- **TypeScript**: `tsc --noEmit` passes
