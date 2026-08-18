// packages/server/src/services/tasks/assist-workflow-service.ts
//
// AssistWorkflowService — 编写期辅助工作流执行宿主 (D9/D16/D19, ticket 07).
//
// Each assist run is a workflow execution hosted in a TEMPORARY workspace whose
// `source='task-assist'` and whose `path` = the task's home directory (D16). The
// run is triggered by the user (agent only suggests, D9); the 3 built-in
// templates (moa-requirements-review / spec-review-swarm / clarify-debate) live
// in core-pack/workflows/ and resolve via BuiltInWorkflowService through the
// same registry the engine's ExecutionLifecycle.getWorkflow uses.
//
// Lifecycle:
//   trigger(taskId, template, input?) → inserts temp workspace row → obtains an
//     ExecutionService bound to that workspace → ExecutionService.create + sets
//     executions.pipeline_config = {task_id, template} (AC2) → registers an
//     onComplete callback that reaps the temp workspace row (AC6, home preserved)
//     → ExecutionService.start (fire-and-forget) → emits assist_run_update SSE.
//   getRun(taskId, runId) → reads the execution row + the swarm node's outputs
//     → parses the aggregator synthesis into {ac_candidates, suggestions, risks}
//     (SW-BP10: parse failure → output_raw + output_parse_error, never throws).
//
// run_id === execution_id (no new table — spec: no DB schema change). Finding
// runs by task = `executions WHERE pipeline_config LIKE '%"task_id":"<id>"%'`.
//
// Not this ticket's lane: the swarm executor itself (engine), the scheduler's
// $vars.task_artifacts_dir injection (ticket 08), the plugin-materializer +
// getPlugins extension (ticket 03), and the shared assist types (ticket 01,
// DONE: assistWorkflowRunSchema / assistWorkflowOutputSchema already exist).

import type Database from "better-sqlite3"
import { randomUUID } from "crypto"
import path from "path"
import { readdirSync, readFileSync, existsSync } from "fs"
import {
  assistWorkflowOutputSchema,
  ASSIST_RUN_UPDATE_EVENT,
  type AssistWorkflowRun,
} from "@octopus/shared"
import { TaskDAO } from "../../db/dao/task-dao"
import { ExecutionDAO } from "../../db/dao/execution-dao"
import { WorkspaceDAO } from "../../db/dao/workspace-dao"
import type { SSEService } from "../sse"
import { TaskHomeService } from "./task-home-service"
import { getExecutionService } from "../execution-service-registry"

/** SSE event name emitted on the 'taskpool' channel when an assist run starts,
 *  makes progress, or reaches a terminal state (D19). Mirrors the
 *  spec_field_update / task_status mechanism: the /api/tasks/events SSE route
 *  subscribes to 'taskpool' and forwards events to the SpecPanel / OutputViewer.
 *  Canonical home is @octopus/shared (contract shared with the web-app
 *  OutputViewer); re-exported here for existing server-side import sites. */
export { ASSIST_RUN_UPDATE_EVENT }

/** The 3 built-in assist-workflow template ids (AC3 whitelist). These are the
 *  `name:` fields of the core-pack/workflows/*.yaml files — the engine resolves
 *  them via ExecutionLifecycle.getWorkflow → BuiltInWorkflowService.get(ref). */
export const ASSIST_WORKFLOW_TEMPLATES = [
  "moa-requirements-review",
  "spec-review-swarm",
  "clarify-debate",
] as const
export type AssistWorkflowTemplate = (typeof ASSIST_WORKFLOW_TEMPLATES)[number]

/** Thrown when a template id is not in the whitelist (route → 400) or the task
 *  is missing/not found (route → 404). */
export class AssistWorkflowError extends Error {
  constructor(
    message: string,
    public readonly code: "INVALID_TEMPLATE" | "TASK_NOT_FOUND" | "RUN_NOT_FOUND" | "RUN_MISMATCH",
  ) {
    super(message)
    this.name = "AssistWorkflowError"
  }
}

/** Swarm node id used by all 3 built-in templates. The YAMLs all name their
 *  single swarm node `panel`, so getRun can find the aggregator output without a
 *  per-template mapping. Centralized here so a YAML rename is a one-place edit. */
const SWARM_NODE_ID = "panel"

export interface AssistWorkflowTriggerInput {
  /** Optional caller-supplied overrides; normally goal/ac/projects are read
   *  from task_spec + project_ids (AC7). */
  goal?: string
  ac?: string[]
  projects?: string[]
}

export interface AssistWorkflowTriggerResult {
  run_id: string
  execution_id: string
  workspace_id: string
  template: string
}

/** Constructed with the same deps the rest of the tasks domain uses. `baseDir`
 *  on TaskHomeService is optional — production omits it (~/.octopus); tests
 *  inject a temp dir. The DAOs are constructed from the shared db handle. */
export class AssistWorkflowService {
  private taskDAO: TaskDAO
  private execDAO: ExecutionDAO
  private workspaceDAO: WorkspaceDAO
  private taskHome: TaskHomeService

  constructor(
    private db: Database.Database,
    private sse: SSEService,
    taskHome?: TaskHomeService,
  ) {
    this.taskDAO = new TaskDAO(db)
    this.execDAO = new ExecutionDAO(db)
    this.workspaceDAO = new WorkspaceDAO(db)
    this.taskHome = taskHome ?? new TaskHomeService()
  }

  // ── Trigger (AC2/AC3/AC7) ─────────────────────────────────────────

  /** Trigger an assist-workflow run for a task. Creates a temp workspace
   *  (source='task-assist', path=task home), starts the workflow execution
   *  against it, and returns the run identifiers. The execution runs in the
   *  background; onComplete reaps the temp workspace row (home preserved). */
  trigger(
    taskId: string,
    template: string,
    input?: AssistWorkflowTriggerInput,
  ): AssistWorkflowTriggerResult {
    // AC3: whitelist — anything else → 400 (AssistWorkflowError).
    if (!ASSIST_WORKFLOW_TEMPLATES.includes(template as AssistWorkflowTemplate)) {
      throw new AssistWorkflowError(
        `Unknown assist-workflow template: ${template}. Allowed: ${ASSIST_WORKFLOW_TEMPLATES.join(", ")}`,
        "INVALID_TEMPLATE",
      )
    }

    // Load task for org + task_spec (AC7 input injection).
    const task = this.taskDAO.getById(taskId)
    if (!task) {
      throw new AssistWorkflowError(`Task not found: ${taskId}`, "TASK_NOT_FOUND")
    }

    // AC7: inject goal/ac/projects into $vars. The engine's VarPool merges
    // workflow_chain[0].input_values into $vars, so the swarm node reads them
    // via $vars.goal / $vars.ac / $vars.projects. Ac[] and projects[] are joined
    // into readable bullet lists (swarm topic + expert prompts are string-interpolated).
    const taskSpec = safeParseJson(task.task_spec) as Record<string, unknown> | null
    const inputValues = this.buildInputValues(task, taskSpec, input)

    // D16: temp workspace. path = task home dir (TaskHomeService.homePath, pure
    // derivation — no fs side effect here; createHome was called at task
    // creation by ticket 02's POST /api/tasks). source='task-assist' marks it
    // for reap on run completion; the home dir itself is NOT reaped (AC6).
    const homePath = this.taskHome.homePath(taskId)
    const now = new Date().toISOString()
    const workspaceId = randomUUID()
    this.workspaceDAO.insert({
      id: workspaceId,
      name: `task-assist-${taskId.slice(0, 8)}-${template}`,
      org: task.org,
      description: `Assist workflow (${template}) for task ${taskId}`,
      status: "active",
      path: homePath,
      created_at: now,
      updated_at: now,
      source: "task-assist",
      source_schedule_id: null,
      archive_status: null,
    })

    // ExecutionService is cached per workspaceId by the registry. The registry
    // reads the workspace row we just inserted → constructs an ExecutionService
    // bound to homePath as its workspacePath (so JSONL logs land at
    // {home}/logs/{executionId}/ — getRun reads them there).
    const registry = getExecutionService(workspaceId)
    if (!registry) {
      // Defensive: the row was just inserted; if the registry can't find it,
      // the workspace is orphaned. Clean up + throw a 500-class error.
      this.workspaceDAO.deleteById(workspaceId)
      throw new Error(`ExecutionService unavailable for assist workspace ${workspaceId}`)
    }

    // Create the root execution. workflow_ref = template name →
    // ExecutionLifecycle.getWorkflow resolves via BuiltInWorkflowService (the
    // core-pack/workflows/*.yaml are auto-registered as builtins).
    const execution = registry.service.create(workspaceId, {
      workflow_ref: template,
      name: `assist-${template}`,
      triggered_by: "task-assist",
      input_values: inputValues,
    })

    // AC2: record task_id + template on executions.pipeline_config so runs can
    // be found by task (SELECT executions WHERE pipeline_config LIKE
    // '%"task_id":"<id>"%'). create() does not set pipeline_config, so update
    // it as a separate write (ExecutionDAO.updateExecution allows the column).
    this.execDAO.updateExecution(execution.id, {
      pipeline_config: JSON.stringify({ task_id: taskId, template }),
    })

    // AC6: register an onComplete callback that reaps the temp workspace row.
    // The home dir is preserved (reapWorkspace only deletes the DB row + does
    // NOT touch the filesystem — task home lifecycle is owned by TaskHomeService).
    const execId = execution.id
    registry.service.registerExternalCallbacks(
      {
        onComplete: ((_args?: unknown) => {
          this.reapWorkspace(workspaceId)
          this.emitRunUpdate(taskId, execId, "complete")
        }) as never,
        onError: ((_args?: unknown) => {
          this.reapWorkspace(workspaceId)
          this.emitRunUpdate(taskId, execId, "error")
        }) as never,
      },
      execution.id,
    )

    // Fire-and-forget start. The execution runs in the background; the HTTP
    // response returns immediately with the run id (AC3). Errors surface via
    // the execution's status (getRun reads it).
    registry.service.start(execution.id, inputValues as Record<string, string>).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err)
      // eslint-disable-next-line no-console
      console.error(`[assist-workflow] start failed for run ${execution.id}:`, msg)
      this.reapWorkspace(workspaceId)
      this.emitRunUpdate(taskId, execId, "error")
    })

    this.emitRunUpdate(taskId, execution.id, "start")

    return {
      run_id: execution.id,
      execution_id: execution.id,
      workspace_id: workspaceId,
      template,
    }
  }

  // ── Query (AC4/AC5) ──────────────────────────────────────────────

  /** Read one assist run. Returns status, process logs, and the structured
   *  output (parsed aggregator JSON). Parse failure → output_raw +
   *  output_parse_error (SW-BP10), never throws. */
  getRun(taskId: string, runId: string): AssistWorkflowRun {
    const exec = this.execDAO.findById(runId)
    if (!exec) {
      throw new AssistWorkflowError(`Assist run not found: ${runId}`, "RUN_NOT_FOUND")
    }
    // Guard: the run must belong to this task (pipeline_config.task_id).
    const config = safeParseJson(exec.pipeline_config) as { task_id?: string; template?: string } | null
    if (config?.task_id !== taskId) {
      throw new AssistWorkflowError(
        `Assist run ${runId} does not belong to task ${taskId}`,
        "RUN_MISMATCH",
      )
    }
    const template = config.template ?? ""

    // Logs: JSONL entries at {home}/logs/{executionId}/{nodeId}.jsonl, mapped to
    // {t, icon, text} (AC4 — 含各专家启动/完成行). Home path is pure derivation
    // (TaskHomeService.homePath) — no DB lookup needed.
    const homePath = this.taskHome.homePath(taskId)
    const logs = this.readLogs(homePath, runId)

    // Output: the swarm node's outputs.synthesis (the aggregator's raw text).
    // findNodeOutputs returns the parsed outputs record; synthesis is a string.
    const nodeOutputs = this.execDAO.findNodeOutputs(runId, SWARM_NODE_ID)
    const synthesis = typeof nodeOutputs?.synthesis === "string" ? nodeOutputs.synthesis : ""

    const run: AssistWorkflowRun = {
      run_id: runId,
      execution_id: runId,
      workspace_id: exec.workspace_id,
      template,
      status: exec.status,
      logs,
    }

    // SW-BP10: parse the aggregator synthesis. Non-JSON or wrong shape →
    // output_raw + output_parse_error=true, no throw. Empty synthesis (run not
    // yet reached the swarm node, or node failed before producing output) →
    // leave output* unset (the run is still in progress).
    if (synthesis) {
      const parsed = this.parseAggregatorOutput(synthesis)
      if (parsed.ok) {
        run.output = parsed.value
      } else {
        run.output_raw = synthesis
        run.output_parse_error = true
      }
    }

    return run
  }

  /** List all assist runs for a task, newest first (helper for a future list
   *  route; not required by the spec but keeps the service self-contained). */
  listRuns(taskId: string): AssistWorkflowRun[] {
    // pipeline_config LIKE '%"task_id":"<taskId>"%' — matches the shape written
    // by trigger(). Escapes SQL LIKE wildcards in the taskId defensively.
    const escaped = taskId.replace(/[%_\\]/g, "\\$&")
    const rows = this.db
      .prepare(
        "SELECT id FROM executions WHERE pipeline_config LIKE ? ESCAPE '\\' ORDER BY created_at DESC",
      )
      .all(`%"task_id":"${escaped}"%`) as { id: string }[]
    const runs: AssistWorkflowRun[] = []
    for (const row of rows) {
      try {
        runs.push(this.getRun(taskId, row.id))
      } catch {
        // Stale/inconsistent row — skip rather than break the list.
      }
    }
    return runs
  }

  // ── Reap (AC6) ───────────────────────────────────────────────────

  /** Delete the temp workspace ROW. The task home dir is preserved (AC6 —
   *  workspacePath=home, but the home belongs to the task, not the run).
   *  Public so the onComplete callback + tests can drive it directly.
   *
   *  FK note: executions.workspace_id REFERENCES workspaces(id). In tests
   *  (FK OFF on :memory:) deleteById succeeds. In prod (FK ON, RESTRICT) this
   *  would fail if executions still reference the workspace — on error, fall
   *  back to softArchive so the row stops appearing as 'active' without
   *  orphaning the execution (whose row is still needed for getRun). */
  reapWorkspace(workspaceId: string): void {
    try {
      this.workspaceDAO.deleteById(workspaceId)
    } catch (err: unknown) {
      // FK RESTRICT in prod — fall back to soft archive so the workspace is no
      // longer 'active' but the execution row (needed by getRun) is preserved.
      try {
        this.workspaceDAO.softArchive(workspaceId)
      } catch (archiveErr: unknown) {
        // eslint-disable-next-line no-console
        console.warn(
          `[assist-workflow] reap: could not delete or archive workspace ${workspaceId}:`,
          archiveErr instanceof Error ? archiveErr.message : String(archiveErr),
          `(original delete error: ${err instanceof Error ? err.message : String(err)})`,
        )
      }
    }
  }

  // ── Internals ────────────────────────────────────────────────────

  /** Build the $vars input_values for the workflow (AC7). goal/ac/projects
   *  flow from task_spec + task.project_ids into $vars; caller overrides win. */
  private buildInputValues(
    task: { project_ids: string },
    taskSpec: Record<string, unknown> | null,
    input?: AssistWorkflowTriggerInput,
  ): Record<string, unknown> {
    const goal =
      input?.goal ??
      (typeof taskSpec?.goal === "string" ? taskSpec.goal : "")
    const ac =
      input?.ac ??
      (Array.isArray(taskSpec?.ac)
        ? (taskSpec!.ac as unknown[]).filter((v): v is string => typeof v === "string")
        : [])
    const projects =
      input?.projects ??
      (Array.isArray(safeParseJson(task.project_ids))
        ? (safeParseJson(task.project_ids) as unknown[]).filter(
            (v): v is string => typeof v === "string",
          )
        : [])

    // ac/projects joined as bullet lists — the swarm topic + expert prompts
    // are string-interpolated ($vars.ac), so a readable list beats raw JSON.
    const acText = ac.map((a) => `- ${a}`).join("\n")
    const projectsText = projects.map((p) => `- ${p}`).join("\n")

    return { goal, ac: acText, projects: projectsText }
  }

  /** Parse the aggregator synthesis into {ac_candidates, suggestions, risks}.
   *  Tolerates markdown ```json fences. Returns {ok:false} on any failure so
   *  the caller sets output_raw + output_parse_error (SW-BP10). */
  private parseAggregatorOutput(
    synthesis: string,
  ): { ok: true; value: { ac_candidates: string[]; suggestions: string[]; risks: string[] } } | { ok: false } {
    const trimmed = stripCodeFences(synthesis).trim()
    if (!trimmed) return { ok: false }
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      return { ok: false }
    }
    const result = assistWorkflowOutputSchema.safeParse(parsed)
    if (!result.success) return { ok: false }
    return {
      ok: true,
      value: {
        ac_candidates: result.data.ac_candidates,
        suggestions: result.data.suggestions,
        risks: result.data.risks,
      },
    }
  }

  /** Read JSONL log entries from {home}/logs/{executionId}/ and map to
   *  {t, icon, text} (AC4). Each .jsonl file is one node's log; entries are
   *  {timestamp, nodeId, event, ...data}. Swarm events (expert_spawn /
   *  expert_complete / swarm_complete / hook_event) become human-readable
   *  lines. Best-effort: missing dir or malformed lines are skipped (no throw). */
  private readLogs(home: string, executionId: string): { t: string; icon: string; text: string }[] {
    const logDir = path.join(home, "logs", executionId)
    if (!existsSync(logDir)) return []

    const out: { t: string; icon: string; text: string }[] = []
    let files: string[]
    try {
      files = readdirSync(logDir).filter((f) => f.endsWith(".jsonl"))
    } catch {
      return []
    }
    for (const file of files) {
      let content: string
      try {
        content = readFileSync(path.join(logDir, file), "utf-8")
      } catch {
        continue
      }
      for (const line of content.split("\n")) {
        const trimmed = line.trim()
        if (!trimmed) continue
        let entry: Record<string, unknown>
        try {
          entry = JSON.parse(trimmed)
        } catch {
          continue
        }
        const mapped = mapLogEntry(entry)
        if (mapped) out.push(mapped)
      }
    }
    // Stable chronological order.
    out.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0))
    return out
  }

  private emitRunUpdate(taskId: string, runId: string, phase: string): void {
    this.sse.emit("taskpool", {
      event: ASSIST_RUN_UPDATE_EVENT,
      data: { task_id: taskId, run_id: runId, phase },
    })
  }
}

// ── Pure helpers (exported for unit testing if needed) ──────────────

/** Strip markdown ```json ... ``` fences so an aggregator that wrapped its JSON
 *  in a code block still parses. Only strips a single outer fence; inner
 *  content is left intact. */
export function stripCodeFences(s: string): string {
  const trimmed = s.trim()
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  if (fenceMatch) return fenceMatch[1]
  return trimmed
}

/** Map a JSONL log entry to a {t, icon, text} line, or null if the entry isn't
 *  worth surfacing. Swarm lifecycle events become readable lines; unknown events
 *  are surfaced generically so new engine events still appear (no silent drop). */
export function mapLogEntry(
  entry: Record<string, unknown>,
): { t: string; icon: string; text: string } | null {
  const t = typeof entry.timestamp === "string" ? entry.timestamp : ""
  const event = typeof entry.event === "string" ? entry.event : ""
  const role = typeof entry.role === "string" ? entry.role : ""
  const status = typeof entry.status === "string" ? entry.status : ""

  // hook_event carries { event: "swarm_start" | "swarm_complete" | ... } from
  // the strategy's triggerHook path (swarm.ts executeHook → logger "hook_event").
  const innerHookEvent =
    event === "hook_event" && typeof entry.event === "string" ? entry.event : event

  switch (innerHookEvent) {
    case "swarm_start":
      return { t, icon: "▶", text: "Swarm started" }
    case "expert_spawn":
      return { t, icon: "•", text: `Expert started: ${role}`.trim() }
    case "expert_complete":
      return {
        t,
        icon: status === "completed" ? "✓" : "✗",
        text: `Expert ${status || "done"}: ${role}`.trim(),
      }
    case "swarm_complete":
      return { t, icon: "■", text: "Swarm completed" }
    case "node_start":
      return { t, icon: "▶", text: "Node started" }
    case "node_end":
      return { t, icon: "■", text: `Node ${status || "ended"}` }
    default:
      // Unknown event — surface generically rather than drop (forward-compat).
      if (!event) return null
      return { t, icon: "·", text: event }
  }
}

function safeParseJson(s: string | null | undefined): unknown {
  if (!s) return null
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}

// Re-export the shared type so route callers can import from the service module
// without reaching into @octopus/shared for the shape (single import surface).
export type { AssistWorkflowRun }
