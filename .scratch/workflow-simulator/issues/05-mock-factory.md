# Ticket 5: Mock Factory

## Scope
- `packages/engine/src/simulator/mock-factory.ts`
- `packages/engine/src/__tests__/simulator/mock-factory.test.ts`

## Features
- SimulatorExecutorFactory returns mock executors for side-effect nodes
- Returns real executors for logic nodes (condition, loop)
- Supports real_execution list for opt-in real bash/python execution
- Strict mode: fail on missing mock definitions

## Acceptance Criteria
- 8+ test cases from brief verification plan pass
