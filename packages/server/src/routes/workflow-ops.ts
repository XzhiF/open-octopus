import { Hono } from "hono"
import { getService } from "../services/execution-service-registry"
import type { WorkspaceDAO } from "../db/dao/workspace-dao"
import type { ExecutionDAO } from "../db/dao/execution-dao"
import { ExecutionLinkDAO, type ExecutionLinkRow } from "../db/dao/execution-link-dao"
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
  /** 任务归属：执行行自带 task_id（轮），或 execution_links 登记（辅助执行）。 */
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

function toWorkspaceRun(row: ExecutionRow, link?: ExecutionLinkRow): WorkspaceRunWire {
  // 验收规划执行行 task_id / phase_index / round_index 均为 NULL（不进轮次口径）。
  // 坐标只认 execution_links（2026-11-03 起的持久归属）—— pipeline_config 会在
  // start 时被引擎整体覆盖，不是归属源。
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
    taskId: row.task_id ?? link?.task_id ?? null,
    phaseIndex: row.phase_index ?? link?.phase_index ?? null,
    roundIndex: row.round_index ?? link?.round_index ?? null,
    isSystem: SYSTEM_TRIGGERED_BY.has(triggeredBy),
    createdAt: row.created_at,
    startedAt,
    completedAt,
    duration,
  }
}

export function createWorkflowOpsRoutes(_workspaceDao: WorkspaceDAO, execDao: ExecutionDAO): Hono {
  const router = new Hono()
  const execLinks = new ExecutionLinkDAO(execDao.getDb())

  // GET /runs — 本工作区顶层运行列表（作业坞运行面板）。只读，不触发执行。
  // 与 /executions 的区别：/executions 走内存 registry 的全量行（含链式子步骤），
  // 这里走 DB 的顶层口径（roots + v4 链式轮次），重启后仍在。
  router.get("/runs", (c) => {
    const workspaceId = c.req.param("id")
    const rawLimit = Number(c.req.query("limit") ?? 50)
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 200) : 50
    const runs = execDao.listWorkspaceRuns(workspaceId, limit)
    const links = execLinks.findByExecutionIds(runs.map((r) => r.id))
    return c.json({ runs: runs.map((r) => toWorkspaceRun(r, links.get(r.id))) })
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
