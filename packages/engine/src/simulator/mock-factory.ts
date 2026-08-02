// packages/engine/src/simulator/mock-factory.ts
//
// SimulatorExecutorFactory — returns mock executors for side-effect nodes
// and real executors for logic nodes. Supports opt-in real execution
// for specific bash/python nodes.

import type { NodeDef } from "@octopus/shared"
import { VarPool } from "@octopus/shared"
import type { NodeExecutor, NodeExecutionResult } from "../executors/types"
import { ConditionExecutor } from "../executors/condition"
import { BashExecutor } from "../executors/bash"
import { PythonExecutor } from "../executors/python"
import {
  MockAgentExecutor,
  MockSwarmExecutor,
  MockBashExecutor,
  MockPythonExecutor,
  MockApprovalExecutor,
  MockInteractionExecutor,
} from "./mock-executors"
import type { MockDef, LoopMockDef, ApprovalMockDef, InteractionMockDef } from "./types"

export interface MockFactoryOptions {
  /** Node IDs that should execute for real (bash/python only) */
  realExecution?: string[]
  /** If true, fail when a side-effect node has no mock definition */
  strict?: boolean
  /** AbortSignal for real executors */
  signal?: AbortSignal
  /** Log callback for real executors */
  onLog?: (line: string, stream?: "stdout" | "stderr") => void
  /** Working directory for real executors */
  cwd?: string
}

/**
 * Creates executors for the simulator.
 * Side-effect nodes (agent, swarm, bash, python, approval) use mock executors.
 * Logic nodes (condition, loop) use real executors.
 */
export class SimulatorExecutorFactory {
  constructor(
    private mocks: Record<string, MockDef>,
    private pool: VarPool,
    private nodeResults: Record<string, NodeExecutionResult>,
    private options: MockFactoryOptions = {},
  ) {}

  createExecutor(node: NodeDef): NodeExecutor {
    const { realExecution = [], strict = true } = this.options

    // Logic nodes always use real executors
    if (node.type === "condition") {
      return new ConditionExecutor(node, this.pool)
    }

    // Loop nodes are handled by the simulator engine (not here)
    if (node.type === "loop") {
      throw new Error(
        `Loop nodes should be handled by SimulatorEngine, not MockFactory. Node: ${node.id}`,
      )
    }

    // Check if this node should execute for real
    if (realExecution.includes(node.id)) {
      if (node.type === "bash") {
        return new BashExecutor(node, this.pool, {
          signal: this.options.signal,
          onLog: this.options.onLog,
          cwd: this.options.cwd,
        })
      }
      if (node.type === "python") {
        return new PythonExecutor(node, this.pool, {
          signal: this.options.signal,
          onLog: this.options.onLog,
        })
      }
      // Only bash/python can be executed for real
      throw new Error(
        `Only bash/python nodes can be marked for real execution. ` +
        `Node "${node.id}" is type "${node.type}".`,
      )
    }

    // Side-effect nodes use mock executors
    const mockDef = this.mocks[node.id]

    if (!mockDef) {
      if (strict) {
        throw new Error(
          `Strict mode: no mock definition found for side-effect node "${node.id}" (type: ${node.type}). ` +
          `Add a mock definition in the test fixture or use --no-strict.`,
        )
      }
      // Non-strict mode: auto-pass with empty output
      return this.createAutoPassExecutor(node)
    }

    return this.createMockExecutor(node, mockDef)
  }

  private createMockExecutor(node: NodeDef, mockDef: MockDef): NodeExecutor {
    switch (node.type) {
      case "agent":
        return new MockAgentExecutor(node, this.pool, mockDef as any)
      case "swarm":
        return new MockSwarmExecutor(node, this.pool, mockDef as any)
      case "bash":
        return new MockBashExecutor(node, this.pool, mockDef as any)
      case "python":
        return new MockPythonExecutor(node, this.pool, mockDef as any)
      case "approval":
        return new MockApprovalExecutor(node, this.pool, mockDef as ApprovalMockDef)
      case "interaction":
        return new MockInteractionExecutor(node, this.pool, mockDef as InteractionMockDef)
      default:
        throw new Error(`Unknown node type: ${node.type}`)
    }
  }

  private createAutoPassExecutor(node: NodeDef): NodeExecutor {
    return {
      execute: async (): Promise<NodeExecutionResult> => ({
        outputs: {},
        status: "completed",
        durationMs: 0,
        logLines: [`[simulator] auto-passed (no mock in non-strict mode)`],
      }),
    }
  }

  /**
   * Get the mock definition for a node, if it exists.
   */
  getMockDef(nodeId: string): MockDef | undefined {
    return this.mocks[nodeId]
  }

  /**
   * Get the loop mock definition for a node, if it exists.
   */
  getLoopMockDef(nodeId: string): LoopMockDef | undefined {
    const def = this.mocks[nodeId]
    if (!def) return undefined
    if ("nodes" in def && typeof (def as any).nodes === "object") {
      return def as LoopMockDef
    }
    return undefined
  }
}
