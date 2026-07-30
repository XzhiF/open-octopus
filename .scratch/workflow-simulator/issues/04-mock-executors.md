# Ticket 4: Mock Executors

## Scope
- `packages/engine/src/simulator/mock-executors.ts`
- `packages/engine/src/__tests__/simulator/mock-executors.test.ts`

## Mock Executors
- MockAgentExecutor, MockSwarmExecutor, MockBashExecutor, MockPythonExecutor, MockApprovalExecutor
- Each implements NodeExecutor interface
- Variable substitution on mock outputs via substituteVars()
- VarPool writes via pool.set()/pool.update()

## Acceptance Criteria
- 11+ test cases from brief verification plan pass
