/**
 * Shared test helpers for engine tests.
 *
 * Extracts duplicated utilities from:
 * - engine.test.ts (makeMockProvider, makeCompletedResult)
 * - integration.test.ts, hooks.test.ts, parallel.test.ts (makeMockProvider variants)
 * - engine-pipeline.test.ts (makeWorkflow, makePipelineConfig)
 */

import type { IAgentProvider } from "@octopus/providers"
import type { NodeExecutionResult } from "../executors/types"
import type { CoreConfig } from "../executors/executor-config"

// ============================================================
// Mock Provider
// ============================================================

/** Create a mock IAgentProvider that yields a simple text result. */
export function makeMockProvider(text = "mock agent result", sessionId = "sess-test"): IAgentProvider {
  return {
    getType: () => "claude",
    sendQuery: async function* () {
      yield { type: "message_start", messageId: "msg1" }
      yield { type: "text_delta", content: text, messageId: "msg1" }
      yield { type: "text_done", messageId: "msg1" }
      yield { type: "message_stop", messageId: "msg1" }
      yield { type: "result", content: text, sessionId }
    },
  }
}

/** Create a providers map with common engine keys. */
export function makeProviders(text?: string): Record<string, IAgentProvider> {
  return { claude: makeMockProvider(text) }
}

// ============================================================
// NodeExecutionResult helpers
// ============================================================

/** Create a completed NodeExecutionResult with sensible defaults. */
export function makeCompletedResult(overrides?: Partial<NodeExecutionResult>): NodeExecutionResult {
  return {
    status: "completed",
    outputs: {},
    durationMs: 10,
    logLines: [],
    ...overrides,
  }
}

/** Create a failed NodeExecutionResult. */
export function makeFailedResult(error: string, overrides?: Partial<NodeExecutionResult>): NodeExecutionResult {
  return {
    status: "failed",
    outputs: {},
    durationMs: 5,
    logLines: [error],
    error,
    ...overrides,
  }
}

// ============================================================
// Workflow helpers
// ============================================================

/** Create a minimal WorkflowDef with the given nodes. */
export function makeWorkflow(nodes: any[], name = "test-workflow"): any {
  return {
    apiVersion: "octopus/v1",
    kind: "Workflow",
    name,
    execution_mode: "serial" as const,
    nodes,
  }
}

// ============================================================
// Config helpers
// ============================================================

/** Create a minimal CoreConfig for testing. */
export function makeCoreConfig(overrides?: Partial<CoreConfig>): CoreConfig {
  return {
    providers: makeProviders(),
    cwd: "/tmp/test",
    ...overrides,
  }
}
