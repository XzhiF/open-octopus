// packages/server/src/routes/agent/running.ts
//
// GET /api/agent/executions/running — header 右上角「运行中」指示的数据源。
//
// 与 /sessions/running 的分工：那边是 chat 的**内存流**（有人在打字/生成）；
// 这里是工作流**执行行**。工作流的 Agent 节点直接调 provider，不注册 chat 流，
// 所以任务/工作流在跑时右上角此前完全不亮。
//
// 只读、零 LLM；坐标与归属同 workflow-ops 的 toWorkspaceRun —— 验收规划这类
// 系统运行 task_id=NULL，坐标从 execution_links 补。

import { Hono } from "hono"
import type { ExecutionDAO } from "../../db/dao/execution-dao"
import { ExecutionLinkDAO } from "../../db/dao/execution-link-dao"

export interface RunningExecutionWire {
  id: string
  workspaceId: string
  /** 人看的名字：任务名 → 工作流名 → ref。 */
  title: string
  workflowRef: string
  workflowName: string
  taskId: string | null
  taskName: string | null
  phaseIndex: number | null
  roundIndex: number | null
  status: string
  startedAt: string | null
}

export function createRunningRoutes(execDao: ExecutionDAO): Hono {
  const router = new Hono()
  const execLinks = new ExecutionLinkDAO(execDao.getDb())

  router.get("/executions/running", (c) => {
    const raw = Number(c.req.query("limit") ?? 50)
    const limit = Number.isFinite(raw) ? Math.min(Math.max(Math.trunc(raw), 1), 100) : 50

    const rows = execDao.listLiveRuns(limit)
    const links = execLinks.findByExecutionIds(rows.map((r) => r.id))
    const runs: RunningExecutionWire[] = rows.map((row) => {
      const link = links.get(row.id)
      const taskId = row.task_id ?? link?.task_id ?? null
      const workflowName = row.workflow_name || row.workflow_ref
      return {
        id: row.id,
        workspaceId: row.workspace_id,
        title: row.task_name ?? workflowName,
        workflowRef: row.workflow_ref,
        workflowName,
        taskId,
        taskName: row.task_name ?? null,
        phaseIndex: row.phase_index ?? link?.phase_index ?? null,
        roundIndex: row.round_index ?? link?.round_index ?? null,
        status: row.status,
        startedAt: row.started_at ?? null,
      }
    })
    return c.json({ runs })
  })

  return router
}
