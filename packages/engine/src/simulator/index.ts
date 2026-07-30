// packages/engine/src/simulator/index.ts
//
// Public exports for the workflow simulator module.

// Types
export type {
  TestFixture,
  TestScenario,
  MockDef,
  AgentMockDef,
  SwarmMockDef,
  BashMockDef,
  PythonMockDef,
  ApprovalMockDef,
  LoopMockDef,
  AssertionDef,
  NodeTraceAssertion,
  NodeOutputAssertion,
  LogAssertion,
  SimResult,
  AssertionReport,
  AssertionResult,
  NodeExecutionEntry,
  SyntaxError,
  SimulatorOptions,
} from "./types"

// Assertion engine
export { runAssertions } from "./assertions"

// Syntax checker
export { checkSyntax } from "./syntax-checker"
export type { SyntaxCheckResult } from "./syntax-checker"

// Mock executors
export {
  MockAgentExecutor,
  MockSwarmExecutor,
  MockBashExecutor,
  MockPythonExecutor,
  MockApprovalExecutor,
} from "./mock-executors"

// Mock factory
export { SimulatorExecutorFactory } from "./mock-factory"
export type { MockFactoryOptions } from "./mock-factory"

// Simulator engine
export { simulateScenario } from "./simulator-engine"

// Test runner
export {
  runTestSuite,
  loadTestFixture,
  loadWorkflow,
  discoverTestFixture,
} from "./test-runner"
export type { TestRunnerResult } from "./test-runner"
