import type { WorkflowInfo } from "../../types/workflow-api"

/**
 * Main-chat workflow discovery is release-only (workflow versioning, 2026-11):
 * snapshots are dev/in-progress definitions and must not leak into the chat
 * agent's tool list. Workspace workflows without `stage: release` are snapshots
 * too (fail-closed).
 */
export type ChatWorkflowInfo = WorkflowInfo & { scope: "workspace" | "built-in" }

export function selectReleasedWorkflows(
  local: WorkflowInfo[],
  builtIn: WorkflowInfo[],
): ChatWorkflowInfo[] {
  return [
    ...local.filter((w) => w.stage === "release").map((w) => ({ ...w, scope: "workspace" as const })),
    ...builtIn.filter((w) => w.stage === "release").map((w) => ({ ...w, scope: "built-in" as const })),
  ]
}
