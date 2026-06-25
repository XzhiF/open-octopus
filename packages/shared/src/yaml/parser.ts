import yaml from "js-yaml"
import { WorkflowSchema, type WorkflowDef, type NodeDef } from "../types/workflow"

export class ValueError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ValueError"
  }
}

export function parseWorkflow(yamlDictOrString: string | Record<string, unknown>): WorkflowDef {
  const raw = typeof yamlDictOrString === "string"
    ? yaml.load(yamlDictOrString, { schema: yaml.JSON_SCHEMA }) as Record<string, unknown>
    : yamlDictOrString

  const result = WorkflowSchema.safeParse(raw)
  if (!result.success) {
    const issues = result.error.issues
    const first = issues[0]
    const path = first.path.join(".") || "root"
    const msg = first.message === "Required" ? `${path} is required` : `${path}: ${first.message}`
    throw new ValueError(msg)
  }

  const wf = result.data

  // Semantic validation for agents: either prompt or agent_file required
  for (const node of wf.nodes) {
    _validateAgentPromptOrFile(node)
    _validateGoalPromptExclusion(node)
  }

  return wf
}

function _validateAgentPromptOrFile(node: NodeDef): void {
  if (node.agents) {
    for (const [name, def] of Object.entries(node.agents)) {
      if (!def.prompt && !def.agent_file) {
        throw new ValueError(`node "${node.id}": agents.${name}.prompt or agent_file is required`)
      }
    }
  }
  if (node.nodes) {
    for (const inner of node.nodes) {
      _validateAgentPromptOrFile(inner)
    }
  }
}

function _validateGoalPromptExclusion(node: NodeDef): void {
  if (node.goal && node.prompt) {
    throw new ValueError(`node "${node.id}": "goal" and "prompt" are mutually exclusive — use one or the other`)
  }
  // constraints and planning only work with goal mode
  if (!node.goal) {
    if (node.constraints?.length) {
      throw new ValueError(`node "${node.id}": "constraints" requires "goal" mode — they are ignored in "prompt" mode`)
    }
    if (node.planning) {
      throw new ValueError(`node "${node.id}": "planning" requires "goal" mode — it is ignored in "prompt" mode`)
    }
  }
  if (node.nodes) {
    for (const inner of node.nodes) {
      _validateGoalPromptExclusion(inner)
    }
  }
}

export function isOctopusWorkflow(yamlDictOrString: string | Record<string, unknown>): boolean {
  try {
    const raw = typeof yamlDictOrString === "string"
      ? yaml.load(yamlDictOrString, { schema: yaml.JSON_SCHEMA }) as Record<string, unknown>
      : yamlDictOrString
    return typeof raw.apiVersion === "string"
      && raw.apiVersion.startsWith("octopus/")
      && raw.kind === "Workflow"
  } catch {
    return false
  }
}

export function validateWorkflow(wf: WorkflowDef): void {
  const ids = _collectIds(wf.nodes)
  const seen = new Set<string>()
  for (const id of ids) {
    if (seen.has(id)) {
      throw new ValueError(`duplicate id: "${id}"`)
    }
    seen.add(id)
  }

  for (const node of wf.nodes) {
    _validateNode(node)
  }
}

function _collectIds(nodes: NodeDef[]): string[] {
  const ids: string[] = []
  for (const node of nodes) {
    ids.push(node.id)
    if (node.nodes) {
      ids.push(..._collectIds(node.nodes))
    }
  }
  return ids
}

function _validateNode(node: NodeDef): void {
  switch (node.type) {
    case "bash":
      if (!node.bash) {
        throw new ValueError(`node "${node.id}": bash content required`)
      }
      break
    case "python":
      if (!node.python) {
        throw new ValueError(`node "${node.id}": python content required`)
      }
      break
    case "agent":
      if (!node.agent && !node.prompt && !node.goal && !node.agents) {
        throw new ValueError(`node "${node.id}": agent name, prompt, goal, or agents required`)
      }
      if (node.agents) {
        for (const [name, def] of Object.entries(node.agents)) {
          if (!def.description) {
            throw new ValueError(`node "${node.id}": agents.${name}.description is required`)
          }
          if (!def.prompt && !def.agent_file) {
            throw new ValueError(`node "${node.id}": agents.${name}.prompt or agent_file is required`)
          }
        }
      }
      break
    case "condition":
      if (!node.cases || node.cases.length === 0) {
        throw new ValueError(`node "${node.id}": cases required`)
      }
      break
    case "loop":
      if (!node.max_iterations) {
        throw new ValueError(`node "${node.id}": max_iterations required`)
      }
      if (node.nodes) {
        for (const inner of node.nodes) {
          _validateNode(inner)
        }
      }
      break
    case "approval":
      break
    case "swarm":
      if (!node.mode && !node.topic) {
        throw new ValueError(`node "${node.id}": swarm node requires mode or topic`)
      }
      if (
        (node.mode === "debate" || node.mode === "swarm") &&
        node.host?.prompt &&
        !node.host.prompt.toLowerCase().includes("assessment")
      ) {
        throw new ValueError(
          `node "${node.id}": debate/swarm mode with custom host.prompt must include "assessment" JSON output ` +
          `(consensus_score, should_continue). Without it, consensus detection is silently disabled and ` +
          `the debate will always run all ${node.rounds ?? 3} rounds. ` +
          `Add an "assessment" block to host.prompt or remove host.prompt to use the built-in template.`,
        )
      }
      break
  }
}