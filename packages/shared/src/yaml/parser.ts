import yaml from "js-yaml"
import { WorkflowSchema, type WorkflowDef, type NodeDef } from "../types/workflow"
import { parseTokenAmount } from "../parse-token-amount"

export class ValueError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ValueError"
  }
}

/**
 * Parse raw YAML string into a JavaScript object.
 * Uses js-yaml JSON_SCHEMA for safe parsing.
 */
export function parseYaml(content: string): unknown {
  return yaml.load(content, { schema: yaml.JSON_SCHEMA })
}

/**
 * Pre-process raw YAML to convert human-readable token strings ("50K", "1.5M")
 * into numbers for all budget-related fields. This runs BEFORE Zod validation
 * so the schemas can stay as plain z.number() without type inference issues.
 *
 * Handles:
 * - workflow-level budget.max_tokens
 * - swarm node budget / context_token_budget
 * - octopus_agent task.budget.max_tokens
 * - nested nodes (loop body, swarm experts, sub_workflow, etc.)
 */
function normalizeTokenAmounts(raw: unknown): unknown {
  if (raw == null || typeof raw !== "object") return raw

  if (Array.isArray(raw)) {
    return raw.map(normalizeTokenAmounts)
  }

  const obj = raw as Record<string, unknown>
  const result: Record<string, unknown> = { ...obj }

  // Convert string token amounts in known budget fields
  if (typeof result.budget === "string") {
    try { result.budget = parseTokenAmount(result.budget) } catch { /* let Zod reject */ }
  }
  if (typeof result.context_token_budget === "string") {
    try { result.context_token_budget = parseTokenAmount(result.context_token_budget) } catch { /* let Zod reject */ }
  }

  // Recurse into budget object's max_tokens
  if (result.budget && typeof result.budget === "object" && !Array.isArray(result.budget)) {
    const budget = result.budget as Record<string, unknown>
    if (typeof budget.max_tokens === "string") {
      try { budget.max_tokens = parseTokenAmount(budget.max_tokens) } catch { /* let Zod reject */ }
    }
  }

  // Recurse into nested structures
  if (Array.isArray(result.nodes)) result.nodes = result.nodes.map(normalizeTokenAmounts)
  if (Array.isArray(result.experts)) result.experts = result.experts.map(normalizeTokenAmounts)
  if (Array.isArray(result.expert_pool)) result.expert_pool = result.expert_pool.map(normalizeTokenAmounts)
  if (result.task && typeof result.task === "object") result.task = normalizeTokenAmounts(result.task)

  return result
}

/**
 * Migration guidance for the deprecated `planning:` block (goal-task-dev K4).
 */
const PLANNING_MIGRATION =
  "planning 已废弃: max_turns/max_budget_usd/disallowed_tools 提升为节点字段, verify 删除"

/**
 * Pre-Zod recursive raw scan for deprecated `planning` keys (walkthrough G).
 * Zod is non-strict and would silently strip `planning:` — old files must get an
 * explicit migration error instead. Walks the entire raw structure, so loop-nested
 * (and any other nested) nodes are covered too.
 */
function assertNoPlanningKey(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) assertNoPlanningKey(value[i], `${path}[${i}]`)
    return
  }
  if (value == null || typeof value !== "object") return

  const obj = value as Record<string, unknown>
  if ("planning" in obj) {
    const label = typeof obj.id === "string" ? `${path} (node "${obj.id}")` : path
    throw new ValueError(`${label}: ${PLANNING_MIGRATION}`)
  }
  for (const [key, child] of Object.entries(obj)) {
    assertNoPlanningKey(child, `${path}.${key}`)
  }
}

export function parseWorkflow(yamlDictOrString: string | Record<string, unknown>): WorkflowDef {
  const raw = typeof yamlDictOrString === "string"
    ? yaml.load(yamlDictOrString, { schema: yaml.JSON_SCHEMA }) as Record<string, unknown>
    : yamlDictOrString

  // Pre-Zod: `planning:` raises a migration ValueError, never a silent strip
  assertNoPlanningKey(raw, "root")

  // Pre-process: convert "50K"/"1.5M" strings to numbers in all budget fields
  const normalized = normalizeTokenAmounts(raw) as Record<string, unknown>

  const result = WorkflowSchema.safeParse(normalized)
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
  // constraints only work with goal mode
  // (`planning` deprecation is handled pre-Zod in parseWorkflow — see assertNoPlanningKey)
  if (!node.goal) {
    if (node.constraints?.length) {
      throw new ValueError(`node "${node.id}": "constraints" requires "goal" mode — they are ignored in "prompt" mode`)
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

/**
 * Node fields only honored by the claude engine (goal-task-dev K8).
 * Non-claude engines: validate warns, runtime silently ignores.
 */
const CLAUDE_ONLY_NODE_FIELDS = ["max_turns", "max_budget_usd", "tools", "disallowed_tools"] as const

export function validateWorkflow(wf: WorkflowDef): { warnings: string[] } {
  const ids = _collectIds(wf.nodes)
  const seen = new Set<string>()
  for (const id of ids) {
    if (seen.has(id)) {
      throw new ValueError(`duplicate id: "${id}"`)
    }
    seen.add(id)
  }

  const warnings: string[] = []
  for (const node of wf.nodes) {
    _validateNode(node)
    _collectEngineWarnings(node, wf, warnings)
  }
  return { warnings }
}

function _collectEngineWarnings(node: NodeDef, wf: WorkflowDef, warnings: string[]): void {
  // Same resolution chain as executor-factory (node.engine ?? workflow.engine ?? "claude");
  // "claude-code" is an alias of the claude provider there — no false-positive warning.
  const engine = node.engine ?? wf.engine ?? "claude"
  if (engine !== "claude" && engine !== "claude-code") {
    const used = CLAUDE_ONLY_NODE_FIELDS.filter((field) => node[field] !== undefined)
    if (used.length > 0) {
      warnings.push(
        `node "${node.id}": engine "${engine}" does not support claude-only fields (${used.join(", ")}) — they will be ignored at runtime`,
      )
    }
  }
  if (node.nodes) {
    for (const inner of node.nodes) {
      _collectEngineWarnings(inner, wf, warnings)
    }
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