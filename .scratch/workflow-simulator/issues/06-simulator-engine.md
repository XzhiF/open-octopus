# Ticket 6: Simulator Engine

## Scope
- `packages/engine/src/simulator/simulator-engine.ts`

## Features
- Wraps WorkflowEngine with SimulatorExecutorFactory
- Accepts workflow + test scenario
- Runs full simulation
- Returns SimResult with nodeResults + poolSnapshot + executionTrace

## Acceptance Criteria
- Can simulate a simple linear workflow end-to-end
