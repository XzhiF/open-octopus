// packages/engine/src/executors/octopus-agent.ts
//
// OctopusAgentExecutor — delegates tasks to versioned Octopus agents.
// Composition pattern: wraps AgentExecutor internally with added capabilities:
//   - Version resolution (via VersionResolver)
//   - Structured Task Contract prompt building
//   - Heartbeat event streaming
//   - Harness directive handling (abort/pause)
//   - Structured result parsing
//
// TODO (ticket #03): Full implementation. This is a compilation stub.
//

import type { NodeDef } from "@octopus/shared"
import type { NodeExecutionResult, NodeExecutor } from "./types"
import type { VarPool } from "@octopus/shared"

export interface OctopusAgentExecutorOptions {
  signal?: AbortSignal
  cwd: string
  executionId?: string
}

export class OctopusAgentExecutor implements NodeExecutor {
  constructor(
    private readonly node: NodeDef,
    private readonly pool: VarPool,
    private readonly options: OctopusAgentExecutorOptions,
  ) {}

  async execute(): Promise<NodeExecutionResult> {
    // TODO (ticket #03): Implement full octopus_agent execution flow:
    // 1. Resolve agent version via VersionResolver
    // 2. Create delegate session
    // 3. Build Task Contract prompt from node.task
    // 4. Setup Heartbeat handler
    // 5. Delegate to internal AgentExecutor
    // 6. Parse structured result
    // 7. Return NodeExecutionResult

    return {
      status: "failed",
      lastOutput: "OctopusAgentExecutor not yet implemented (ticket #03)",
      outputs: {},
      durationMs: 0,
      logLines: [],
      error: "OctopusAgentExecutor is a stub — full implementation in ticket #03",
    }
  }
}
