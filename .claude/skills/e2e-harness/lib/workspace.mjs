/**
 * E2E Harness — workspace.mjs
 * Workspace lifecycle management for E2E tests.
 *
 * @module workspace
 * @status STABLE
 *
 * All workspace names are prefixed with E2E_HARNESS_TEST_ unless they
 * already start with that prefix.
 */

import { fetchJSON, resolveApiUrl } from "./api.mjs"

const TEST_PREFIX = "E2E_HARNESS_TEST_"

/**
 * Normalize workspace name with test prefix.
 * @param {string} name
 * @returns {string}
 */
function normalizeName(name) {
  return name.startsWith(TEST_PREFIX) ? name : `${TEST_PREFIX}${name}`
}

/**
 * Create a workspace.
 *
 * @param {string} name - Workspace name (prefix auto-applied)
 * @param {string} [org="xzf"] - Organization name
 * @param {string[]} [repos] - Optional repo list
 * @returns {Promise<{ id: string, name: string, org: string, path: string }>}
 */
export async function createWorkspace(name, org = "xzf", repos) {
  const fullName = normalizeName(name)

  // First, fetch org path for deriving workspace path
  let orgPath = ""
  try {
    const orgsResp = await fetchJSON("/api/orgs")
    if (orgsResp.ok && Array.isArray(orgsResp.data)) {
      const orgEntry = orgsResp.data.find((o) => o.name === org)
      if (orgEntry) orgPath = orgEntry.path || ""
    }
  } catch {
    // Non-critical — path derivation is best-effort
  }

  const body = {
    name: fullName,
    org,
    path: orgPath ? `${orgPath}/workspaces/${fullName}` : undefined,
    repos: repos && repos.length > 0 ? repos : undefined,
  }

  const result = await fetchJSON("/api/workspaces", {
    method: "POST",
    body: JSON.stringify(body),
  })

  if (!result.ok) {
    throw new Error(
      `createWorkspace failed: ${result.status} ${result.text || JSON.stringify(result.data)}`,
    )
  }

  return {
    id: result.data.id,
    name: result.data.name || fullName,
    org: result.data.org || org,
    path: result.data.path || "",
  }
}

/**
 * Delete a workspace (idempotent).
 *
 * @param {string} id - Workspace ID
 * @returns {Promise<boolean>} true if deleted, false if already gone
 */
export async function cleanupWorkspace(id) {
  if (!id) return false

  const result = await fetchJSON(`/api/workspaces/${id}`, {
    method: "DELETE",
  })

  // 200/204 = deleted, 404 = already gone (still counts as success)
  return result.ok || result.status === 404
}

/**
 * List all workspaces.
 *
 * @returns {Promise<Array<{ id: string, name: string, org: string }>>}
 */
export async function listWorkspaces() {
  const result = await fetchJSON("/api/workspaces")

  if (!result.ok) {
    throw new Error(`listWorkspaces failed: ${result.status} ${result.text}`)
  }

  const data = Array.isArray(result.data) ? result.data : result.data?.workspaces ?? []
  return data.map((ws) => ({
    id: ws.id,
    name: ws.name,
    org: ws.org,
    status: ws.status,
    projectCount: ws.projectCount ?? 0,
    workflowCount: ws.workflowCount ?? 0,
  }))
}

/**
 * Get workspace details by ID.
 *
 * @param {string} id - Workspace ID
 * @returns {Promise<{ id: string, name: string, org: string, projects: any[], workflows: any[] }>}
 */
export async function getWorkspace(id) {
  const result = await fetchJSON(`/api/workspaces/${id}`)

  if (!result.ok) {
    throw new Error(`getWorkspace failed: ${result.status} ${result.text}`)
  }

  return result.data
}

/**
 * Cleanup all workspaces matching the test prefix.
 * Useful for test teardown or stale data cleanup.
 *
 * @returns {Promise<number>} count of deleted workspaces
 */
export async function cleanupAllTestWorkspaces() {
  const all = await listWorkspaces()
  const testWorkspaces = all.filter((ws) => ws.name?.startsWith(TEST_PREFIX))

  const results = await Promise.all(
    testWorkspaces.map((ws) => cleanupWorkspace(ws.id))
  )
  return results.filter(Boolean).length
}
