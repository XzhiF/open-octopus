# Ticket 3: builtin-clones.ts -- fix scheduler skill name

**Phase**: 1 (Infrastructure)
**Status**: done
**File**: `packages/server/src/services/agent/builtin-clones.ts`

## Description

Fix the scheduler clone's skill name from `octo-schedule-manager` to `octo-scheduler` to match the actual installed skill.

## Implementation

```typescript
// Before
skills: ['octo-schedule-manager'],

// After
skills: ['octo-scheduler'],
```

## Verification Method

- **Grep**: Confirm no remaining references to `octo-schedule-manager` in the codebase
- **TypeScript**: `tsc --noEmit` passes
