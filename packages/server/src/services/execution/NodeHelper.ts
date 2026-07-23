// packages/server/src/services/execution/NodeHelper.ts
//
// Pure utility functions for node traversal and lookup.
// No class needed — these are stateless operations on node arrays and DAO queries.
//
import type { ExecutionDAO } from "../../db/dao/execution-dao"
import { randomUUID } from "crypto"

/** Recursively collect all nodes (including nested) from a workflow node array. */
export function collectAllNodes(
  nodes: { id: string; type: string; nodes?: any[] }[],
): { id: string; type: string }[] {
  const result: { id: string; type: string }[] = []
  for (const node of nodes) {
    result.push({ id: node.id, type: node.type })
    if (node.nodes) result.push(...collectAllNodes(node.nodes))
  }
  return result
}

/** Find a node definition by ID in a (possibly nested) node array. */
export function findNodeDef(nodes: any[], nodeId: string): any | null {
  for (const node of nodes) {
    if (node.id === nodeId) return node
    if (node.nodes) {
      const found = findNodeDef(node.nodes, nodeId)
      if (found) return found
    }
  }
  return null
}

/** Find the first paused node's ID for an execution. */
export function findPausedNode(dao: ExecutionDAO, executionId: string): string | null {
  const row = dao.findFirstNodeByStatus(executionId, "paused")
  return row?.node_id ?? null
}

/** Find the first failed node's ID for an execution. */
export function findFailedNode(dao: ExecutionDAO, executionId: string): string {
  const row = dao.findFirstNodeByStatus(executionId, "failed")
  return row?.node_id ?? "unknown"
}

/** Find the error message of the first failed node. */
export function findFailedNodeError(dao: ExecutionDAO, executionId: string): string {
  const row = dao.findFirstNodeErrorByStatus(executionId, "failed")
  return row?.error ?? "Unknown error"
}

/** Check if a given nodeId exists in the workflow definition. */
export function isWorkflowNodeId(
  getWorkflow: (ref: string) => { parsed: any } | undefined,
  workflowRef: string, nodeId: string,
): boolean {
  const wf = getWorkflow(workflowRef)
  if (!wf) return false
  const allNodeIds = collectAllNodes(wf.parsed.nodes).map(n => n.id)
  return allNodeIds.includes(nodeId)
}

/** Ensure all workflow nodes have corresponding node_execution rows. */
export function ensureNodeExecutions(
  dao: ExecutionDAO, executionId: string, wf: { nodes: any[] },
): void {
  for (const node of collectAllNodes(wf.nodes)) {
    dao.insertNodeExecutionOrIgnore({
      id: `${executionId}-${node.id}`, execution_id: executionId,
      node_id: node.id, node_type: node.type, status: "pending",
    })
  }
}

/** Ensure all dependency and condition edges are recorded. */
export function ensureNodeEdges(
  dao: ExecutionDAO,
  executionId: string,
  wf: { nodes: { id: string; type: string; depends_on?: string[]; cases?: { when: string; then: string }[] }[] },
): void {
  for (const node of wf.nodes) {
    if (node.depends_on) {
      for (const dep of node.depends_on) {
        dao.insertNodeEdgeOrIgnore({
          id: randomUUID(), execution_id: executionId,
          from_node_id: dep, to_node_id: node.id, edge_type: "dependency",
        })
      }
    }
    if (node.type === "condition" && node.cases) {
      for (const c of node.cases) {
        dao.insertNodeEdgeOrIgnore({
          id: randomUUID(), execution_id: executionId,
          from_node_id: node.id, to_node_id: c.then, edge_type: "condition_true", label: c.then,
        })
      }
    }
  }
}
