# Workflow Simulator — Technical Spec

## Summary
A lightweight simulation/testing framework for Octopus workflows that allows verification without real LLM calls or side effects.

## Architecture

```
packages/engine/src/simulator/
├── index.ts              ← Public exports
├── types.ts              ← Core type definitions
├── assertions.ts         ← 4-type assertion engine
├── syntax-checker.ts     ← bash -n / python compile() pre-check
├── mock-executors.ts     ← 5 mock executor classes
├── mock-factory.ts       ← SimulatorExecutorFactory
├── simulator-engine.ts   ← Core orchestrator
└── test-runner.ts        ← Scenario executor + fixture loader

packages/shared/src/simulator/
└── schemas.ts            ← Zod schemas for test fixtures
```

## Key Design Decisions

1. **Mock executors implement `NodeExecutor`** — same interface as real executors
2. **SimulatorEngine wraps WorkflowEngine** — replaces ExecutorFactory via dependency injection
3. **VarPool is real** — mock executors write to actual VarPool via `pool.set()`/`pool.update()`
4. **Logic nodes are real** — ConditionExecutor, LoopExecutor run for real
5. **Variable substitution in mock outputs** — resolved at execution time via `substituteVars()`
6. **Strict mode** — all side-effect nodes must have mock definitions
7. **Per-iteration loop mocks** — array index maps to iteration number

## Three-Layer Execution

```
Phase 0: Parse workflow.yaml + workflow.test.yaml
Phase 1: Syntax pre-check (bash -n / python compile)
Phase 2: Simulation (mock side-effects, real logic)
Phase 3: Assertions (status, vars, trace, outputs, logs)
```

## Dependencies

- `@octopus/shared`: VarPool, evaluateExpression, substituteVars, Zod schemas
- `@octopus/engine`: WorkflowEngine, ExecutorFactory, ConditionExecutor, LoopExecutor
- `js-yaml`: YAML parsing for test fixtures
- `vitest`: Test framework

## Test Coverage Target: ≥ 90%
