// packages/server/src/routes/repair.ts
// HTTP endpoints for the workflow repair mechanism.
// Mounted as a sub-router under /:executionId/repair within execution routes.

import { Hono } from "hono"
import { RepairService, RepairError } from "../services/repair"
import { WorkflowService } from "../services/workflow"
import { BuiltInWorkflowService } from "../services/builtin-workflow"
import {
  VarPoolUpdateRequestSchema,
  NodeResetRequestSchema,
  RestorePointRequestSchema,
  ReloadWorkflowRequestSchema,
  InterveneRequestSchema,
  ClearRetryRequestSchema,
} from "@octopus/shared"
import { getResourceRegistry } from "../services/resource-registry"
import type { ExecutionDAO } from "../db/dao"
import type { SSEService } from "../services/sse"
import type { ExecutionService } from "../services/execution"

let _dao: ExecutionDAO | null = null
let _sse: SSEService | null = null
let _getExecService: ((wsId: string) => { service: ExecutionService; wsPath: string } | undefined) | null = null

export function setRepairDependencies(
  dao: ExecutionDAO,
  sse: SSEService,
  getExecService: (wsId: string) => { service: ExecutionService; wsPath: string } | undefined,
): void {
  _dao = dao
  _sse = sse
  _getExecService = getExecService
}

const repairRoutes = new Hono()

function getRepairService(c: { req: { param: (name: string) => string | undefined } }): RepairService {
  if (!_dao || !_sse || !_getExecService) {
    throw new RepairError("repair service not initialized", 503)
  }
  const workspaceId = c.req.param("id")
  if (!workspaceId) throw new RepairError("workspace id required", 400)

  const svcEntry = _getExecService(workspaceId)
  if (!svcEntry) throw new RepairError("workspace not found", 404)

  const resourceManager = getResourceRegistry().get()
  return new RepairService(
    _dao,
    _sse,
    svcEntry.service,
    new WorkflowService(),
    new BuiltInWorkflowService(resourceManager),
    svcEntry.wsPath,
    workspaceId,
  )
}

function getExecutionId(c: { req: { param: (name: string) => string | undefined } }): string {
  const id = c.req.param("executionId")
  if (!id) throw new RepairError("execution id required", 400)
  return id
}

function handleRepairError(err: unknown): Response {
  if (err instanceof RepairError) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: err.status,
      headers: { "Content-Type": "application/json" },
    })
  }
  if (err && typeof err === "object" && "status" in err) {
    const e = err as { status: number; message?: string }
    return new Response(JSON.stringify({ error: e.message }), { status: e.status })
  }
  throw err
}

// ── GET /diagnose ──────────────────────────────────────────────────

repairRoutes.get("/diagnose", (c) => {
  try {
    const service = getRepairService(c)
    const executionId = getExecutionId(c)
    const report = service.diagnose(executionId)
    return c.json(report)
  } catch (err: unknown) {
    return handleRepairError(err)
  }
})

// ── POST /varpool ──────────────────────────────────────────────────

repairRoutes.post("/varpool", async (c) => {
  try {
    const service = getRepairService(c)
    const executionId = getExecutionId(c)
    const body = await c.req.json()
    const parsed = VarPoolUpdateRequestSchema.parse(body)
    const result = service.patchVarPool(executionId, parsed.updates)
    return c.json(result)
  } catch (err: unknown) {
    return handleRepairError(err)
  }
})

// ── POST /node/:nodeId/reset ───────────────────────────────────────

repairRoutes.post("/node/:nodeId/reset", async (c) => {
  try {
    const service = getRepairService(c)
    const executionId = getExecutionId(c)
    const nodeId = c.req.param("nodeId")
    if (!nodeId) return c.json({ error: "nodeId required" }, 400)

    const body = await c.req.json()
    const parsed = NodeResetRequestSchema.parse(body)
    const result = service.resetNode(executionId, nodeId, parsed.status, parsed.outputs)
    return c.json(result)
  } catch (err: unknown) {
    return handleRepairError(err)
  }
})

// ── POST /restore-point ────────────────────────────────────────────

repairRoutes.post("/restore-point", async (c) => {
  try {
    const service = getRepairService(c)
    const executionId = getExecutionId(c)
    const body = await c.req.json()
    const parsed = RestorePointRequestSchema.parse(body)
    const result = service.restorePoint(executionId, parsed.nodeId, parsed.resetVarPool)
    return c.json(result)
  } catch (err: unknown) {
    return handleRepairError(err)
  }
})

// ── POST /reload-workflow ──────────────────────────────────────────

repairRoutes.post("/reload-workflow", async (c) => {
  try {
    const service = getRepairService(c)
    const executionId = getExecutionId(c)
    const body = await c.req.json()
    const parsed = ReloadWorkflowRequestSchema.parse(body)
    const result = service.reloadWorkflow(executionId, parsed.content)
    return c.json(result)
  } catch (err: unknown) {
    return handleRepairError(err)
  }
})

// ── POST /intervene ────────────────────────────────────────────────

repairRoutes.post("/intervene", async (c) => {
  try {
    const service = getRepairService(c)
    const executionId = getExecutionId(c)
    const body = await c.req.json()
    const parsed = InterveneRequestSchema.parse(body)
    const result = await service.intervene(executionId, parsed.nodeId, parsed.message)
    return c.json(result)
  } catch (err: unknown) {
    return handleRepairError(err)
  }
})

// ── POST /clear-retry ──────────────────────────────────────────────

repairRoutes.post("/clear-retry", async (c) => {
  try {
    const service = getRepairService(c)
    const executionId = getExecutionId(c)
    const body = await c.req.json().catch(() => ({}))
    const parsed = ClearRetryRequestSchema.parse(body)
    const result = service.clearRetry(executionId, parsed.nodeIds)
    return c.json(result)
  } catch (err: unknown) {
    return handleRepairError(err)
  }
})

export default repairRoutes
