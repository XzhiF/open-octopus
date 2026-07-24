# T4: Built-in Clone Definitions + Auto-Initialization

**Status:** done ✓
**Depends on:** T1, T2, T3
**Blocks:** T5, T6

## Scope

Define the 4 built-in clones (workspace, scheduler, archive, resource) and implement auto-initialization on server startup.

## Changes

### `packages/server/src/services/agent/builtin-clones.ts` (NEW)

Define the 4 built-in clones with their persona, skills, and memory scope:

```typescript
export const BUILTIN_CLONES: CloneDef[] = [
  {
    name: 'workspace',
    type: 'built-in',
    persona: 'Full-stack dev assistant',
    skills: [], // All global skills
    memoryScope: 'shared',
    config: {}
  },
  {
    name: 'scheduler',
    type: 'built-in',
    persona: 'Schedule management expert',
    skills: ['octo-schedule-manager'],
    memoryScope: 'isolated',
    config: {}
  },
  {
    name: 'archive',
    type: 'built-in',
    persona: 'Engineering analyst + knowledge curator',
    skills: ['octo-archive-analyst'],
    memoryScope: 'shared',
    config: {}
  },
  {
    name: 'resource',
    type: 'built-in',
    persona: 'Resource operations agent',
    skills: ['octo-resource-manager'],
    memoryScope: 'isolated',
    config: {}
  }
]
```

### `packages/server/src/services/agent/clone-init-service.ts` (NEW)

Auto-initialization on server startup:

```typescript
export class CloneInitService {
  /** Initialize built-in clones if not exists (idempotent) */
  initBuiltInClones(org: string, cloneDAO: CloneDAO): void
}
```

### Filesystem Layout

```
~/.octopus/agent/
├── built-in/
│   ├── workspace/
│   │   ├── persona.md
│   │   ├── memory/
│   │   │   ├── long-term.md
│   │   │   └── daily/
│   │   └── config.json
│   ├── scheduler/
│   │   ├── persona.md
│   │   └── memory/
│   ├── archive/
│   │   ├── persona.md
│   │   └── memory/
│   └── resource/
│       ├── persona.md
│       └── memory/
```

### Default Persona Templates

Each built-in clone gets a default persona.md:

- **workspace**: "你是 Workspace 分身，一个全栈开发助手..."
- **scheduler**: "你是 Scheduler 分身，专注定时任务管理..."
- **archive**: "你是 Archive 分身，工程分析师和知识策展人..."
- **resource**: "你是 Resource 分身，资源操作专家..."

### Server Startup Integration

Call `CloneInitService.initBuiltInClones()` from the server initialization flow (after `InitService.initAgent()`).

## Verification

1. Unit test: `CloneInitService` — verify directory structure created
2. Unit test: `CloneInitService` — verify idempotent (second run skips existing)
3. Unit test: `CloneInitService` — verify DB registration (4 rows in `clones` table)
4. Integration test: Server startup creates built-in clones
5. `pnpm build` passes
6. `pnpm test -- packages/server` passes
