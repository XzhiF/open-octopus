import Database from "better-sqlite3"
import os from "os"
import { ExecutionService } from "./execution"
import { WorkspaceService } from "./workspace"
import { WorkflowService } from "./workflow"
import { BuiltInWorkflowService } from "./builtin-workflow"
import { SSEService } from "./sse"
import { ObservabilityService } from "./observability"
import { ExecutionDAO, WorkspaceDAO } from "../db/dao"
import { getResourceRegistry } from "./resource-registry"

let _db: Database.Database | null = null
let _sse: SSEService | null = null
let _obs: ObservabilityService | null = null
let _execDAO: ExecutionDAO | null = null
let _wsDAO: WorkspaceDAO | null = null

const serviceCache = new Map<string, { service: ExecutionService; wsPath: string }>()

export function initExecutionServiceRegistry(
  db: Database.Database,
  sse: SSEService,
  obs: ObservabilityService | undefined,
  daos?: { executionDAO?: ExecutionDAO; workspaceDAO?: WorkspaceDAO },
): void {
  _db = db
  _sse = sse
  _obs = obs ?? null
  _execDAO = daos?.executionDAO ?? null
  _wsDAO = daos?.workspaceDAO ?? null
}

export function getExecutionService(
  workspaceId: string,
): { service: ExecutionService; wsPath: string } | undefined {
  if (!_db || !_sse) {
    throw new Error("ExecutionServiceRegistry not initialized. Call initExecutionServiceRegistry() first.")
  }

  const cached = serviceCache.get(workspaceId)
  if (cached) return cached

  const ws = (_wsDAO ?? new WorkspaceDAO(_db)).findById(workspaceId) ?? undefined
  if (!ws) return undefined

  const resolvedPath = ws.path.replace(/^~/, os.homedir())
  const resourceManager = getResourceRegistry().get()
  const service = new ExecutionService(
    _db,
    _sse,
    new WorkflowService(),
    new BuiltInWorkflowService(resourceManager),
    ws.org,
    resolvedPath,
    ws.id,
    _obs ?? undefined,
    _execDAO ?? undefined,
  )
  const result = { service, wsPath: resolvedPath }
  serviceCache.set(workspaceId, result)
  return result
}

/** Alias for backward compatibility with routes/execution.ts */
export const getService = getExecutionService

export function clearServiceCache(): void {
  for (const { service } of serviceCache.values()) {
    service.destroy()
  }
  serviceCache.clear()
}
