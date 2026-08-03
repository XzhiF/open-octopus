/**
 * E2E Harness — execution.mjs
 * Workflow execution management for E2E tests.
 *
 * @module execution
 * @status STABLE
 */

import { fetchJSON } from "./api.mjs"

/** Terminal execution statuses — polling stops when any of these is reached. */
const TERMINAL_STATUSES = new Set(["completed", "failed", "error", "cancelled"])

/**
 * Create an execution for a workflow.
 *
 * @param {string} workspaceId
 * @param {string} workflowRef - Workflow reference (e.g. "my-workflow.yaml")
 * @param {string} [name] - Optional execution name
 * @returns {Promise<{ id: string, status: string }>}
 */
export async function createExecution(workspaceId, workflowRef, name) {
  const body = {
    workflow_ref: workflowRef,
    name: name || `E2E_HARNESS_TEST_exec_${Date.now()}`,
  }

  const result = await fetchJSON(`/api/workspaces/${workspaceId}/executions`, {
    method: "POST",
    body: JSON.stringify(body),
  })

  if (!result.ok) {
    throw new Error(
      `createExecution failed: ${result.status} ${result.text || JSON.stringify(result.data)}`,
    )
  }

  return {
    id: result.data.id,
    status: result.data.status || "created",
  }
}

/**
 * Start an execution.
 *
 * @param {string} workspaceId
 * @param {string} executionId
 * @returns {Promise<boolean>} true if started (or already running)
 */
export async function startExecution(workspaceId, executionId) {
  const result = await fetchJSON(
    `/api/workspaces/${workspaceId}/executions/${executionId}/start`,
    { method: "POST" },
  )

  // 200 = started, 409 = already running (both count as success)
  return result.ok || result.status === 409
}

/**
 * Get execution details.
 *
 * @param {string} workspaceId
 * @param {string} executionId
 * @returns {Promise<any>} execution detail object
 */
export async function getExecution(workspaceId, executionId) {
  const result = await fetchJSON(
    `/api/workspaces/${workspaceId}/executions/${executionId}`,
  )

  if (!result.ok) {
    throw new Error(
      `getExecution failed: ${result.status} ${result.text}`,
    )
  }

  return result.data
}

/**
 * Poll an execution until it reaches a terminal status or times out.
 *
 * @param {string} workspaceId
 * @param {string} executionId
 * @param {number} [maxWaitMs=60000] - Maximum wait time in ms
 * @param {number} [intervalMs=2000] - Poll interval in ms
 * @returns {Promise<any>} execution detail (includes `status` field; "timeout" if exceeded)
 */
export async function pollExecution(workspaceId, executionId, maxWaitMs = 60000, intervalMs = 2000) {
  const startedAt = Date.now()

  while (Date.now() - startedAt < maxWaitMs) {
    try {
      const detail = await getExecution(workspaceId, executionId)
      if (TERMINAL_STATUSES.has(detail.status)) {
        return detail
      }
    } catch (err) {
      // Transient errors during poll are non-fatal — retry next interval
      const elapsed = Date.now() - startedAt
      if (elapsed >= maxWaitMs) break
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }

  return {
    status: "timeout",
    error: `Polling exceeded ${maxWaitMs}ms`,
    id: executionId,
  }
}

/**
 * Create a workflow file in a workspace via the API.
 *
 * @param {string} workspaceId
 * @param {string} ref - File reference (e.g. "my-workflow.yaml")
 * @param {string} content - YAML content
 * @returns {Promise<any>} created workflow data
 */
export async function createWorkflow(workspaceId, ref, content) {
  const result = await fetchJSON(`/api/workspaces/${workspaceId}/workflows`, {
    method: "POST",
    body: JSON.stringify({ ref, content }),
  })

  if (!result.ok) {
    throw new Error(
      `createWorkflow failed: ${result.status} ${result.text || JSON.stringify(result.data)}`,
    )
  }

  return result.data
}

/**
 * Pause a running execution.
 *
 * @param {string} workspaceId
 * @param {string} executionId
 * @returns {Promise<boolean>}
 */
export async function pauseExecution(workspaceId, executionId) {
  const result = await fetchJSON(
    `/api/workspaces/${workspaceId}/executions/${executionId}/pause`,
    { method: "POST" },
  )
  return result.ok
}

/**
 * Resume a paused execution.
 *
 * @param {string} workspaceId
 * @param {string} executionId
 * @returns {Promise<boolean>}
 */
export async function resumeExecution(workspaceId, executionId) {
  const result = await fetchJSON(
    `/api/workspaces/${workspaceId}/executions/${executionId}/resume`,
    { method: "POST" },
  )
  return result.ok
}

/**
 * Get the execution tree (all executions for a workspace).
 *
 * @param {string} workspaceId
 * @returns {Promise<any[]>}
 */
export async function getExecutionTree(workspaceId) {
  const result = await fetchJSON(`/api/workspaces/${workspaceId}/executions/tree`)
  if (!result.ok) {
    throw new Error(`getExecutionTree failed: ${result.status} ${result.text}`)
  }
  return Array.isArray(result.data) ? result.data : []
}
