# T1: Shared Types — CloneDef + SessionRow/MessageRow Extensions

**Status:** pending
**Depends on:** —
**Blocks:** T2, T3, T5, T6, T8, T9

## Scope

Add new types and extend existing row types to support the clone system.

## Changes

### `packages/shared/src/types/agent.ts`
Add new interfaces:

```typescript
export interface CloneDef {
  name: string
  type: 'built-in' | 'user'
  persona: string
  skills: string[]
  memoryScope: 'shared' | 'isolated'
  workspaceRef?: { name: string; path: string; branch: string }
  config: {
    model?: string
    maxTurns?: number
    tools?: string[]
  }
}

export interface CloneSession extends Omit<SessionRow, 'scope_id' | 'provider_session_id'> {
  clone_name: string
  scope_id: string | null
  provider_session_id: string | null
}

export interface CloneMessage extends MessageRow {
  type: string
  metadata: string | null
}
```

### `packages/server/src/db/types.ts`
Extend existing row types:

**SessionRow** — add:
```typescript
scope_id: string | null
provider_session_id: string | null
```

**MessageRow** — add:
```typescript
type: string           // default 'text'
metadata: string | null  // JSON metadata
```

### `packages/server/src/db/dao/clone-dao.ts`
Add `type` column support to CloneRow:

**CloneRow** — add:
```typescript
type: string  // 'built-in' | 'user'
```

## Verification

1. `pnpm build` passes for both shared and server packages
2. TypeScript compilation: `tsc --noEmit` in both packages
3. Existing tests pass: `pnpm test -- packages/server` and `pnpm test -- packages/shared`
