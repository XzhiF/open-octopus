// packages/server/src/services/execution/ExecutionQueryService.ts
//
// Read-only query methods for execution data: logs, agent events,
// loop iteration summaries, workflow content, SSE streaming, and token usages.
//
import type { ExecutionDAO } from "../../db/dao/execution-dao"
import type { SSEService } from "../sse"
import type { WorkflowService } from "../workflow"
import type { BuiltInWorkflowService } from "../builtin-workflow"
import { WorkflowRef } from "@octopus/shared"
import { parseLogFilename } from "@octopus/engine"
import { join } from "path"
import { existsSync, readdirSync, readFileSync } from "fs"

export interface QueryServiceDeps {
  dao: ExecutionDAO
  sse: SSEService
  workflowService: WorkflowService
  builtInWorkflowService: BuiltInWorkflowService
  workspacePath: string
  workspaceId: string  // SSE workspace ID
}

export class ExecutionQueryService {
  private dao: ExecutionDAO
  private sse: SSEService
  private workflowService: WorkflowService
  private builtInWorkflowService: BuiltInWorkflowService
  private workspacePath: string
  private workspaceId: string

  constructor(deps: QueryServiceDeps) {
    this.dao = deps.dao
    this.sse = deps.sse
    this.workflowService = deps.workflowService
    this.builtInWorkflowService = deps.builtInWorkflowService
    this.workspacePath = deps.workspacePath
    this.workspaceId = deps.workspaceId
  }

  getLogEvents(executionId: string): { type: string; timestamp: string; data: Record<string, unknown> }[] {
    const nodeExecs = this.dao.findNodeExecutions(executionId)
    return nodeExecs.map(ne => ({
      type: ne.status === "completed" ? "node_end" : "node_start",
      timestamp: ne.started_at ?? "",
      data: { nodeId: ne.node_id, nodeType: ne.node_type, status: ne.status, exitCode: ne.exit_code },
    }))
  }

  getAgentEvents(executionId: string, nodeId?: string, loopId?: string, iteration?: number): any[] {
    const logDir = join(this.workspacePath, "logs", executionId)
    if (!existsSync(logDir)) return []

    const events: any[] = []
    const files = readdirSync(logDir).filter(f => f.endsWith(".jsonl"))
    for (const file of files) {
      const parsed = parseLogFilename(file)
      if (loopId && parsed.loopId && parsed.loopId !== loopId) continue
      if (iteration !== undefined && parsed.iteration !== undefined && parsed.iteration !== iteration) continue

      const fileNodeId = parsed.nodeId
      if (nodeId && !parsed.loopId && fileNodeId !== nodeId) continue

      const content = readFileSync(join(logDir, file), "utf-8")
      for (const line of content.split("\n")) {
        if (!line.trim()) continue
        try {
          const entry = JSON.parse(line)
          events.push({
            ...entry,
            nodeId: entry.nodeId ?? fileNodeId,
            ...(parsed.loopId ? { loopId: parsed.loopId, iteration: parsed.iteration } : {}),
          })
        } catch { /* skip malformed lines */ }
      }
    }
    return events.sort((a, b) => (a.timestamp ?? "").localeCompare(b.timestamp ?? ""))
  }

  getLoopIterationSummary(executionId: string): Record<string, any> {
    const logDir = join(this.workspacePath, "logs", executionId)
    if (!existsSync(logDir)) return {}

    const files = readdirSync(logDir).filter(f => f.endsWith(".jsonl"))
    const raw: Record<string, any[]> = {}

    for (const file of files) {
      const parsed = parseLogFilename(file)
      if (parsed.loopId) continue

      const content = readFileSync(join(logDir, file), "utf-8")
      for (const line of content.split("\n")) {
        if (!line.trim()) continue
        try {
          const entry = JSON.parse(line)
          if (entry.event !== "branch_start" && entry.event !== "branch_end") continue

          const nodeId = entry.nodeId ?? parsed.nodeId
          if (!raw[nodeId]) raw[nodeId] = []

          const iter = entry.iteration
          if (iter === undefined) continue

          let iterEntry = raw[nodeId].find((e: any) => e.iteration === iter)
          if (!iterEntry) {
            iterEntry = { iteration: iter, status: "running", startedAt: null, completedAt: null, durationMs: null, nodes: [] }
            raw[nodeId].push(iterEntry)
          }

          if (entry.event === "branch_start") {
            iterEntry.startedAt = entry.timestamp
          } else if (entry.event === "branch_end") {
            iterEntry.status = entry.status ?? "completed"
            iterEntry.completedAt = entry.timestamp
            if (iterEntry.startedAt) {
              iterEntry.durationMs = new Date(entry.timestamp).getTime() - new Date(iterEntry.startedAt).getTime()
            }
            if (Array.isArray(entry.nodeResults)) {
              iterEntry.nodes = entry.nodeResults
            }
          }
        } catch { /* skip */ }
      }
    }

    const summary: Record<string, any> = {}
    for (const [loopNodeId, iterations] of Object.entries(raw)) {
      iterations.sort((a: any, b: any) => a.iteration - b.iteration)
      const completed = iterations.filter((i: any) => i.status === "completed").length
      const failed = iterations.filter((i: any) => i.status === "failed").length
      const running = iterations.find((i: any) => i.status === "running")

      summary[loopNodeId] = {
        total: undefined,
        completed,
        failed,
        current: running?.iteration,
        mode: "dynamic" as const,
        iterations,
      }
    }

    return summary
  }

  getWorkflowContent(executionId: string): string | null {
    const exec = this.dao.findById(executionId)
    if (!exec) return null

    const snapshotPath = join(this.workspacePath, "state", `${executionId}-${WorkflowRef.sanitize(exec.workflow_ref)}`)
    if (existsSync(snapshotPath)) return readFileSync(snapshotPath, "utf-8")

    const local = this.workflowService.get(this.workspacePath, exec.workflow_ref)
    if (local) return local.content
    const builtIn = this.builtInWorkflowService.get(exec.workflow_ref)
    return builtIn?.content ?? null
  }

  streamEvents(req: Request): Response {
    const { readable, writable } = new TransformStream()
    const writer = writable.getWriter()
    const encoder = new TextEncoder()

    const unsubscribe = this.sse.subscribe(this.workspaceId, (event) => {
      writer.write(encoder.encode(`event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`))
    })

    req.signal.addEventListener("abort", () => {
      unsubscribe()
      writer.close()
    })

    return new Response(readable, {
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" },
    })
  }

  getTokenUsagesPerStep(executionId: string): Array<{ stepId?: string; model: string; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number }> {
    const dbRows = this.dao.findNodeTokenUsages(executionId)
    return dbRows.map(r => ({
      stepId: r.node_id, model: r.model,
      inputTokens: r.input_tokens, outputTokens: r.output_tokens,
      cacheReadTokens: r.cache_read_tokens ?? 0, cacheCreationTokens: r.cache_creation_tokens ?? 0,
    }))
  }

  getTokenUsagesForExecution(executionId: string): Array<{ model: string; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number }> {
    const perStep = this.getTokenUsagesPerStep(executionId)
    const modelTotals = new Map<string, { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number }>()
    for (const entry of perStep) {
      const existing = modelTotals.get(entry.model)
      if (existing) {
        modelTotals.set(entry.model, {
          inputTokens: existing.inputTokens + entry.inputTokens,
          outputTokens: existing.outputTokens + entry.outputTokens,
          cacheReadTokens: existing.cacheReadTokens + (entry.cacheReadTokens ?? 0),
          cacheCreationTokens: existing.cacheCreationTokens + (entry.cacheCreationTokens ?? 0),
        })
      } else {
        modelTotals.set(entry.model, {
          inputTokens: entry.inputTokens, outputTokens: entry.outputTokens,
          cacheReadTokens: entry.cacheReadTokens ?? 0, cacheCreationTokens: entry.cacheCreationTokens ?? 0,
        })
      }
    }
    return Array.from(modelTotals.entries())
      .map(([model, totals]) => ({ model, ...totals }))
      .filter(u => u.inputTokens > 0 || u.outputTokens > 0)
  }
}
