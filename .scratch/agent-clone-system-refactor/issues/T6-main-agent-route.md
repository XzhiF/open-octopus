# T6: Main Agent Unified Entry Route (Tool-Calling Delegation)

**Status:** done ✓
**Depends on:** T3, T4, T5
**Blocks:** T7

## Scope

Create the Main Agent unified entry route (`POST /api/agent/chat`) where the LLM itself decides which clone to delegate to via tool-calling.

## Changes

### `packages/server/src/routes/agent/main-agent-route.ts` (NEW)

Single endpoint:

| Method | Path | Handler | Notes |
|--------|------|---------|-------|
| `POST` | `/api/agent/chat` | Main Agent chat | LLM decides delegation via tool-calling |

### Flow

```
User message → Main Agent (Claude SDK)
  ↓ LLM tool-calling
  ├── delegate_to_clone(clone_name, task) → CloneRuntime
  ├── create_schedule(cron, task) → Scheduler clone
  ├── analyze_archive(workspace_id) → Archive clone
  └── manage_resources(task) → Resource clone
```

### Tool Definitions

Define tools the Main Agent can use:

```typescript
const mainAgentTools = {
  delegate_to_workspace: {
    description: 'Delegate a development task to the workspace clone',
    input_schema: { task: string, workspace_id?: string }
  },
  delegate_to_scheduler: {
    description: 'Create or manage a scheduled task',
    input_schema: { task: string, cron?: string }
  },
  delegate_to_archive: {
    description: 'Analyze a workspace for archival',
    input_schema: { workspace_id: string }
  },
  delegate_to_resource: {
    description: 'Execute a resource operation',
    input_schema: { task: string }
  },
}
```

### Implementation

1. Main Agent uses CloneRuntime with the main agent persona
2. When LLM calls a delegation tool, instantiate CloneRuntime for the target clone
3. Stream the clone's response back to the user
4. Fall back to direct response if no delegation needed

### Mount Point

Register in `packages/server/src/routes/agent/index.ts`:

```typescript
agent.route('/', createMainAgentRoute({ sessionDAO, cloneDAO }))
```

## Verification

1. Integration test: Send message → Main Agent responds directly (no delegation)
2. Integration test: Send task message → Main Agent delegates to workspace clone → clone responds
3. Integration test: Send schedule message → Main Agent delegates to scheduler clone
4. `pnpm build` passes
5. `pnpm test -- packages/server` passes
