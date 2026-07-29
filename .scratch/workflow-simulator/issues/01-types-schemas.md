# Ticket 1: Foundation Types + Zod Schemas

## Scope
- `packages/engine/src/simulator/types.ts` — Core type definitions
- `packages/shared/src/simulator/schemas.ts` — Zod schemas for test fixtures
- Export from `packages/shared/src/index.ts`

## Types to Define
- TestFixture, TestScenario, MockDef (union), AssertionDef, SimResult
- AgentMockDef, SwarmMockDef, BashMockDef, PythonMockDef, ApprovalMockDef, LoopMockDef

## Acceptance Criteria
- TypeScript compiles cleanly
- Zod schemas validate fixture YAML correctly
