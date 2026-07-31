# T6: Chat Bridge Service

## Status: pending

## Scope
Create the Chat Bridge service that connects WorkflowEngine with ChatService:

1. **ChatBridge class** (`packages/server/src/services/chat-bridge.ts`):
   - `createInteractionSession(executionId, nodeId, agentConfig, display)` → creates chat session, returns sessionId
   - `sendInitialPrompt(sessionId, prompt)` → injects first message
   - `monitorCompletion(sessionId, exitWhen, maxRounds)` → watches for completion signals
   - `forceComplete(sessionId, summary, varsUpdate)` → manual/admin completion

2. **`complete_interaction` tool definition**:
   - Tool schema: `{ name, description, input_schema: { summary, vars_update } }`
   - Registered as a custom tool for interaction agent sessions
   - PreToolUse hook intercepts the call (same pattern as AskUserQuestion)
   - When intercepted: captures summary + vars_update, marks session complete

3. **Completion detection**:
   - Primary: `complete_interaction` tool call intercepted
   - Secondary: `interaction_exit_when` expression evaluated against VarPool after each round
   - Tertiary: `interaction_max_rounds` counter reached
   - Quaternary: `interaction_timeout` elapsed

## Files
- Create: `packages/server/src/services/chat-bridge.ts`

## Dependencies
- T5 (DB schema + DAO)

## Verification Method
- Unit test: createInteractionSession creates correct DB row
- Unit test: complete_interaction tool definition has correct schema
- `pnpm build` passes
