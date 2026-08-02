# Verified Spec — Interaction Node

## Summary

Add a new `interaction` workflow node type (8th type) that enables multi-turn AI-driven conversations through the existing chatbot UI. The interaction node replaces the current loop+approval+agent hack pattern with a native node type that uses a "Chat Bridge" pattern to connect WorkflowEngine with ChatService.

## Architecture

### Layer 1: Shared Types (`@octopus/shared`)

**NodeDef extension** — Add `interaction` to the type enum and new `interaction_*` prefixed fields:
- `interaction_display?: "modal" | "panel"` (default: `"modal"`)
- `interaction_max_rounds?: number` (default: 20)
- `interaction_exit_when?: string` (expression evaluated each round)
- `interaction_timeout?: number` (seconds)
- `interaction_agent?: InteractionAgentDef` (object with skills, prompt, model, context, goal, constraints)

**NodeExecutionResult** — Add `pending_interaction` status and `interactionMetadata` field (analogous to `pending_approval` + `approvalMetadata`).

### Layer 2: Engine (`@octopus/engine`)

**InteractionExecutor** — New executor class following the same pattern as ApprovalExecutor:
1. First call: returns `pending_interaction` status with `interactionMetadata` (sessionId, display mode)
2. Resume call (with completion data): processes vars_update, applies outputs mapping, returns `completed`

**`complete_interaction` tool definition** — Tool schema for the Agent SDK: `{ summary, vars_update }`. Intercepted via PreToolUse hooks (same pattern as AskUserQuestion).

**Simulator support** — MockInteractionExecutor + InteractionMockDef in the simulator.

### Layer 3: Server (`@octopus/server`)

**Chat Bridge** — New service that:
1. Creates interaction sessions (chat_sessions with linked_execution_id/linked_node_id)
2. Injects the initial prompt into the chat session
3. Monitors for completion signals (complete_interaction tool + exit_when expression)
4. Constructs NodeExecutionResult when complete

**DB schema** — 4 new columns on chat_sessions:
- `linked_execution_id TEXT`
- `linked_node_id TEXT`
- `interaction_mode TEXT` ('modal' | 'panel')
- `interaction_status TEXT` ('active' | 'completed' | 'timeout')

**API routes**:
- `POST /api/executions/:id/interaction/:nodeId/start` → creates session
- `GET /api/executions/:id/interaction/:nodeId/status` → query status
- `POST /api/executions/:id/interaction/:nodeId/complete` → force complete

**SSE events**:
- `execution_interaction_started` — with sessionId and display mode
- `execution_interaction_completed` — with summary and vars_update

### Layer 4: Web App (`@octopus/web-app`)

**Interaction node UI**:
- Modal mode: opens a dialog with embedded chatbot when interaction starts
- Panel mode: renders chatbot in sidebar
- Integrates with existing QuestionCard for structured questions
- Handles SSE events to open/close the interaction UI

## Key Design Decisions

1. **`interaction_` prefix** on all interaction-specific YAML fields to avoid conflicts with existing node fields
2. **`outputs` field** — NO prefix (shared across node types)
3. **Chat Bridge** is a server-layer component — does NOT modify ChatService core
4. **`pending_interaction`** status — analogous to `pending_approval`, engine pauses and waits
5. **Dual completion** — `complete_interaction` tool (primary) + `interaction_exit_when` expression (safety net)
6. **`interaction_max_rounds`** — hard limit on conversation rounds, auto-completes when hit

## Data Model

| Table | Operation | Column | Type | Notes |
|-------|-----------|--------|------|-------|
| chat_sessions | ADD | linked_execution_id | TEXT | FK to executions |
| chat_sessions | ADD | linked_node_id | TEXT | Node ID within workflow |
| chat_sessions | ADD | interaction_mode | TEXT | 'modal' or 'panel' |
| chat_sessions | ADD | interaction_status | TEXT | 'active', 'completed', 'timeout' |

## Verification Plan

1. **Unit tests**: InteractionExecutor creation, exit_when evaluation, complete_interaction interception, max_rounds counter, VarPool updates, NodeDef schema validation
2. **Simulator integration**: interaction.test.yaml with happy path, multi-round, exit_when, max_rounds scenarios
3. **E2E (future)**: Playwright tests for modal/panel display
4. **Regression**: existing approval/bash/agent tests still pass
