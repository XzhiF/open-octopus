// packages/engine/src/simulator/simulator-engine.ts
//
// Core simulation orchestrator. Runs a workflow with mock executors
// for side-effect nodes and real executors for logic nodes.
// Reuses graph-utils for DAG ordering but implements its own
// execution loop to avoid needing real providers.

import type { NodeDef, WorkflowDef } from "@octopus/shared"
import { VarPool, evaluateExpression, substituteVars } from "@octopus/shared"
import type { NodeExecutionResult } from "../executors/types"
import { ConditionExecutor } from "../executors/condition"
import { topologicalSort } from "../graph-utils"
import { SimulatorExecutorFactory } from "./mock-factory"
import {
  MockAgentExecutor,
  MockSwarmExecutor,
  MockBashExecutor,
  MockPythonExecutor,
  MockApprovalExecutor,
} from "./mock-executors"
import type {
  TestScenario,
  SimResult,
  NodeExecutionEntry,
  MockDef,
  LoopMockDef,
  ApprovalMockDef,
  SimulatorOptions,
} from "./types"

/**
 * Run a single scenario against a workflow definition.
 * Returns a complete SimResult with node results, pool snapshot, and execution trace.
 */
export async function simulateScenario(
  workflow: WorkflowDef,
  scenario: TestScenario,
  options: SimulatorOptions = {},
): Promise<SimResult> {
  const start = Date.now()
  const { strict = true } = options

  // Create fresh VarPool for this scenario
  const pool = new VarPool(workflow.variables ?? {})

  // Apply scenario inputs
  if (scenario.inputs) {
    pool.update(scenario.inputs)
  }

  // Track node results and execution trace
  const nodeResults: Record<string, NodeExecutionResult> = {}
  const executionTrace: NodeExecutionEntry[] = []

  // Create the mock factory
  const factory = new SimulatorExecutorFactory(
    scenario.mocks,
    pool,
    nodeResults,
    { realExecution: scenario.real_execution ?? options.realExecution, strict },
  )

  // Topological sort
  let sorted: NodeDef[]
  try {
    sorted = topologicalSort(workflow.nodes)
  } catch (err) {
    return {
      scenarioName: scenario.name,
      passed: false,
      durationMs: Date.now() - start,
      status: "failed",
      nodeResults: {},
      poolSnapshot: pool.snapshot(),
      executionTrace: [],
      assertionReport: { passed: false, results: [] },
      error: `Failed to sort workflow nodes: ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  // Execute nodes sequentially
  let workflowStatus: "completed" | "failed" | "completed_with_failures" = "completed"

  for (let i = 0; i < sorted.length; i++) {
    const node = sorted[i]

    // Skip nodes that already have terminal results
    const existingResult = nodeResults[node.id]
    if (existingResult && isTerminalStatus(existingResult.status)) {
      continue
    }

    // Check dependency skips
    if (node.depends_on?.length) {
      const hasSkippedDep = node.depends_on.some((depId) => {
        const depResult = nodeResults[depId]
        if (!depResult) return false
        if (depResult.skippedByCondition) return false
        return ["skipped", "skipped_failed", "rejected", "cancelled", "failed"].includes(depResult.status)
      })
      if (hasSkippedDep) {
        nodeResults[node.id] = {
          outputs: {},
          status: "skipped",
          durationMs: 0,
          logLines: [`Skipped: dependency was skipped/rejected/cancelled/failed`],
        }
        executionTrace.push(makeTraceEntry(node, "skipped", nodeResults[node.id]))
        continue
      }
    }

    // Check execute_when
    if (node.execute_when) {
      const nodeOutputs: Record<string, Record<string, any>> = {}
      for (const [id, result] of Object.entries(nodeResults)) {
        nodeOutputs[id] = result.outputs ?? {}
      }
      const shouldRun = evaluateExpression(node.execute_when, pool, nodeOutputs)
      if (!shouldRun) {
        nodeResults[node.id] = {
          outputs: {},
          status: "skipped",
          durationMs: 0,
          logLines: [`Skipped: execute_when "${node.execute_when}" evaluated false`],
          skippedByCondition: true,
        }
        executionTrace.push(makeTraceEntry(node, "skipped", nodeResults[node.id]))
        continue
      }
    }

    // Execute the node
    let nodeResult: NodeExecutionResult
    try {
      if (node.type === "loop") {
        nodeResult = await executeLoopNode(node, pool, nodeResults, factory, scenario.mocks, executionTrace)
      } else if (node.type === "condition") {
        const executor = new ConditionExecutor(node, pool)
        nodeResult = await executor.execute()
      } else {
        const executor = factory.createExecutor(node)
        nodeResult = await executor.execute()
      }
    } catch (err: unknown) {
      nodeResult = {
        outputs: {},
        status: "failed",
        durationMs: 0,
        logLines: [`Execution error: ${err instanceof Error ? err.message : String(err)}`],
        error: err instanceof Error ? err.message : String(err),
      }
    }

    nodeResults[node.id] = nodeResult
    executionTrace.push(makeTraceEntry(node, nodeResult.status, nodeResult))

    // Apply node outputs mapping to VarPool
    if (node.outputs && nodeResult.status === "completed") {
      applyNodeOutputsMapping(node, nodeResult, pool, nodeResults)
    }

    // Handle condition jumpTo
    if (node.type === "condition" && nodeResult.jumpTo) {
      const jumpTarget = nodeResult.jumpTo

      // Skip non-target nodes that depend directly on this condition node
      for (const otherNode of sorted) {
        if (otherNode.id === node.id || otherNode.id === jumpTarget) continue
        if (nodeResults[otherNode.id]) continue
        if (otherNode.depends_on?.includes(node.id)) {
          nodeResults[otherNode.id] = {
            outputs: {},
            status: "skipped",
            durationMs: 0,
            logLines: [`Skipped: condition "${node.id}" jumped to "${jumpTarget}"`],
            skippedByCondition: true,
          }
          executionTrace.push(makeTraceEntry(otherNode, "skipped", nodeResults[otherNode.id]))
        }
      }

      // Skip all nodes between condition and jump target
      const jumpIdx = sorted.findIndex((n) => n.id === jumpTarget)
      if (jumpIdx > i) {
        for (let j = i + 1; j < jumpIdx; j++) {
          const skippedNode = sorted[j]
          if (!nodeResults[skippedNode.id]) {
            nodeResults[skippedNode.id] = {
              outputs: {},
              status: "skipped",
              durationMs: 0,
              logLines: [`Skipped: condition jump to "${jumpTarget}"`],
            }
            executionTrace.push(makeTraceEntry(skippedNode, "skipped", nodeResults[skippedNode.id]))
          }
        }
        i = jumpIdx - 1
        continue
      }
    }

    // Handle failure — mark remaining nodes as skipped
    if (nodeResult.status === "failed") {
      workflowStatus = "failed"
      for (let j = i + 1; j < sorted.length; j++) {
        const remainingNode = sorted[j]
        if (!nodeResults[remainingNode.id]) {
          nodeResults[remainingNode.id] = {
            outputs: {},
            status: "skipped",
            durationMs: 0,
            logLines: [`Skipped: upstream "${node.id}" failed`],
          }
          executionTrace.push(makeTraceEntry(remainingNode, "skipped", nodeResults[remainingNode.id]))
        }
      }
      break
    }
  }

  return {
    scenarioName: scenario.name,
    passed: true, // Will be set by assertion check
    durationMs: Date.now() - start,
    status: workflowStatus,
    nodeResults,
    poolSnapshot: pool.snapshot(),
    executionTrace,
    assertionReport: { passed: true, results: [] },
  }
}

// ── Loop Node Execution ───────────────────────────────────────

async function executeLoopNode(
  loopNode: NodeDef,
  pool: VarPool,
  nodeResults: Record<string, NodeExecutionResult>,
  factory: SimulatorExecutorFactory,
  mocks: Record<string, MockDef>,
  executionTrace: NodeExecutionEntry[],
): Promise<NodeExecutionResult> {
  const start = Date.now()
  const maxIterations = loopNode.max_iterations ?? 100
  const innerNodes = loopNode.nodes ?? []
  const loopMockDef = factory.getLoopMockDef(loopNode.id)
  const logLines: string[] = []

  let iterations = 0

  for (let iter = 0; iter < maxIterations; iter++) {
    // Check while condition
    if (loopNode.while) {
      const nodeOutputs: Record<string, Record<string, any>> = {}
      for (const [id, result] of Object.entries(nodeResults)) {
        nodeOutputs[id] = result.outputs ?? {}
      }
      const shouldContinue = evaluateExpression(
        loopNode.while,
        pool,
        nodeOutputs,
        undefined,
        { iteration: iter },
      )
      if (!shouldContinue) break
    }

    // Check break_when
    if (loopNode.break_when) {
      const nodeOutputs: Record<string, Record<string, any>> = {}
      for (const [id, result] of Object.entries(nodeResults)) {
        nodeOutputs[id] = result.outputs ?? {}
      }
      const shouldBreak = evaluateExpression(
        loopNode.break_when,
        pool,
        nodeOutputs,
        undefined,
        { iteration: iter },
      )
      if (shouldBreak) break
    }

    iterations = iter + 1
    logLines.push(`[simulator] loop iteration ${iter}`)

    // Execute inner nodes
    const innerSorted = topologicalSort(innerNodes)
    for (const innerNode of innerSorted) {
      const innerResult = await executeInnerNode(
        innerNode,
        pool,
        nodeResults,
        factory,
        loopMockDef,
        iter,
        mocks,
      )
      // Track inner node result for this iteration
      const innerKey = `${loopNode.id}.${innerNode.id}.iter${iter}`
      nodeResults[innerKey] = innerResult

      if (innerResult.status === "failed") {
        return {
          outputs: {},
          status: "failed",
          durationMs: Date.now() - start,
          logLines: [...logLines, `Inner node "${innerNode.id}" failed at iteration ${iter}`],
          iterations,
          error: `Inner node "${innerNode.id}" failed`,
        }
      }
    }

    // Set iteration counter in pool
    pool.set("iteration", iter + 1)
  }

  return {
    outputs: { iterations },
    status: "completed",
    durationMs: Date.now() - start,
    logLines: [...logLines, `[simulator] loop completed: ${iterations} iterations`],
    iterations,
  }
}

async function executeInnerNode(
  node: NodeDef,
  pool: VarPool,
  nodeResults: Record<string, NodeExecutionResult>,
  factory: SimulatorExecutorFactory,
  loopMockDef: LoopMockDef | undefined,
  iteration: number,
  allMocks: Record<string, MockDef>,
): Promise<NodeExecutionResult> {
  // Logic nodes inside loops still execute for real
  if (node.type === "condition") {
    return new ConditionExecutor(node, pool).execute()
  }

  // Find mock for this inner node
  const innerMock = loopMockDef?.nodes?.[node.id]
  if (!innerMock) {
    // Try to find in top-level mocks (some workflows put inner mocks at top level)
    const topLevelMock = allMocks[node.id]
    if (topLevelMock) {
      return createAndExecuteMock(node, pool, topLevelMock)
    }
    // Auto-pass if no mock found
    return {
      outputs: {},
      status: "completed",
      durationMs: 0,
      logLines: [`[simulator] inner node auto-passed (no mock)`],
    }
  }

  // Per-iteration array mock
  if (Array.isArray(innerMock)) {
    // Use array index = iteration number; fallback to last element
    const idx = Math.min(iteration, innerMock.length - 1)
    const iterMock = innerMock[idx]
    return createAndExecuteMock(node, pool, iterMock)
  }

  // Same mock for all iterations
  return createAndExecuteMock(node, pool, innerMock)
}

function createAndExecuteMock(
  node: NodeDef,
  pool: VarPool,
  mockDef: MockDef,
): Promise<NodeExecutionResult> {
  let executor: { execute(): Promise<NodeExecutionResult> }

  switch (node.type) {
    case "agent":
      executor = new MockAgentExecutor(node, pool, mockDef as any)
      break
    case "swarm":
      executor = new MockSwarmExecutor(node, pool, mockDef as any)
      break
    case "bash":
      executor = new MockBashExecutor(node, pool, mockDef as any)
      break
    case "python":
      executor = new MockPythonExecutor(node, pool, mockDef as any)
      break
    case "approval":
      executor = new MockApprovalExecutor(node, pool, mockDef as ApprovalMockDef)
      break
    default:
      return Promise.resolve({
        outputs: {},
        status: "completed",
        durationMs: 0,
        logLines: [`[simulator] auto-passed unknown type: ${node.type}`],
      })
  }

  return executor.execute()
}

// ── Helpers ───────────────────────────────────────────────────

function isTerminalStatus(status: string): boolean {
  return ["completed", "failed", "skipped", "skipped_failed", "rejected", "cancelled", "paused"].includes(status)
}

function makeTraceEntry(node: NodeDef, status: string, result: NodeExecutionResult): NodeExecutionEntry {
  return {
    nodeId: node.id,
    nodeType: node.type,
    status,
    durationMs: result.durationMs,
    mocked: node.type !== "condition" && node.type !== "loop",
    logLines: result.logLines,
  }
}

function applyNodeOutputsMapping(
  node: NodeDef,
  result: NodeExecutionResult,
  pool: VarPool,
  nodeResults: Record<string, NodeExecutionResult>,
): void {
  if (!node.outputs) return

  for (const [varName, expr] of Object.entries(node.outputs)) {
    const nodeOutputs: Record<string, Record<string, any>> = {}
    for (const [id, r] of Object.entries(nodeResults)) {
      const outputs = { ...(r.outputs ?? {}) }
      if (r.lastOutput !== undefined) outputs["output"] = r.lastOutput
      nodeOutputs[id] = outputs
    }

    if (expr === "$last_output") {
      pool.set(varName, result.lastOutput)
    } else {
      const resolved = substituteVars(expr, pool, nodeOutputs)
      pool.set(varName, resolved)
    }
  }
}
