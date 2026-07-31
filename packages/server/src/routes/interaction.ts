// packages/server/src/routes/interaction.ts
//
// Interaction route — REST API for workflow interaction node conversations.
// Handles SSE streaming, message history, and interaction lifecycle.
// Mounted at /api/workspaces/:id/interactions

import { Hono } from "hono"
import { streamSSE } from "hono/streaming"
import os from "os"
import type { InteractionService } from "../services/interaction/InteractionService"
import { getExecutionService } from "../services/execution-service-registry"
import { WorkspaceDAO } from "../db/dao/workspace-dao"

/**
 * Create interaction route factory.
 * Called once during server startup with shared dependencies.
 */
export function createInteractionRoutes(
  interactionService: InteractionService,
  workspaceDao: WorkspaceDAO,
): Hono {
  const router = new Hono()

  /**
   * POST /:execId/:nodeId/start — Initialize interaction session.
   * Called by frontend when it receives execution_interaction_started SSE.
   */
  router.post("/:execId/:nodeId/start", async (c) => {
    const workspaceId = c.req.param("id")
    const { execId, nodeId } = c.req.param()

    try {
      const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
      const result = interactionService.startInteraction({
        workspaceId,
        executionId: execId,
        nodeId,
        display: (body.display as "modal" | "panel") ?? "modal",
        initialPrompt: body.initialPrompt as string | undefined,
        maxRounds: body.maxRounds as number | undefined,
        timeout: body.timeout as number | undefined,
      })

      return c.json({ sessionId: result.sessionId, initialPrompt: result.initialPrompt }, 201)
    } catch (error) {
      return c.json({
        error: error instanceof Error ? error.message : String(error),
      }, 500)
    }
  })

  /**
   * POST /:execId/:nodeId/messages — Send message, stream SSE response.
   * The main conversation endpoint. Returns an SSE stream.
   */
  router.post("/:execId/:nodeId/messages", async (c) => {
    const workspaceId = c.req.param("id")
    const { execId, nodeId } = c.req.param()

    let body: { content?: string }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400)
    }

    if (!body.content) {
      return c.json({ error: "content is required" }, 400)
    }

    // Resolve workspace path for cwd
    const ws = workspaceDao.findById(workspaceId)
    if (!ws) {
      return c.json({ error: "Workspace not found" }, 404)
    }
    const cwd = ws.path.replace(/^~/, os.homedir())

    return streamSSE(c, async (stream) => {
      let aborted = false
      stream.onAbort(() => { aborted = true })

      try {
        for await (const event of interactionService.sendMessage({
          executionId: execId,
          nodeId,
          content: body.content!,
          cwd,
        })) {
          if (aborted) break

          await stream.writeSSE({
            event: event.type,
            data: JSON.stringify(event),
          })

          // If interaction completed, trigger workflow resume
          if (event.type === "interaction_complete") {
            const execSvc = getExecutionService(workspaceId)
            if (execSvc) {
              // Trigger workflow completion asynchronously
              execSvc.service.completeInteraction(
                execId,
                nodeId,
                event.summary as string,
                event.vars_update as Record<string, unknown> | undefined,
              ).catch((err) => {
                // Log but don't fail the stream
                // eslint-disable-next-line no-console
                console.error("[interaction] completeInteraction failed:", err)
              })
            }
          }
        }
      } catch (error) {
        if (!aborted) {
          await stream.writeSSE({
            event: "error",
            data: JSON.stringify({
              type: "error",
              code: "STREAM_ERROR",
              message: error instanceof Error ? error.message : String(error),
            }),
          })
        }
      } finally {
        stream.close()
      }
    })
  })

  /**
   * GET /:execId/:nodeId/messages — Get message history.
   * Supports cursor-based pagination via ?limit and ?before query params.
   */
  router.get("/:execId/:nodeId/messages", (c) => {
    const { execId, nodeId } = c.req.param()
    const limit = Number(c.req.query("limit") ?? 100)
    const before = c.req.query("before") ?? undefined

    try {
      const messages = interactionService.getMessages({
        executionId: execId,
        nodeId,
        limit,
        before,
      })

      return c.json(messages)
    } catch (error) {
      return c.json({
        error: error instanceof Error ? error.message : String(error),
      }, 500)
    }
  })

  /**
   * POST /:execId/:nodeId/complete — Force complete an interaction.
   * Used for admin intervention or timeout.
   */
  router.post("/:execId/:nodeId/complete", async (c) => {
    const workspaceId = c.req.param("id")
    const { execId, nodeId } = c.req.param()

    try {
      const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
      const summary = (body.summary as string) ?? "User manually ended interaction"
      const varsUpdate = body.vars_update as Record<string, unknown> | undefined

      // Force complete: persist completion data and clean up session
      const result = interactionService.forceComplete({
        executionId: execId,
        nodeId,
        summary,
        varsUpdate,
      })

      // Trigger workflow completion via ExecutionService
      const execSvc = getExecutionService(workspaceId)
      if (execSvc) {
        await execSvc.service.completeInteraction(execId, nodeId, result.summary, result.vars_update)
      }

      return c.json({ ok: true })
    } catch (error) {
      return c.json({
        error: error instanceof Error ? error.message : String(error),
      }, 500)
    }
  })

  /**
   * GET /:execId/:nodeId/status — Get interaction session status.
   */
  router.get("/:execId/:nodeId/status", (c) => {
    const { execId, nodeId } = c.req.param()

    const status = interactionService.getSessionStatus(execId, nodeId)
    if (!status) {
      return c.json({ active: false })
    }

    return c.json({
      active: true,
      sessionId: status.sessionId,
      currentRound: status.currentRound,
      maxRounds: status.maxRounds,
      display: status.display,
      startedAt: status.startedAt,
    })
  })

  return router
}
