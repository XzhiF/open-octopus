import { Hono } from "hono"
import { getService } from "../services/execution-service-registry"
import type { WorkspaceDAO } from "../db/dao/workspace-dao"
import type { ExecutionDAO } from "../db/dao/execution-dao"
import type { ExecutionRow } from "../db/types"

/** 触发者 = 系统工作流（不是人、不是任务轮次）。验收规划是第一个成员。 */
const SYSTEM_TRIGGERED_BY = new Set(["acceptance-plan"])

/** 工作区「运行」列表的一行（作业坞运行面板的数据源）。 */
export interface WorkspaceRunWire {
  id: string
  workspaceId: string
  workflowRef: string
  workflowName: string
  name: string | null
  status: string
  triggeredBy: string
  /** 执行行上没有 task_id 时从 pipeline_config 补（验收规划行故意 task_id=NULL）。 */
  taskId: string | null
  phaseIndex: number | null
  roundIndex: number | null
  /** 系统运行 —— 不计入轮次口径，UI 打「系统」章。 */
  isSystem: boolean
  createdAt: string
  startedAt: string | null
  completedAt: string | null
  /** 毫秒；执行行未落 duration 且已结束 → 由起止时间差补。 */
  duration: number | null
}

function parsePipelineConfig(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function toWorkspaceRun(row: ExecutionRow): WorkspaceRunWire {
  // 验收规划执行行 task_id / phase_index / round_index 均为 NULL（不进轮次口径），
  // 坐标只在 pipeline_config 里 —— 列表要显示 P1·R1 就从这里补。
  const config = parsePipelineConfig(row.pipeline_config)
  const startedAt = row.started_at ?? null
  const completedAt = row.completed_at ?? null
  const startedMs = startedAt ? Date.parse(startedAt) : NaN
  const completedMs = completedAt ? Date.parse(completedAt) : NaN
  const duration = row.duration != null
    ? row.duration
    : Number.isFinite(startedMs) && Number.isFinite(completedMs)
      ? Math.max(0, completedMs - startedMs)
      : null
  const triggeredBy = row.triggered_by ?? "manual"
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    workflowRef: row.workflow_ref,
    workflowName: row.workflow_name || row.workflow_ref,
    name: row.name ?? null,
    status: row.status,
    triggeredBy,
    taskId: row.task_id ?? (typeof config.task_id === "string" ? config.task_id : null),
    phaseIndex: row.phase_index ?? asNumber(config.phase_index),
    roundIndex: row.round_index ?? asNumber(config.round_index),
    isSystem: SYSTEM_TRIGGERED_BY.has(triggeredBy),
    createdAt: row.created_at,
    startedAt,
    completedAt,
    duration,
  }
}

export function createWorkflowOpsRoutes(_workspaceDao: WorkspaceDAO, execDao: ExecutionDAO): Hono {
  const router = new Hono()

  // GET /runs — 本工作区顶层运行列表（作业坞运行面板）。只读，不触发执行。
  // 与 /executions 的区别：/executions 走内存 registry 的全量行（含链式子步骤），
  // 这里走 DB 的顶层口径（roots + v4 链式轮次），重启后仍在。
  router.get("/runs", (c) => {
    const workspaceId = c.req.param("id")
    const rawLimit = Number(c.req.query("limit") ?? 50)
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 200) : 50
    const runs = execDao.listWorkspaceRuns(workspaceId, limit).map(toWorkspaceRun)
    return c.json({ runs })
  })

  // GET /executions — List executions with optional status filter
  router.get("/executions", (c) => {
    const workspaceId = c.req.param("id")
    const status = c.req.query("status")

    const svc = getService(workspaceId)
    if (!svc) return c.json({ error: "Workspace not found" }, 404)

    let executions = svc.service.list(workspaceId)
    if (status) {
      executions = executions.filter((e) => e.status === status)
    }

    return c.json({ executions })
  })

  // GET /executions/:execId/status — Execution status overview
  router.get("/executions/:execId/status", (c) => {
    const workspaceId = c.req.param("id")
    const execId = c.req.param("execId")
    if (!execId) return c.json({ error: "Execution id required" }, 400)

    const svc = getService(workspaceId)
    if (!svc) return c.json({ error: "Workspace not found" }, 404)

    const execution = svc.service.getById(execId)
    if (!execution) return c.json({ error: "Execution not found" }, 404)

    const withSteps = svc.service.getByIdWithSteps(execId)

    return c.json({
      status: execution.status,
      progress: execution.progress,
      gateStatus: execution.gate_status,
      startedAt: execution.started_at,
      completedAt: execution.completed_at,
      duration: execution.duration,
      nodeCount: withSteps?.steps?.length ?? 0,
      workflowName: execution.workflow_name,
    })
  })

  // POST /executions/:execId/abort — Abort execution
  router.post("/executions/:execId/abort", async (c) => {
    const workspaceId = c.req.param("id")
    const execId = c.req.param("execId")
    if (!execId) return c.json({ error: "Execution id required" }, 400)

    const svc = getService(workspaceId)
    if (!svc) return c.json({ error: "Workspace not found" }, 404)

    try {
      await svc.service.cancel(execId)
      return c.json({ ok: true })
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      return c.json({ error: message }, 500)
    }
  })

  // GET /executions/:execId/nodes/:nodeId/events — Node events
  router.get("/executions/:execId/nodes/:nodeId/events", (c) => {
    const workspaceId = c.req.param("id")
    const execId = c.req.param("execId")
    const nodeId = c.req.param("nodeId")
    if (!execId) return c.json({ error: "Execution id required" }, 400)
    if (!nodeId) return c.json({ error: "Node id required" }, 400)

    const svc = getService(workspaceId)
    if (!svc) return c.json({ error: "Workspace not found" }, 404)

    const events = svc.service.getAgentEvents(execId, nodeId)

    return c.json({ events })
  })

  return router
}
