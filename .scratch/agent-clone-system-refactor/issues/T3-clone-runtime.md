# T3: CloneRuntime Infrastructure — Context Assembly + Provider Encapsulation + Error Recovery

**Status:** done ✓
**Depends on:** T1, T2
**Blocks:** T5, T6, T7

## Scope

Create the `CloneRuntime` class — the shared infrastructure layer all clones use for context assembly, provider calls, and error recovery.

## Changes

### `packages/server/src/services/agent/clone-runtime.ts` (NEW)

```typescript
export class CloneRuntime {
  constructor(
    private cloneDef: CloneDef,
    private org: string,
  )

  /** Assemble clone-specific system prompt from persona + skills + memory */
  assembleContext(): string

  /** Send message via Claude SDK with resume + append */
  async *chat(
    message: string,
    sessionId: string,
    providerSessionId: string | null,
    cwd: string,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<MessageChunk>

  /** Read shared memory (global long-term + daily, read-only) */
  readSharedMemory(): string

  /** Write to isolated memory (clone-specific) */
  writeIsolatedMemory(content: string): void
}
```

### Responsibilities

1. **Context Assembly**: Build clone-specific system prompt
   - Read shared memory (global long-term + daily) — read-only
   - Write to isolated memory (`built-in/{name}/memory/`)
   - Stack skills: global skills + clone-specific skills
   - Replace persona: use clone's persona.md instead of main persona

2. **Provider Call Encapsulation**: Unified Claude SDK invocation
   - Always use `sendQuery` with `resume` (provider_session_id)
   - Always append clone context via `systemPrompt: { type: 'preset', preset: 'claude_code', append: ... }`
   - Handle streaming chunks uniformly

3. **Error Recovery**: Graceful degradation
   - Provider unavailable → fallback text response
   - Resume failure → retry without resume
   - Memory write failure → non-fatal, log only

### `packages/server/src/services/agent/paths.ts`

Add new path utility:

```typescript
/** Built-in clones directory: ~/.octopus/agent/built-in */
export function getBuiltInClonesDir(): string

/** Specific built-in clone directory: ~/.octopus/agent/built-in/{name} */
export function getBuiltInCloneDir(name: string): string

/** Built-in clone memory directory: ~/.octopus/agent/built-in/{name}/memory */
export function getBuiltInCloneMemoryDir(name: string): string
```

## Verification

1. Unit test: `CloneRuntime.assembleContext()` — verify persona + memory + skills concatenation
2. Unit test: `CloneRuntime.chat()` — verify resume parameter passed correctly
3. Unit test: `CloneRuntime.chat()` — verify retry without resume on resume failure
4. `pnpm build` passes for server package
5. `pnpm test -- packages/server` passes
