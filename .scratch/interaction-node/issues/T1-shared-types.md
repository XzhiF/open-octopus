# T1: Shared Types — NodeDef Schema + NodeExecutionResult Extension

## Status: pending

## Scope
Extend `@octopus/shared` with interaction node type definitions:

1. **NodeDef interface** (`packages/shared/src/types/workflow.ts`):
   - Add `"interaction"` to the type union
   - Add `interaction_display?: "modal" | "panel"`
   - Add `interaction_max_rounds?: number`
   - Add `interaction_exit_when?: string`
   - Add `interaction_timeout?: number`
   - Add `interaction_agent?: InteractionAgentDef`

2. **InteractionAgentDef interface**:
   ```ts
   export interface InteractionAgentDef {
     skills?: string[]
     prompt?: string
     model?: string
     context?: "new" | "continue"
     goal?: string
     constraints?: string[]
   }
   ```

3. **NodeSchema (Zod)**:
   - Add `"interaction"` to the type enum
   - Add Zod schemas for all new fields

4. **NodeExecutionResult** (`packages/engine/src/executors/types.ts`):
   - Add `"pending_interaction"` to status union
   - Add `interactionMetadata?: InteractionMetadata`

5. **InteractionMetadata** interface:
   ```ts
   export interface InteractionMetadata {
     sessionId: string
     display: "modal" | "panel"
     nodeId: string
     maxRounds?: number
   }
   ```

## Verification Method
- `pnpm build` passes for @octopus/shared
- Schema validation: `NodeSchema.parse({ id: "test", type: "interaction", interaction_display: "modal" })` works
- TypeScript compiles without errors
