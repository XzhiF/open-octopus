# Verified Spec — Agent Clone System Refactor

**Branch:** `feat-builit-in-engines`
**Fixed point:** `main`
**Scope:** Server + Shared + Providers (web-app/cli are unchecked, excluded from this spec)

## 1. Architecture Overview

### 1.1 Current State (As-Is)

The Agent module has three separate chat implementations:

1. **Workspace Chat** (`ChatService` + `ChatDAO` + `/api/workspaces/:id/chat/*`): Uses `chat_sessions`/`chat_messages` tables, Claude SDK with resume, stores thinking/tool_call as separate message rows with type+metadata.

2. **Agent Chat** (`AgentSessionDAO` + `/api/agent/sessions/:id/chat`): Uses `sessions`/`messages` tables, calls `OrchestratorService.orchestrate()` before Claude SDK, no resume support, stores thinking/tool_calls in a JSON blob in `tool_calls` column.

3. **Clone Delegate** (`clone-routes.ts` + `/api/agent/clones/:name/delegate`): Filesystem-backed (meta.json), calls Claude SDK with clone system prompt, no session persistence, no streaming.

**OrchestratorService** (1115 lines) mixes three concerns:
- Intent classification + workflow selection (to be deleted — LLM replaces this)
- Task execution via Claude SDK (to be moved to resource clone)
- Archive analysis pipeline (to be moved to archive clone)

### 1.2 Target State (To-Be)

```
                    ┌─────────────────────────────┐
                    │    Unified Entry (CLI)       │
                    │   POST /api/agent/chat       │
                    │   Main Agent (LLM Router)    │
                    └─────────┬───────────────────┘
                              │ tool-calling delegation
         ┌────────────────────┼────────────────────┐
         │                    │                    │
    ┌────▼─────┐  ┌──────────▼────────┐  ┌───────▼──────┐
    │workspace │  │    scheduler      │  │   archive    │
    │  clone   │  │     clone         │  │    clone     │
    └────┬─────┘  └──────────┬────────┘  └───────┬──────┘
         │                    │                    │
    ┌────▼────────────────────▼────────────────────▼──────┐
    │                  CloneRuntime                        │
    │  ┌──────────┐  ┌────────────┐  ┌──────────────────┐ │
    │  │ Context  │  │  Provider  │  │  Error Recovery  │ │
    │  │ Assembly │  │  Encap.    │  │                  │ │
    │  └──────────┘  └────────────┘  └──────────────────┘ │
    └───────────────────┬─────────────────────────────────┘
                        │
    ┌───────────────────▼─────────────────────────────────┐
    │             Unified Session Layer                    │
    │  AgentSessionDAO (extended: type, metadata,         │
    │  provider_session_id, scope_id)                  │
    └─────────────────────────────────────────────────────┘
```

**Direct Entry (Web UI):** Pages connect directly to specific clones via `/api/clones/:name/sessions/...` — bypassing Main Agent for zero-latency interaction.

## 2. Data Model Changes

### 2.1 Schema Migration (ALTER TABLE)

```sql
-- messages: add type + metadata (matching chat_messages schema)
ALTER TABLE messages ADD COLUMN type TEXT DEFAULT 'text';
ALTER TABLE messages ADD COLUMN metadata TEXT;

-- sessions: add scope_id + provider_session_id
ALTER TABLE sessions ADD COLUMN scope_id TEXT;
ALTER TABLE sessions ADD COLUMN provider_session_id TEXT;
```

**No data migration** — existing rows get defaults (type='text', metadata=null, scope_id=null, provider_session_id=null).

### 2.2 Type Extensions

**SessionRow** (db/types.ts):
```typescript
export interface SessionRow {
  // ... existing fields ...
  scope_id: string | null           // NEW
  provider_session_id: string | null    // NEW
}
```

**MessageRow** (db/types.ts):
```typescript
export interface MessageRow {
  // ... existing fields ...
  type: string           // NEW: 'thinking' | 'text' | 'tool_call' | 'tool_result' | 'error'
  metadata: string | null  // NEW: JSON metadata
}
```

### 2.3 New Shared Types (@octopus/shared)

**CloneDef** — Runtime clone definition (filesystem + DB backed):
```typescript
interface CloneDef {
  name: string                    // 'workspace' | 'scheduler' | 'archive' | 'resource'
  type: 'built-in' | 'user'
  persona: string                 // persona.md content
  skills: string[]                // skill names
  memoryScope: 'shared' | 'isolated'
  workspaceRef?: { name: string; path: string; branch: string }
  config: {
    model?: string
    maxTurns?: number
    tools?: string[]
  }
}
```

**CloneSession** — Session with clone context:
```typescript
interface CloneSession extends SessionRow {
  clone_name: string
  scope_id: string | null
  provider_session_id: string | null
}
```

**CloneMessage** — Message with type + metadata:
```typescript
interface CloneMessage extends MessageRow {
  type: string
  metadata: string | null
}
```

## 3. CloneRuntime

New infrastructure layer at `packages/server/src/services/agent/clone-runtime.ts`.

### 3.1 Responsibilities

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

### 3.2 Interface

```typescript
export class CloneRuntime {
  constructor(private cloneDef: CloneDef, private org: string)

  /** Assemble clone-specific system prompt */
  assembleContext(): string

  /** Send message via Claude SDK with resume + append */
  async *chat(
    message: string,
    sessionId: string,
    providerSessionId: string | null,
    cwd: string,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<MessageChunk>

  /** Read shared memory (global, read-only) */
  readSharedMemory(): string

  /** Write to isolated memory (clone-specific) */
  writeIsolatedMemory(content: string): void
}
```

## 4. Built-in Clone Definitions

Four built-in clones initialized at `~/.octopus/agent/built-in/{name}/`:

| Clone | Persona | Skills | Memory | Workspace |
|-------|---------|--------|--------|-----------|
| `workspace` | Full-stack dev assistant | All global skills | shared read + isolated write | Bound to active workspace |
| `scheduler` | Schedule management expert | octo-schedule-manager | isolated | None |
| `archive` | Engineering analyst + knowledge curator | octo-archive-analyst | shared read | None |
| `resource` | Resource operations agent | octo-resource-manager | isolated | None |

### 4.1 Auto-Initialization

On server startup, if `~/.octopus/agent/built-in/` doesn't exist:
1. Create directory structure for each built-in clone
2. Write default persona.md for each
3. Register in `clones` table with `type: 'built-in'` (new column)

### 4.2 Filesystem Layout

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
├── clones/            ← user clones (unchanged)
├── memory/            ← global shared memory (read-only for clones)
├── persona.md         ← main agent persona (unused by clones)
└── skills/            ← global skills
```

## 5. API Contracts

### 5.1 Direct Entry (Clone Sessions)

New route module: `packages/server/src/routes/clone/`

| Method | Path | Handler | Notes |
|--------|------|---------|-------|
| `POST` | `/api/clones/:name/sessions` | Create clone session | Inserts into `sessions` with `clone_name` + `scope_id` |
| `GET` | `/api/clones/:name/sessions` | List clone sessions | Filter by `clone_name` |
| `GET` | `/api/clones/:name/sessions/:id` | Get session + messages | Uses extended MessageRow |
| `POST` | `/api/clones/:name/sessions/:id/chat` | Chat SSE stream | Uses CloneRuntime |
| `POST` | `/api/clones/:name/sessions/:id/stop` | Stop generation | Uses active stream registry |

### 5.2 Unified Entry (Main Agent)

| Method | Path | Handler | Notes |
|--------|------|---------|-------|
| `POST` | `/api/agent/chat` | Main Agent chat | LLM decides delegation via tool-calling |

**Simplified flow:** No more `OrchestratorService.classifyIntent()` / `selectWorkflow()` / `generateWorkflow()`. The Main Agent IS the LLM — it decides what to do via its own tool-calling capabilities.

### 5.3 Clone Management

| Method | Path | Handler | Notes |
|--------|------|---------|-------|
| `GET` | `/api/clones` | List all clones | Built-in + user clones |
| `GET` | `/api/clones/:name` | Get clone details | CloneDef format |
| `POST` | `/api/clones` | Create user clone | User-defined clones only |
| `DELETE` | `/api/clones/:name` | Delete user clone | Built-in clones cannot be deleted |

## 6. OrchestratorService Decomposition

### 6.1 Methods to Delete

- `classifyIntent()` — LLM replaces regex-based intent classification
- `selectWorkflow()` — LLM decides workflow selection via tool-calling
- `generateWorkflow()` — LLM generates workflows dynamically
- `organizeInputs()` — LLM extracts inputs
- `orchestrate()` — Main entry point, no longer needed
- `buildSummary()` — Helper, no longer needed

### 6.2 Methods to Redistribute

| Method | Destination | Rationale |
|--------|-------------|-----------|
| `analyzeWorkspaceForArchive()` | Archive clone | Archive clone owns analysis pipeline |
| `callArchiveLLM()` | CloneRuntime | Shared LLM call utility |
| `executeTask()` | Resource clone | Resource operations agent |
| `selectAndInstallAgents()` | Resource clone | Resource agent selection |

### 6.3 Deletion Sequence

1. First: Redistribute methods to clones (archive/resource)
2. Second: Update all call sites (chat-routes, resource-agent-service, etc.)
3. Third: Delete OrchestratorService class + singleton
4. Fourth: Remove imports + test updates

## 7. Session Unification

### 7.1 AgentSessionDAO Extensions

New methods on AgentSessionDAO to support clone sessions:

```typescript
// Update provider_session_id for resume
updateProviderSession(id: string, providerSessionId: string): RunResult

// Insert message with type + metadata
insertCloneMessage(row: {
  id: string; session_id: string; role: string;
  type: string; content: string; metadata: string | null;
  created_at: string;
}): RunResult
```

### 7.2 ChatService/ChatDAO Deprecation Strategy

**Phase 1 (this refactor):** New clone session APIs use AgentSessionDAO exclusively. ChatService/ChatDAO remain for existing workspace chat endpoints.

**Phase 2 (future):** Frontend switches workspace chat to use clone session API. ChatService/ChatDAO become dead code.

**Phase 3 (cleanup):** Remove ChatService/ChatDAO + `chat_sessions`/`chat_messages` tables.

## 8. Provider Unification

All clones use the same Provider call pattern:

```typescript
const provider = getProvider('claude')
const stream = provider.sendQuery(message, cwd, providerSessionId ?? undefined, {
  systemPrompt: { type: 'preset', preset: 'claude_code', append: cloneSystemPrompt },
  abortSignal,
})
```

Key invariants:
- `resume` parameter = `providerSessionId` from session row (null on first message)
- `append` = clone-specific system prompt (persona + skills + memory context)
- After each response, update `provider_session_id` from `result.sessionId`

## 9. What NOT to Change

- **Swarm executor** (engine package) — untouched
- **Workflow Engine core** — untouched
- **core-pack resources** — untouched
- **Frontend rendering logic** — only API paths change
- **Existing workspace chat routes** — remain functional during deprecation

## 10. Risk Mitigations

| Risk | Mitigation |
|------|-----------|
| R1: Frontend API breakage | Clone routes return same SSE event format as existing chat routes |
| R2: OrchestratorService residual refs | Grep all imports before deletion; update tests |
| R3: SDK resume + append compat | Tested empirically; fallback to no-resume if append fails |
| R4: Built-in dir not initialized | Auto-init on server startup (idempotent) |
| R5: Dual system during migration | ChatService/ChatDAO kept alive; new code uses AgentSessionDAO |
