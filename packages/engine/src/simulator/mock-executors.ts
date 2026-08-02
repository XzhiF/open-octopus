// packages/engine/src/simulator/mock-executors.ts
//
// Mock executor implementations for the workflow simulator.
// Each mock executor implements NodeExecutor and returns predefined results
// from the test fixture, performing variable substitution on mock outputs.

import type { NodeDef } from "@octopus/shared"
import { VarPool, substituteVars } from "@octopus/shared"
import type { NodeExecutor, NodeExecutionResult } from "../executors/types"
import type {
  AgentMockDef,
  SwarmMockDef,
  BashMockDef,
  PythonMockDef,
  ApprovalMockDef,
  InteractionMockDef,
} from "./types"

// ── Shared helper ─────────────────────────────────────────────

function resolveMockOutputs(
  def: { output?: string; outputs?: Record<string, any>; update_vars?: Record<string, any> },
  pool: VarPool,
): { lastOutput: string | undefined; outputs: Record<string, any>; logLines: string[] } {
  const logLines: string[] = []

  // Resolve variable substitution in output string
  let lastOutput: string | undefined = undefined
  if (def.output !== undefined) {
    lastOutput = substituteVars(def.output, pool)
    logLines.push(`[mock] output: ${lastOutput}`)
  }

  // Resolve outputs map
  const outputs: Record<string, any> = {}
  if (def.outputs) {
    for (const [key, val] of Object.entries(def.outputs)) {
      if (typeof val === "string") {
        outputs[key] = substituteVars(val, pool)
      } else {
        outputs[key] = val
      }
    }
  }

  // Write outputs to VarPool (mimicking real executor behavior)
  if (lastOutput !== undefined) {
    outputs["output"] = lastOutput
  }

  // Apply update_vars to VarPool
  if (def.update_vars) {
    for (const [key, val] of Object.entries(def.update_vars)) {
      const resolved = typeof val === "string" ? substituteVars(val, pool) : val
      pool.set(key, resolved)
      logLines.push(`[mock] update_vars: ${key} = ${JSON.stringify(resolved)}`)
    }
  }

  // Apply node outputs mapping to VarPool
  for (const [key, val] of Object.entries(outputs)) {
    if (key !== "output") {
      pool.set(key, val)
    }
  }

  return { lastOutput, outputs, logLines }
}

// ── MockAgentExecutor ─────────────────────────────────────────

export class MockAgentExecutor implements NodeExecutor {
  constructor(
    private node: NodeDef,
    private pool: VarPool,
    private mockDef: AgentMockDef,
  ) {}

  async execute(): Promise<NodeExecutionResult> {
    const start = Date.now()
    const { lastOutput, outputs, logLines } = resolveMockOutputs(this.mockDef, this.pool)

    if (this.mockDef.status === "failed") {
      return {
        lastOutput,
        outputs,
        status: "failed",
        durationMs: Date.now() - start,
        logLines: [...logLines, `[mock] agent failed: ${this.mockDef.error ?? "mock failure"}`],
        error: this.mockDef.error ?? "mock failure",
      }
    }

    return {
      lastOutput,
      outputs,
      status: "completed",
      durationMs: Date.now() - start,
      logLines: [...logLines, "[mock] agent completed"],
    }
  }
}

// ── MockSwarmExecutor ─────────────────────────────────────────

export class MockSwarmExecutor implements NodeExecutor {
  constructor(
    private node: NodeDef,
    private pool: VarPool,
    private mockDef: SwarmMockDef,
  ) {}

  async execute(): Promise<NodeExecutionResult> {
    const start = Date.now()
    const { lastOutput, outputs, logLines } = resolveMockOutputs(this.mockDef, this.pool)

    if (this.mockDef.status === "failed") {
      return {
        lastOutput,
        outputs,
        status: "failed",
        durationMs: Date.now() - start,
        logLines: [...logLines, `[mock] swarm failed: ${this.mockDef.error ?? "mock failure"}`],
        error: this.mockDef.error ?? "mock failure",
      }
    }

    return {
      lastOutput,
      outputs,
      status: "completed",
      durationMs: Date.now() - start,
      logLines: [...logLines, "[mock] swarm completed"],
    }
  }
}

// ── MockBashExecutor ──────────────────────────────────────────

export class MockBashExecutor implements NodeExecutor {
  constructor(
    private node: NodeDef,
    private pool: VarPool,
    private mockDef: BashMockDef,
  ) {}

  async execute(): Promise<NodeExecutionResult> {
    const start = Date.now()
    const { lastOutput, outputs, logLines } = resolveMockOutputs(this.mockDef, this.pool)

    const exitCode = this.mockDef.exit_code ?? (this.mockDef.status === "failed" ? 1 : 0)

    if (this.mockDef.status === "failed") {
      return {
        lastOutput,
        outputs,
        exitCode,
        status: "failed",
        durationMs: Date.now() - start,
        logLines: [...logLines, `[mock] bash failed (exit ${exitCode}): ${this.mockDef.error ?? "command failed"}`],
        error: this.mockDef.error ?? "command failed",
      }
    }

    return {
      lastOutput,
      outputs,
      exitCode,
      status: "completed",
      durationMs: Date.now() - start,
      logLines: [...logLines, `[mock] bash completed (exit 0)`],
    }
  }
}

// ── MockPythonExecutor ────────────────────────────────────────

export class MockPythonExecutor implements NodeExecutor {
  constructor(
    private node: NodeDef,
    private pool: VarPool,
    private mockDef: PythonMockDef,
  ) {}

  async execute(): Promise<NodeExecutionResult> {
    const start = Date.now()
    const { lastOutput, outputs, logLines } = resolveMockOutputs(this.mockDef, this.pool)

    const exitCode = this.mockDef.exit_code ?? (this.mockDef.status === "failed" ? 1 : 0)

    if (this.mockDef.status === "failed") {
      return {
        lastOutput,
        outputs,
        exitCode,
        status: "failed",
        durationMs: Date.now() - start,
        logLines: [...logLines, `[mock] python failed (exit ${exitCode}): ${this.mockDef.error ?? "script failed"}`],
        error: this.mockDef.error ?? "script failed",
      }
    }

    return {
      lastOutput,
      outputs,
      exitCode,
      status: "completed",
      durationMs: Date.now() - start,
      logLines: [...logLines, `[mock] python completed (exit 0)`],
    }
  }
}

// ── MockApprovalExecutor ──────────────────────────────────────

export class MockApprovalExecutor implements NodeExecutor {
  constructor(
    private node: NodeDef,
    private pool: VarPool,
    private mockDef: ApprovalMockDef,
  ) {}

  async execute(): Promise<NodeExecutionResult> {
    const start = Date.now()
    const logLines: string[] = [`[mock] approval choice: ${this.mockDef.choice}`]

    if (this.mockDef.comment) {
      logLines.push(`[mock] approval comment: ${this.mockDef.comment}`)
    }

    // Check if the choice matches a "reject" option
    const rejectValues = ["reject", "no", "deny", "abort"]
    const isRejected = rejectValues.includes(this.mockDef.choice.toLowerCase())

    if (isRejected) {
      return {
        lastOutput: this.mockDef.choice,
        outputs: { choice: this.mockDef.choice },
        status: "rejected",
        durationMs: Date.now() - start,
        logLines: [...logLines, "[mock] approval rejected"],
        decision: this.mockDef.choice,
        comment: this.mockDef.comment,
      }
    }

    // Write choice to VarPool
    this.pool.set("approval_choice", this.mockDef.choice)

    return {
      lastOutput: this.mockDef.choice,
      outputs: { choice: this.mockDef.choice },
      status: "completed",
      durationMs: Date.now() - start,
      logLines: [...logLines, "[mock] approval completed"],
      decision: this.mockDef.choice,
      comment: this.mockDef.comment,
    }
  }
}

// ── MockInteractionExecutor ────────────────────────────────────

export class MockInteractionExecutor implements NodeExecutor {
  constructor(
    private node: NodeDef,
    private pool: VarPool,
    private mockDef: InteractionMockDef,
  ) {}

  async execute(): Promise<NodeExecutionResult> {
    const start = Date.now()
    const logLines: string[] = [`[mock] interaction summary: ${this.mockDef.summary}`]

    if (this.mockDef.rounds !== undefined) {
      logLines.push(`[mock] interaction rounds: ${this.mockDef.rounds}`)
    }

    const outputs: Record<string, any> = {
      last_output: this.mockDef.summary,
      summary: this.mockDef.summary,
    }

    // Apply vars_update to VarPool
    if (this.mockDef.vars_update) {
      for (const [key, val] of Object.entries(this.mockDef.vars_update)) {
        const resolved = typeof val === "string" ? substituteVars(val, this.pool) : val
        this.pool.set(key, resolved)
        logLines.push(`[mock] interaction vars_update: ${key} = ${JSON.stringify(resolved)}`)
      }
      outputs.vars_update = this.mockDef.vars_update
    }

    // Apply outputs mapping
    if (this.mockDef.outputs) {
      for (const [key, val] of Object.entries(this.mockDef.outputs)) {
        if (typeof val === "string") {
          outputs[key] = substituteVars(val, this.pool)
        } else {
          outputs[key] = val
        }
      }
    }

    return {
      lastOutput: this.mockDef.summary,
      outputs,
      status: "completed",
      durationMs: Date.now() - start,
      logLines: [...logLines, "[mock] interaction completed"],
    }
  }
}
