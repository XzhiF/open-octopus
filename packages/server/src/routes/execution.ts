import { Hono } from "hono"
import { streamSSE } from "hono/streaming"
import { ExecutionService } from "../services/execution"
import { WorkspaceService } from "../services/workspace"
import { WorkflowService } from "../services/workflow"
import { BuiltInWorkflowService } from "../services/builtin-workflow"
import { SSEService } from "../services/sse"
import { ObservabilityService } from "../services/observability"
import { PipelineConfigLoader } from "../services/pipeline-config"
import { ExecutionDAO } from "../db/dao"
import { initExecutionServiceRegistry, getService } from "../services/execution-service-registry"
export { getService } from "../services/execution-service-registry"
import os from "os"

const executionRoutes = new Hono()
let _executionDAO: ExecutionDAO | null = null

export function setExecutionDependencies(sse: SSEService, obs: ObservabilityService, execDAO?: ExecutionDAO) {
  _executionDAO = execDAO ?? null
  if (execDAO) {
    initExecutionServiceRegistry(execDAO as any, sse, obs)
  }
}

function getWorkspaceId(c: { req: { param: (name: string) => string | undefined } }): string {
  const id = c.req.param("id")
  if (!id) throw Object.assign(new Error("workspace id required"), { status: 400 })
  return id
}

function getExecutionId(c: { req: { param: (name: string) => string | undefined } }): string {
  const id = c.req.param("executionId")
  if (!id) throw Object.assign(new Error("execution id required"), { status: 400 })
  return id
}

function handleError(err: unknown) {
  if (err && typeof err === "object" && "status" in err) {
    const e = err as { status: number; message?: string }
    return new Response(JSON.stringify({ error: e.message }), { status: e.status })
  }
  throw err
}

executionRoutes.get("/", (c) => {
  const workspaceId = getWorkspaceId(c)
  const svc = getService(workspaceId)
  if (!svc) return c.json({ error: "workspace not found" }, 404)
  return c.json(svc.service.list(workspaceId))
})

executionRoutes.post("/", async (c) => {
  const workspaceId = getWorkspaceId(c)
  const svc = getService(workspaceId)
  if (!svc) return c.json({ error: "workspace not found" }, 404)

  let body: {
    workflowName?: string
    workflow_ref?: string
    name?: string
    node_type?: string
    parent_id?: string | null
    child_index?: number
    input_values?: Record<string, string>
  }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: "invalid JSON body" }, 400)
  }
  const workflowRef = body.workflow_ref ?? body.workflowName ?? "unknown"

  // Basic XSS guard: reject workflow_ref containing HTML tags
  if (typeof workflowRef === "string" && /<[^>]*>/.test(workflowRef)) {
    return c.json({ error: "workflow_ref must not contain HTML tags" }, 400)
  }

  try {
    const execution = svc.service.create(workspaceId, {
      workflow_ref: workflowRef,
      name: body.name,
      node_type: body.node_type,
      parent_id: body.parent_id,
      child_index: body.child_index,
      input_values: body.input_values,
    })

    // Add children_count and is_leaf fields to match /tree endpoint format
    const response = {
      ...execution,
      children_count: 0,
      is_leaf: true,
    }

    return c.json(response, 201)
  } catch (e) {
    const message = e instanceof Error ? e.message : "create failed"
    if (message.includes("already has a root")) return c.json({ error: message }, 409)
    if (message.includes("parent_id")) return c.json({ error: message }, 400)
    return c.json({ error: message }, 500)
  }
})

executionRoutes.get("/tree", (c) => {
  const workspaceId = getWorkspaceId(c)
  const svc = getService(workspaceId)
  if (!svc) return c.json({ error: "workspace not found" }, 404)

  const allExecs = svc.service.list(workspaceId)
  const nodes = allExecs.map(e => {
    const children = allExecs.filter(child => child.parent_id === e.id)
    const tokenUsages = svc.service.getTokenUsagesForExecution(e.id)
    const approvalMetadata = e.approval_metadata
      ? JSON.parse(e.approval_metadata)
      : null
    return {
      id: e.id,
      parent_id: e.parent_id ?? "0",
      node_type: e.node_type ?? "normal",
      executor_type: e.node_type ?? "normal",
      child_index: e.child_index,
      workflow_ref: e.workflow_ref,
      workflow_name: e.workflow_name,
      name: e.name,
      status: e.status,
      gate_status: e.gate_status,
      branch: e.branch,
      input_values: e.input_values,
      start_commit_id: e.start_commit_id ? JSON.parse(e.start_commit_id) : undefined,
      end_commit_id: e.end_commit_id ? JSON.parse(e.end_commit_id) : undefined,
      rollback_on_error: e.rollback_on_error,
      progress: e.progress,
      started_at: e.started_at,
      completed_at: e.completed_at,
      duration: e.duration,
      triggered_by: e.triggered_by,
      children_count: children.length,
      is_leaf: children.length === 0,
      token_usages: tokenUsages.length > 0 ? tokenUsages : undefined,
      approval_metadata: approvalMetadata,
    }
  })
  return c.json({ workspace_id: workspaceId, nodes })
})

executionRoutes.get("/events", async (c) => {
  const workspaceId = getWorkspaceId(c)
  const svc = getService(workspaceId)
  if (!svc) return c.json({ error: "workspace not found" }, 404)

  return svc.service.streamEvents(c.req.raw)
})

executionRoutes.get("/:executionId", async (c) => {
  const workspaceId = getWorkspaceId(c)
  const executionId = getExecutionId(c)
  const svc = getService(workspaceId)
  if (!svc) return c.json({ error: "workspace not found" }, 404)
  const execution = svc.service.getByIdWithSteps(executionId)
  if (!execution) return c.json({ error: "not found" }, 404)
  const workflowContent = svc.service.getWorkflowContent(executionId)
  const allTokenUsages = svc.service.getTokenUsagesForExecution(executionId)
  const perStepTokenUsages = svc.service.getTokenUsagesPerStep(executionId)
  // Map node_executions to frontend StepExecution format
  const steps = execution.steps.map(ne => {
    const stepTokens = perStepTokenUsages.filter(t => t.stepId === ne.node_id)
    const tokensInput = stepTokens.length > 0 ? stepTokens.reduce((s, t) => s + t.inputTokens + (t.cacheReadTokens ?? 0), 0) : undefined
    const tokensOutput = stepTokens.length > 0 ? stepTokens.reduce((s, t) => s + t.outputTokens + (t.cacheCreationTokens ?? 0), 0) : undefined
    return {
      stepId: ne.node_id,
      stepName: ne.node_id,
      status: ne.status,
      startedAt: ne.started_at,
      completedAt: ne.completed_at,
      duration: ne.duration != null ? ne.duration / 1000 : undefined,
      error: ne.error,
      model: stepTokens.length > 0 ? stepTokens[0].model : undefined,
      tokensInput,
      tokensOutput,
      tokenUsages: stepTokens.length > 0 ? stepTokens.map(t => ({
        model: t.model,
        inputTokens: t.inputTokens,
        outputTokens: t.outputTokens,
        cacheReadTokens: t.cacheReadTokens,
        cacheCreationTokens: t.cacheCreationTokens,
      })) : undefined,
    }
  })

  // Parse approval metadata if present
  const approvalMetadata = execution.approval_metadata
    ? JSON.parse(execution.approval_metadata)
    : null

  return c.json({
    ...execution,
    steps,
    workflow_content: workflowContent,
    approvalMetadata,
    is_partial_failure: execution.status === "completed_with_failures",
  })
})

executionRoutes.get("/:executionId/state", (c) => {
  const workspaceId = getWorkspaceId(c)
  const executionId = getExecutionId(c)
  const svc = getService(workspaceId)
  if (!svc) return c.json({ error: "workspace not found" }, 404)
  const state = svc.service.getStateJson(executionId)
  if (!state) return c.json({ error: "state not found" }, 404)
  return c.json(state)
})

executionRoutes.post("/:executionId/start", async (c) => {
  const workspaceId = getWorkspaceId(c)
  const executionId = getExecutionId(c)
  const svc = getService(workspaceId)
  if (!svc) return c.json({ error: "workspace not found" }, 404)
  const body = await c.req.json<{ inputValues?: Record<string, string> }>().catch(() => ({}))

  try {
    const result = await svc.service.start(executionId, body.inputValues)

    // Auto-start chain if auto_execute is enabled
    const exec = svc.service.getById(executionId)
    if (exec) {
      const configLoader = new PipelineConfigLoader(svc.wsPath)
      const config = configLoader.getConfig()

      if (config?.chain?.auto_execute) {
        // Find the root of this execution's tree
        let rootId = exec.id
        let current = exec
        while (current.parent_id && current.parent_id !== "0") {
          const parent = svc.service.getById(current.parent_id)
          if (!parent) break
          rootId = parent.id
          current = parent
        }

        // Import chain-routes dynamically to avoid circular dependency
        const { tryAutoStartChain } = await import("./chain-routes")
        tryAutoStartChain(workspaceId, svc, rootId)
      }
    }

    return c.json(result)
  } catch (err: unknown) {
    return handleError(err)
  }
})

executionRoutes.post("/:executionId/retry", async (c) => {
  const workspaceId = getWorkspaceId(c)
  const executionId = getExecutionId(c)
  const svc = getService(workspaceId)
  if (!svc) return c.json({ error: "workspace not found" }, 404)

  const body = await c.req.json<{ failedNodeId: string; inputValues?: Record<string, string>; intervention?: string }>().catch(() => ({ failedNodeId: "" }))

  // Pre-validate synchronously so errors return as HTTP responses (not unhandled rejections).
  // retry() itself re-validates, but the early checks must pass before the void call.
  const exec = svc.service.getById(executionId)
  if (!exec) return c.json({ error: "Execution not found" }, 404)
  if (exec.status !== "failed") return c.json({ error: "Only failed executions can be retried" }, 400)

  // Fire-and-forget: retry() runs synchronous setup (status → "running", commit, on_retry hook)
  // before its first await, then continues engine execution in the background.
  // The HTTP response returns immediately — SSE events report progress/completion.
  svc.service.retry(executionId, body.failedNodeId, body.inputValues, body.intervention)
    .then(async () => {
      // Auto-start chain if auto_execute is enabled
      const configLoader = new PipelineConfigLoader(svc.wsPath)
      const config = configLoader.getConfig()

      if (config?.chain?.auto_execute) {
        // Find the root of this execution's tree
        let rootId = exec.id
        let current = exec
        while (current.parent_id && current.parent_id !== "0") {
          const parent = svc.service.getById(current.parent_id)
          if (!parent) break
          rootId = parent.id
          current = parent
        }

        const { tryAutoStartChain } = await import("./chain-routes")
        tryAutoStartChain(workspaceId, svc, rootId)
      }
    })
    .catch((err: unknown) => console.error(`[retry] ${executionId} background error:`, err))

  return c.json(svc.service.getById(executionId) ?? exec)
})

executionRoutes.post("/:executionId/cancel", async (c) => {
  const workspaceId = getWorkspaceId(c)
  const executionId = getExecutionId(c)
  const svc = getService(workspaceId)
  if (!svc) return c.json({ error: "workspace not found" }, 404)
  try {
    const result = await svc.service.cancel(executionId)
    return c.json(result)
  } catch (err: unknown) {
    return handleError(err)
  }
})

executionRoutes.post("/:executionId/skip", async (c) => {
  const workspaceId = getWorkspaceId(c)
  const executionId = getExecutionId(c)
  const svc = getService(workspaceId)
  if (!svc) return c.json({ error: "workspace not found" }, 404)
  try {
    const result = svc.service.skip(executionId)
    return c.json({ success: result })
  } catch (err: unknown) {
    return handleError(err)
  }
})

executionRoutes.delete("/:executionId", async (c) => {
  const workspaceId = getWorkspaceId(c)
  const executionId = getExecutionId(c)
  const svc = getService(workspaceId)
  if (!svc) return c.json({ error: "workspace not found" }, 404)
  try {
    const result = svc.service.delete(executionId)
    return c.json({ success: result })
  } catch (err: unknown) {
    return handleError(err)
  }
})

executionRoutes.post("/:executionId/approve", async (c) => {
  const workspaceId = getWorkspaceId(c)
  const executionId = getExecutionId(c)
  const svc = getService(workspaceId)
  if (!svc) return c.json({ error: "workspace not found" }, 404)

  const body = await c.req.json<{ nodeId: string; answer: string; comment?: string }>()
  try {
    const result = await svc.service.approve(executionId, body.nodeId, body.answer, body.comment)
    return c.json(result)
  } catch (err: unknown) {
    return handleError(err)
  }
})

executionRoutes.post("/:executionId/pause", async (c) => {
  const workspaceId = getWorkspaceId(c)
  const executionId = getExecutionId(c)
  const svc = getService(workspaceId)
  if (!svc) return c.json({ error: "workspace not found" }, 404)
  const result = await svc.service.pause(executionId)
  if (!result.success) {
    const status = result.error === "执行不存在" ? 404 : 400
    return c.json({ success: false, error: result.error }, status)
  }
  return c.json({ success: true })
})

executionRoutes.post("/:executionId/resume", async (c) => {
  const workspaceId = getWorkspaceId(c)
  const executionId = getExecutionId(c)
  const svc = getService(workspaceId)
  if (!svc) return c.json({ error: "workspace not found" }, 404)

  // Parse optional intervention prompt from request body
  let intervention: string | undefined
  try {
    const body = await c.req.json().catch(() => ({}))
    intervention = body.intervention
  } catch {
    // No body or invalid JSON, proceed without intervention
  }

  const result = await svc.service.resume(executionId, intervention)
  if (!result.success) {
    const status = result.error === "执行不存在" ? 404 : 400
    return c.json({ success: false, error: result.error }, status)
  }
  return c.json({ success: true })
})

executionRoutes.get("/:executionId/agent-events", (c) => {
  const workspaceId = getWorkspaceId(c)
  const executionId = getExecutionId(c)
  const nodeId = c.req.query("nodeId")
  const loopId = c.req.query("loopId") || undefined
  const iterationParam = c.req.query("iteration")
  const iteration = iterationParam ? parseInt(iterationParam, 10) : undefined
  const svc = getService(workspaceId)
  if (!svc) return c.json({ error: "workspace not found" }, 404)

  // Verify execution exists
  try {
    if (!_executionDAO) return c.json({ error: "database not available" }, 503)
    if (!_executionDAO.exists(executionId)) return c.json({ error: "execution not found" }, 404)
  } catch {
    return c.json({ error: "execution not found" }, 404)
  }

  // Compute loop iteration summary
  const loopIterations = svc.service.getLoopIterationSummary(executionId)

  // SQLite-first: query agent_events joined with node_executions
  try {
    const dao = _executionDAO!
    const sqliteEvents = dao.findAgentEventsWithNode(executionId, nodeId || undefined)
    if (sqliteEvents.length > 0) {
      // Transform SQLite rows to the JSONL-compatible format the frontend expects
      const transformed = sqliteEvents.map((row: any) => {
        const eventData: Record<string, unknown> = { type: row.event_type }

        // Map flat SQLite columns → nested event_data fields
        if (row.event_type === "status") {
          eventData.status = row.status_value ?? undefined
        } else if (row.event_type === "error") {
          eventData.code = row.error_code ?? undefined
          eventData.message = row.error_message ?? undefined
        } else if (row.event_type === "thinking" || row.event_type === "thinking_done" || row.event_type === "text_delta") {
          if (row.content) eventData.content = row.content
          if (row.event_type === "thinking_done" && row.tool_duration_ms) {
            eventData.duration = row.tool_duration_ms >= 1000
              ? `${(row.tool_duration_ms / 1000).toFixed(1)}s`
              : `${row.tool_duration_ms}ms`
          }
        } else if (row.event_type === "tool_start" || row.event_type === "tool_input") {
          if (row.tool_name) eventData.toolName = row.tool_name
          if (row.tool_call_id) eventData.toolCallId = row.tool_call_id
          if (row.tool_input) {
            try { eventData.input = JSON.parse(row.tool_input) } catch { eventData.input = row.tool_input }
          }
        } else if (row.event_type === "tool_result") {
          if (row.tool_result) eventData.content = row.tool_result
          if (row.tool_call_id) eventData.toolCallId = row.tool_call_id
          eventData.isError = row.tool_is_error === 1
          if (row.tool_duration_ms != null) {
            eventData.duration = row.tool_duration_ms >= 1000
              ? `${(row.tool_duration_ms / 1000).toFixed(1)}s`
              : `${row.tool_duration_ms}ms`
          }
        } else {
          // Fallback: copy content if present
          if (row.content) eventData.content = row.content
        }

        return {
          nodeId: row.node_id,
          event: "agent_event",
          event_data: eventData,
          timestamp: new Date(row.timestamp).toISOString(),
        }
      })

      // Merge with JSONL non-agent events (start/end/bash_log/python_log)
      // SQLite only stores agent events; lifecycle & script logs live in JSONL files
      const jsonlEvents = svc.service.getAgentEvents(executionId, nodeId || undefined, loopId, iteration)
      const nonAgentEvents = jsonlEvents.filter((e: any) => e.event !== "agent_event")
      const merged = [...transformed, ...nonAgentEvents]
        .sort((a: any, b: any) => (a.timestamp ?? "").localeCompare(b.timestamp ?? ""))

      return c.json({ executionId, events: merged, source: 'sqlite', _degraded: false, _message: null, loopIterations })
    }
  } catch {
    // SQLite query failed — fall through to JSONL
  }

  // JSONL fallback
  const events = svc.service.getAgentEvents(executionId, nodeId || undefined, loopId, iteration)
  return c.json({ executionId, events, source: 'jsonl', _degraded: true, _message: '从 JSONL 日志读取', loopIterations })
})

executionRoutes.get("/:executionId/branches", async (c) => {
  const workspaceId = getWorkspaceId(c)
  const executionId = getExecutionId(c)
  const svc = getService(workspaceId)
  if (!svc) return c.json({ error: "workspace not found" }, 404)
  const branches = svc.service.getBranches(executionId)
  return c.json(branches)
})

executionRoutes.get("/:executionId/logs", (c) => {
  const workspaceId = getWorkspaceId(c)
  const executionId = getExecutionId(c)
  const svc = getService(workspaceId)
  if (!svc) return c.json({ error: "workspace not found" }, 404)

  return streamSSE(c, async (stream) => {
    const events = svc.service.getLogEvents(executionId)
    for (const event of events) {
      stream.writeSSE({
        event: event.type,
        data: JSON.stringify(event.data),
      })
    }
    stream.writeSSE({ event: "status", data: JSON.stringify({ status: "streaming", executionId }) })
    await stream.sleep(1000)
    stream.writeSSE({ event: "complete", data: JSON.stringify({ executionId, message: "stream ended" }) })
  })
})

export default executionRoutes