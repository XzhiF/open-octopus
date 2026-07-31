// packages/engine/src/simulator/types.ts
//
// Core type definitions for the workflow simulator.
// Test fixtures, mock definitions, assertion definitions, and simulation results.

import type { NodeExecutionResult } from "../executors/types"

// ── Mock Definitions (per node type) ─────────────────────────

export interface BaseMockDef {
  status?: "completed" | "failed"
  output?: string
  outputs?: Record<string, any>
  update_vars?: Record<string, any>
  error?: string
}

export interface AgentMockDef extends BaseMockDef {}

export interface SwarmMockDef extends BaseMockDef {}

export interface BashMockDef extends BaseMockDef {
  exit_code?: number
}

export interface PythonMockDef extends BaseMockDef {
  exit_code?: number
}

export interface ApprovalMockDef {
  choice: string
  comment?: string
}

export interface InteractionMockDef {
  summary: string
  rounds?: number
  vars_update?: Record<string, any>
  outputs?: Record<string, any>
}

/** Loop mock: contains inner node mocks, supports per-iteration arrays. */
export interface LoopMockDef {
  iterations?: number
  nodes: Record<string, MockDef | MockDef[]>
}

/** Union of all mock definition types. */
export type MockDef =
  | AgentMockDef
  | SwarmMockDef
  | BashMockDef
  | PythonMockDef
  | ApprovalMockDef
  | InteractionMockDef
  | LoopMockDef

// ── Assertion Definitions ────────────────────────────────────

export interface NodeTraceAssertion {
  executed?: string[]
  skipped?: string[]
  order?: string[]
}

export interface NodeOutputAssertion {
  output?: string
  outputs?: Record<string, any>
  status?: string
}

export interface LogAssertion {
  contains?: string[]
  not_contains?: string[]
}

export interface AssertionDef {
  status?: "completed" | "failed" | "completed_with_failures" | "paused" | "cancelled"
  vars?: Record<string, any>
  node_trace?: NodeTraceAssertion
  node_outputs?: Record<string, NodeOutputAssertion>
  logs?: Record<string, LogAssertion>
}

// ── Test Scenario & Fixture ───────────────────────────────────

export interface TestScenario {
  name: string
  inputs?: Record<string, string>
  mocks: Record<string, MockDef>
  real_execution?: string[]
  assertions: AssertionDef
}

export interface TestFixture {
  scenarios: TestScenario[]
}

// ── Simulation Results ────────────────────────────────────────

export interface AssertionResult {
  name: string
  passed: boolean
  expected?: any
  actual?: any
  message?: string
}

export interface AssertionReport {
  passed: boolean
  results: AssertionResult[]
}

export interface NodeExecutionEntry {
  nodeId: string
  nodeType: string
  status: string
  durationMs: number
  mocked: boolean
  logLines: string[]
}

export interface SimResult {
  scenarioName: string
  passed: boolean
  durationMs: number
  status: string
  nodeResults: Record<string, NodeExecutionResult>
  poolSnapshot: Record<string, any>
  executionTrace: NodeExecutionEntry[]
  assertionReport: AssertionReport
  syntaxErrors?: SyntaxError[]
  error?: string
}

export interface SyntaxError {
  nodeId: string
  nodeType: "bash" | "python"
  script: string
  error: string
  line?: number
}

// ── Simulator Options ─────────────────────────────────────────

export interface SimulatorOptions {
  strict?: boolean
  verbose?: boolean
  realExecution?: string[]
  scenarioFilter?: string
}
