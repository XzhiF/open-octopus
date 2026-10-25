import type Database from "better-sqlite3"
import { expertName } from "@octopus/shared"
import { resolveExpertSubagents } from "../agent/expert-registry"

/**
 * Per-phase fixed experts as an execution prompt prefix.
 *
 * Workflow agent nodes are executed by the ENGINE's AgentExecutor (not the
 * server scheduler one), and each node is a fresh provider session. We inject
 * the phase roster into the node's goal/prompt at engine construction time;
 * there is no cross-node cache to preserve, so a prompt prefix is safe.
 */
export function buildPhaseExpertContext(
  db: Database.Database,
  taskId: string,
  phaseIndex: number,
): string {
  try {
    const row = db
      .prepare("SELECT task_spec FROM tasks WHERE id = ?")
      .get(taskId) as { task_spec?: string } | undefined
    if (!row?.task_spec) return ""
    const spec = JSON.parse(row.task_spec) as {
      phases?: Array<{ index?: number; experts?: string[] }>
    }
    const phase = spec.phases?.find((p) => p.index === phaseIndex)
    const experts = (phase?.experts ?? []).filter((id): id is string => !!id)
    if (experts.length === 0) return ""
    const defs = resolveExpertSubagents(experts.map((id) => ({ id })))
    if (!defs) return ""

    const blocks: string[] = []
    let budget = 8_000
    for (const id of experts) {
      const def = defs[id]
      if (!def || budget <= 0) continue
      const body = String(def.prompt ?? "").slice(0, 2_000)
      budget -= body.length + 200
      blocks.push(`### ${expertName(id)}\n${body}`)
    }
    if (blocks.length === 0) return ""
    return [
      "## 当前阶段固定专家（任务规格锁定）",
      "本阶段由以下专家协作；以该阶段专家的视角与方法论推进，不要越权到其他阶段。",
      "",
      blocks.join("\n\n"),
    ].join("\n")
  } catch {
    return ""
  }
}

/**
 * Prepends the expert context to every agent node's goal/prompt. Returns a new
 * workflow object (node-level clone) so the shared parsed workflow is untouched.
 */
export function injectPhaseExpertContext<T extends { nodes?: any[] }>(
  workflow: T,
  context: string,
): T {
  const prefix = context.trim()
  if (!prefix) return workflow

  const inject = (node: any) => {
    if (node?.type === "agent") {
      if (typeof node.goal === "string" && node.goal.trim()) {
        node.goal = `${prefix}\n\n---\n\n${node.goal}`
      } else if (typeof node.prompt === "string" && node.prompt.trim()) {
        node.prompt = `${prefix}\n\n---\n\n${node.prompt}`
      }
    }
    if (Array.isArray(node?.nodes)) node.nodes.forEach(inject)
    if (Array.isArray(node?.body)) node.body.forEach(inject)
    return node
  }

  const cloneNode = (node: any): any => {
    const copy = JSON.parse(JSON.stringify(node))
    inject(copy)
    return copy
  }

  return {
    ...workflow,
    nodes: Array.isArray(workflow.nodes) ? workflow.nodes.map(cloneNode) : workflow.nodes,
  }
}
