import type { StepExecution } from "@/lib/types"

/**
 * Determine executor type from step data + node type from YAML.
 * Used by the detail panel to decide which tabs to show.
 *
 * IMPORTANT: nodeType-based checks must come BEFORE the step.model check
 * to prevent misclassification (e.g., octopus_agent has a model but is NOT a generic agent).
 */
export function getExecutorType(
  step: StepExecution | undefined,
  nodeType?: string,
): string | undefined {
  if (!step) return undefined
  if (nodeType === "swarm") return "swarm"
  if (nodeType === "interaction") return "interaction"
  if (nodeType === "sub_workflow") return "sub_workflow"
  if (nodeType === "octopus_agent") return "octopus_agent"
  if (step.model) return "agent"
  const name = step.stepName?.toLowerCase() ?? ""
  if (name.includes("bash")) return "bash"
  if (name.includes("python")) return "python"
  if (name.includes("condition")) return "condition"
  if (name.includes("approval")) return "approval"
  if (name.includes("loop")) return "loop"
  return undefined
}
