// packages/server/src/routes/chain-routes.ts
import { Hono } from "hono"
import { getService } from "./execution"
import { ChainEngine } from "../services/chain-engine"
import { PipelineConfigLoader } from "../services/pipeline-config"
import type { ExecutionRow } from "../services/execution/types"
import type { SSEService } from "../services/sse"
import type { ExecutionDAO } from "../db/dao/execution-dao"
import type { ExecutionLifecycle } from "../services/execution/ExecutionLifecycle"

const chainRoutes = new Hono()

const activeChains = new Map<string, { engine: ChainEngine; abortController: AbortController }>()

function createDAOAdapter(svc: { service: any }): ExecutionDAO {
  return (svc.service as any).dao as ExecutionDAO
}

function createLifecycleAdapter(svc: { service: any }): ExecutionLifecycle {
  let chainCallback: ((executionId: string, status: string) => void | Promise<void>) | undefined

  return {
    start: async (executionId: string, inputValues?: Record<string, string>) => {
      const result = await svc.service.start(executionId, inputValues)
      if (chainCallback) {
        pollUntilComplete(svc.service, executionId).then((status) => {
          chainCallback!(executionId, status)
        }).catch(() => {
          chainCallback!(executionId, "failed")
        })
      }
      return result
    },
    retry: async (executionId: string, failedNodeId?: string, inputValues?: Record<string, string>) => {
      const result = await svc.service.retry(executionId, failedNodeId || executionId, inputValues)
      if (chainCallback) {
        pollUntilComplete(svc.service, executionId).then((status) => {
          chainCallback!(executionId, status)
        }).catch(() => {
          chainCallback!(executionId, "failed")
        })
      }
      return result
    },
    setChainCallback: (callback: (executionId: string, status: string) => void | Promise<void>) => {
      chainCallback = callback
    },
  } as unknown as ExecutionLifecycle
}

async function pollUntilComplete(svc: any, executionId: string): Promise<string> {
  const TERMINAL = new Set(["completed", "failed", "cancelled", "rejected", "completed_with_failures"])
  const POLL_INTERVAL = 2000
  const MAX_POLLS = 43200

  for (let i = 0; i < MAX_POLLS; i++) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL))
    const exec = svc.getById(executionId)
    if (!exec) throw new Error(`Execution ${executionId} not found`)
    if (TERMINAL.has(exec.status)) return exec.status
  }
  return "failed"
}

chainRoutes.post("/:workspaceId/pipeline/chain/start", async (c) => {
  const workspaceId = c.req.param("workspaceId")
  const svc = getService(workspaceId)
  if (!svc) return c.json({ error: "workspace not found" }, 404)

  if (activeChains.has(workspaceId)) {
    return c.json({ error: "Chain is already running for this workspace" }, 409)
  }

  const configLoader = new PipelineConfigLoader(svc.wsPath)
  const config = configLoader.getConfig()
  if (!config?.chain?.auto_execute) {
    return c.json({ error: "Chain auto_execute is not enabled in pipeline.yaml" }, 400)
  }

  const dao = createDAOAdapter(svc)
  const rootExec = dao.findRootExecutionId(workspaceId)
  if (!rootExec) {
    return c.json({ error: "No pending root execution found. Create a root execution first." }, 400)
  }

  const abortController = new AbortController()
  const lifecycle = createLifecycleAdapter(svc)
  const sse = (svc.service as any).sse as SSEService

  const engine = new ChainEngine(dao, lifecycle, configLoader, sse)
  activeChains.set(workspaceId, { engine, abortController })

  engine.startChain(rootExec.id).then((result) => {
    activeChains.delete(workspaceId)
    sse?.emit(workspaceId, { event: "chain:completed", data: result })
  }).catch((err) => {
    activeChains.delete(workspaceId)
    console.error(`[ChainRoutes] Chain failed for workspace ${workspaceId}:`, err)
    sse?.emit(workspaceId, {
      event: "chain:failed",
      data: { error: err instanceof Error ? err.message : String(err) },
    })
  })

  return c.json({ success: true, rootExecutionId: rootExec.id, message: "Chain started" })
})

chainRoutes.post("/:workspaceId/pipeline/chain/stop", (c) => {
  const workspaceId = c.req.param("workspaceId")
  const active = activeChains.get(workspaceId)
  if (!active) return c.json({ error: "No active chain for this workspace" }, 404)

  active.engine.stop()
  active.abortController.abort()
  activeChains.delete(workspaceId)
  return c.json({ success: true, message: "Chain stopped" })
})

chainRoutes.get("/:workspaceId/pipeline/chain/status", (c) => {
  const workspaceId = c.req.param("workspaceId")
  const active = activeChains.get(workspaceId)
  if (!active) return c.json({ running: false })
  return c.json({ running: true, status: active.engine.getStatus() })
})

export function tryAutoStartChain(
  workspaceId: string,
  svc: { service: any; wsPath: string },
  rootExecutionId: string
): void {
  if (activeChains.has(workspaceId)) {
    console.log(`[ChainRoutes] Chain already running for workspace ${workspaceId}, skipping auto-start`)
    return
  }

  const configLoader = new PipelineConfigLoader(svc.wsPath)
  const abortController = new AbortController()
  const dao = createDAOAdapter(svc)
  const lifecycle = createLifecycleAdapter(svc)
  const sse = (svc.service as any).sse as SSEService

  const engine = new ChainEngine(dao, lifecycle, configLoader, sse)
  activeChains.set(workspaceId, { engine, abortController })

  console.log(`[ChainRoutes] Auto-starting chain from root execution ${rootExecutionId}`)

  engine.startChain(rootExecutionId).then((result) => {
    activeChains.delete(workspaceId)
    console.log(`[ChainRoutes] Chain completed for workspace ${workspaceId}:`, result)
    sse?.emit(workspaceId, { event: "chain:completed", data: result })
  }).catch((err) => {
    activeChains.delete(workspaceId)
    console.error(`[ChainRoutes] Chain failed for workspace ${workspaceId}:`, err)
    sse?.emit(workspaceId, {
      event: "chain:failed",
      data: { error: err instanceof Error ? err.message : String(err) },
    })
  })
}

export default chainRoutes
