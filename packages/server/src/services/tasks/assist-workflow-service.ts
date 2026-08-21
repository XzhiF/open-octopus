// packages/server/src/services/tasks/assist-workflow-service.ts
//
// AssistWorkflowService — 编写期辅助工作流执行宿主 (D9/D16/D19, ticket 07).
//
// Supports two trigger modes:
//   1. Legacy template-based: template is one of the 3 built-in YAML names.
//      The ExecutionService resolves the workflow via BuiltInWorkflowService.
//   2. Dynamic (new): template = "dynamic-moa-analysis", input carries
//      mode (moa|debate), experts[{agent, engine, model}], aggregator?, rounds?.
//      The service generates a YAML workflow definition, writes it to the task
//      home, and uses ExecutionService to run it. This allows the user to pick
//      which agents, engines, and models participate in the analysis.
//
// Lifecycle:
//   trigger(taskId, template, input?) → writes dynamic YAML (if dynamic mode)
//     → inserts temp workspace row → obtains ExecutionService → create + start
//     → onComplete callback reaps workspace + writes md artifact.
//   getRun(taskId, runId) → reads execution row + swarm node outputs.
//
// run_id === execution_id (no new DB schema change).

import type Database from "better-sqlite3"
import { randomUUID } from "crypto"
import path from "path"
import os from "os"
import { readdirSync, readFileSync, existsSync, writeFileSync, mkdirSync } from "fs"
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

export { ASSIST_RUN_UPDATE_EVENT }

/** Legacy built-in template ids (AC3 whitelist). */
export const ASSIST_WORKFLOW_TEMPLATES = [
  "moa-requirements-review",
  "spec-review-swarm",
  "clarify-debate",
] as const
export type AssistWorkflowTemplate = (typeof ASSIST_WORKFLOW_TEMPLATES)[number]

/** The dynamic template id — triggers dynamic workflow generation instead of
 *  loading a pre-built YAML. */
const DYNAMIC_TEMPLATE = "dynamic-moa-analysis"

/** All valid templates (legacy + dynamic). */
const ALL_TEMPLATES = [...ASSIST_WORKFLOW_TEMPLATES, DYNAMIC_TEMPLATE]

/** Where installed agents live (agency-agents-zh package). */
const AGENTS_BASE = path.join(os.homedir(), ".octopus", "resources", "installed", "agents", "agency-agents-zh")

export class AssistWorkflowError extends Error {
  constructor(
    message: string,
    public readonly code: "INVALID_TEMPLATE" | "TASK_NOT_FOUND" | "RUN_NOT_FOUND" | "RUN_MISMATCH",
  ) {
    super(message)
    this.name = "AssistWorkflowError"
  }
}

const SWARM_NODE_ID = "panel"

// ── Input types ──────────────────────────────────────────────────

export interface AssistWorkflowTriggerInput {
  goal?: string
  ac?: string[]
  projects?: string[]
  userInput?: string
  /** "moa" (parallel + aggregate) or "debate" (multi-round argue). */
  mode?: "moa" | "debate"
  /** Expert rows: each = { agent id, engine, model }. Min 2. */
  experts?: Array<{ agent: string; engine: string; model: string }>
  /** Aggregator config (MoA mode only). */
  aggregator?: { engine?: string; model: string }
  /** Max debate rounds (Debate mode only, default 3). */
  rounds?: number
}

export interface AssistWorkflowTriggerResult {
  run_id: string
  execution_id: string
  workspace_id: string
  template: string
}

// ── Service ──────────────────────────────────────────────────────

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

  trigger(
    taskId: string,
    template: string,
    input?: AssistWorkflowTriggerInput,
  ): AssistWorkflowTriggerResult {
    if (!ALL_TEMPLATES.includes(template)) {
      throw new AssistWorkflowError(
        `Unknown assist-workflow template: ${template}. Allowed: ${ALL_TEMPLATES.join(", ")}`,
        "INVALID_TEMPLATE",
      )
    }

    const task = this.taskDAO.getById(taskId)
    if (!task) {
      throw new AssistWorkflowError(`Task not found: ${taskId}`, "TASK_NOT_FOUND")
    }

    const taskSpec = safeParseJson(task.task_spec) as Record<string, unknown> | null
    const inputValues = this.buildInputValues(task, taskSpec, input)

    // For dynamic mode: generate workflow YAML and write to task home
    let effectiveTemplate = template
    if (template === DYNAMIC_TEMPLATE) {
      effectiveTemplate = this.generateDynamicWorkflow(taskId, input, inputValues)
    }

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

    const registry = getExecutionService(workspaceId)
    if (!registry) {
      this.workspaceDAO.deleteById(workspaceId)
      throw new Error(`ExecutionService unavailable for assist workspace ${workspaceId}`)
    }

    const execution = registry.service.create(workspaceId, {
      workflow_ref: effectiveTemplate,
      name: `assist-${template}`,
      triggered_by: "task-assist",
      input_values: inputValues,
    })

    this.execDAO.updateExecution(execution.id, {
      pipeline_config: JSON.stringify({ task_id: taskId, template }),
    })

    const execId = execution.id
    const capturedInput = inputValues
    const capturedTask = task
    const capturedMode = input?.mode ?? "moa"
    registry.service.registerExternalCallbacks(
      {
        onComplete: ((_args?: unknown) => {
          this.reapWorkspace(workspaceId)
          this.emitRunUpdate(taskId, execId, "complete")
          try {
            this.writeAnalysisArtifact(taskId, execId, capturedTask, capturedInput, capturedMode)
          } catch (err: unknown) {
            // eslint-disable-next-line no-console
            console.warn(
              `[assist-workflow] writeAnalysisArtifact failed for ${execId} (non-fatal):`,
              err instanceof Error ? err.message : String(err),
            )
          }
        }) as never,
        onError: ((_args?: unknown) => {
          this.reapWorkspace(workspaceId)
          this.emitRunUpdate(taskId, execId, "error")
        }) as never,
      },
      execution.id,
    )

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

  getRun(taskId: string, runId: string): AssistWorkflowRun {
    const exec = this.execDAO.findById(runId)
    if (!exec) {
      throw new AssistWorkflowError(`Assist run not found: ${runId}`, "RUN_NOT_FOUND")
    }
    const config = safeParseJson(exec.pipeline_config) as { task_id?: string; template?: string } | null
    if (config?.task_id !== taskId) {
      throw new AssistWorkflowError(
        `Assist run ${runId} does not belong to task ${taskId}`,
        "RUN_MISMATCH",
      )
    }
    const template = config.template ?? ""

    const homePath = this.taskHome.homePath(taskId)
    const logs = this.readLogs(homePath, runId)

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

  listRuns(taskId: string): AssistWorkflowRun[] {
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
        // Stale/inconsistent row — skip
      }
    }
    return runs
  }

  // ── Reap (AC6) ───────────────────────────────────────────────────

  reapWorkspace(workspaceId: string): void {
    try {
      this.workspaceDAO.deleteById(workspaceId)
    } catch (err: unknown) {
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

  // ── Dynamic workflow generation ──────────────────────────────────

  /** Generate a workflow YAML for the dynamic MoA/Debate mode. Writes it to
   *  `{homePath}/workflows/{name}.yaml` and returns the workflow name which
   *  WorkflowService.get resolves from the workspace's workflows/ directory. */
  private generateDynamicWorkflow(
    taskId: string,
    input: AssistWorkflowTriggerInput | undefined,
    inputValues: Record<string, unknown>,
  ): string {
    const mode = input?.mode ?? "moa"
    const experts = input?.experts ?? []
    const goal = (inputValues.goal as string) || ""
    const ac = (inputValues.ac as string) || ""
    const projects = (inputValues.projects as string) || ""

    const topic = `评审任务需求：goal=${goal}；验收标准=${ac}；涉及项目=${projects}`

    // Build experts YAML
    const expertLines = experts.map((e) => {
      const agentPath = this.resolveAgentPath(e.agent)
      const lines = [
        `      - role: "${yamlEscape(e.agent)}"`,
      ]
      if (agentPath) {
        lines.push(`        agent_file: "${yamlEscape(agentPath)}"`)
      }
      lines.push(`        engine: "${e.engine}"`)
      lines.push(`        model: "${e.model}"`)
      return lines.join("\n")
    })

    // Build swarm node
    let swarmNode: string
    if (mode === "moa") {
      const aggEngine = input?.aggregator?.engine ?? experts[0]?.engine ?? "claude"
      const aggModel = input?.aggregator?.model ?? "pro-max"
      swarmNode = [
        `  - id: panel`,
        `    type: swarm`,
        `    mode: moa`,
        `    topic: "${yamlEscape(topic)}"`,
        `    experts:`,
        ...expertLines.map((l) => l.split("\n")).flat(),
        `    aggregator:`,
        `      role: 需求综合者`,
        `      engine: "${aggEngine}"`,
        `      model: "${aggModel}"`,
        `      prompt: |`,
        `        汇总各专家意见，**只输出一个 JSON 对象**，不要 markdown 代码块、不要解释文字。结构：`,
        `        {"ac_candidates": ["候选验收标准1", ...], "suggestions": ["方案建议1", ...], "risks": ["风险提示1", ...]}`,
        `        ac_candidates = 应补充的验收标准；suggestions = 方案/集成建议；risks = 风险提示。`,
        `        如果 $vars.user_input 非空，请额外关注用户补充的问题和上下文。`,
      ].join("\n")
    } else {
      // debate mode
      const rounds = input?.rounds ?? 3
      swarmNode = [
        `  - id: panel`,
        `    type: swarm`,
        `    mode: debate`,
        `    topic: "${yamlEscape(topic)}"`,
        `    rounds: ${rounds}`,
        `    consensus_threshold: 0.7`,
        `    experts:`,
        ...expertLines.map((l) => l.split("\n")).flat(),
        `    host:`,
        `      role: 辩论综合者`,
        `      prompt: |`,
        `        汇总辩论结论，**只输出一个 JSON 对象**，不要 markdown 代码块。结构：`,
        `        {"synthesis": "综合分析...", "assessment": {"consensus_score": 0.0-1.0, "key_agreements": [...], "key_disagreements": [...], "should_continue": false, "confidence": 0.0-1.0}, "ac_candidates": [...], "suggestions": [...], "risks": [...]}`,
        `        如果 $vars.user_input 非空，请额外关注用户补充的问题。`,
      ].join("\n")
    }

    const yaml = [
      `apiVersion: octopus/v1`,
      `kind: Workflow`,
      `name: dynamic-moa-${taskId.slice(0, 8)}`,
      `description: "动态 MoA/Debate 分析"`,
      ``,
      `variables:`,
      `  goal: ""`,
      `  ac: ""`,
      `  projects: ""`,
      `  user_input: ""`,
      ``,
      `nodes:`,
      swarmNode,
      ``,
    ].join("\n")

    // Write to task home's workflows/ dir (where WorkflowService.get resolves from)
    const homePath = this.taskHome.homePath(taskId)
    const wfDir = path.join(homePath, "workflows")
    mkdirSync(wfDir, { recursive: true })
    const wfName = `dynamic-moa-${taskId.slice(0, 8)}`
    const wfPath = path.join(wfDir, `${wfName}.yaml`)
    writeFileSync(wfPath, yaml, "utf-8")

    return wfName
  }

  /** Resolve an agent id (e.g. "product-manager") to an absolute path to the
   *  agent's .md file in the installed agents directory. */
  private resolveAgentPath(agentId: string): string | null {
    const agentFile = path.join(AGENTS_BASE, agentId, `${agentId}.md`)
    if (existsSync(agentFile)) return agentFile
    // Fallback: try core-pack agents
    const corePackPath = path.join(os.homedir(), ".octopus", "resources", "installed", "agents", "core-pack", `${agentId}.md`)
    if (existsSync(corePackPath)) return corePackPath
    return null
  }

  // ── Artifact writing ─────────────────────────────────────────────

  /** Write the analysis report as a markdown artifact. Works for both MoA and
   *  Debate modes. */
  private writeAnalysisArtifact(
    taskId: string,
    executionId: string,
    task: { id: string; name: string; project_ids: string; task_spec: string },
    inputValues: Record<string, unknown>,
    mode: string,
  ): void {
    const nodeOutputs = this.execDAO.findNodeOutputs(executionId, SWARM_NODE_ID)
    const synthesis = typeof nodeOutputs?.synthesis === "string" ? nodeOutputs.synthesis : ""
    if (!synthesis) return

    const parsed = this.parseAggregatorOutput(synthesis)
    const taskSpec = safeParseJson(task.task_spec) as Record<string, unknown> | null
    const mdContent = this.buildReport(task, taskSpec, inputValues, parsed, synthesis, mode)

    const artifactsDir = this.taskHome.artifactsDir(taskId)
    mkdirSync(artifactsDir, { recursive: true })
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)
    const prefix = mode === "debate" ? "debate" : "moa"
    const filename = `${prefix}-review-${timestamp}.md`
    writeFileSync(path.join(artifactsDir, filename), mdContent, "utf-8")

    this.taskHome.writeArtifactEntry(taskId, {
      path: filename,
      by: DYNAMIC_TEMPLATE,
      title: `${mode === "debate" ? "Debate 辩论" : "MoA 评审"}报告 ${timestamp}`,
      external: false,
      updated_at: new Date().toISOString(),
    })
  }

  /** Build a markdown report for both MoA and Debate modes. */
  private buildReport(
    task: { name: string },
    taskSpec: Record<string, unknown> | null,
    inputValues: Record<string, unknown>,
    parsed: { ok: true; value: { ac_candidates: string[]; suggestions: string[]; risks: string[] } } | { ok: false },
    rawSynthesis: string,
    mode: string,
  ): string {
    const now = new Date().toISOString().replace("T", " ").slice(0, 19)
    const goal = (inputValues.goal as string) || ""
    const ac = (inputValues.ac as string) || ""
    const projects = (inputValues.projects as string) || ""
    const userInput = (inputValues.user_input as string) || ""
    const title = mode === "debate" ? "Debate 辩论报告" : "MoA 需求评审报告"

    const lines: string[] = [
      `# ${title}`,
      "",
      `> 生成时间: ${now}`,
      `> 任务: ${task.name}`,
      `> 模式: ${mode === "debate" ? "多轮辩论" : "多专家并行"}`,
      "",
      "## 评审输入",
      "",
    ]

    if (goal) lines.push(`- **目标**: ${goal}`)
    if (ac) {
      lines.push(`- **验收标准**:`)
      for (const line of ac.split("\n")) {
        if (line.trim()) lines.push(`  ${line}`)
      }
    }
    if (projects) lines.push(`- **涉及项目**: ${projects}`)
    if (userInput) lines.push(`- **补充上下文**: ${userInput}`)
    lines.push("")

    if (parsed.ok) {
      const { ac_candidates, suggestions, risks } = parsed.value

      if (ac_candidates.length > 0) {
        lines.push("## 验收标准建议", "")
        for (const item of ac_candidates) lines.push(`- [ ] ${item}`)
        lines.push("")
      }
      if (suggestions.length > 0) {
        lines.push("## 方案建议", "")
        for (const item of suggestions) lines.push(`- ${item}`)
        lines.push("")
      }
      if (risks.length > 0) {
        lines.push("## 风险提示", "")
        for (const item of risks) lines.push(`- ⚠️ ${item}`)
        lines.push("")
      }
      if (ac_candidates.length === 0 && suggestions.length === 0 && risks.length === 0) {
        lines.push("> 专家未提出额外建议。", "")
      }
    } else {
      lines.push("## 专家意见（原始输出）", "")
      lines.push(rawSynthesis)
      lines.push("")
    }

    return lines.join("\n")
  }

  // ── Legacy artifact (kept for backward compat with old templates) ─

  private writeMoaArtifact(
    taskId: string,
    executionId: string,
    task: { id: string; name: string; project_ids: string; task_spec: string },
    inputValues: Record<string, unknown>,
  ): void {
    this.writeAnalysisArtifact(taskId, executionId, task, inputValues, "moa")
  }

  // ── Internals ────────────────────────────────────────────────────

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

    const acText = ac.map((a) => `- ${a}`).join("\n")
    const projectsText = projects.map((p) => `- ${p}`).join("\n")

    return {
      goal,
      ac: acText,
      projects: projectsText,
      user_input: input?.userInput ?? "",
    }
  }

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

// ── Pure helpers ──────────────────────────────────────────────────

export function stripCodeFences(s: string): string {
  const trimmed = s.trim()
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  if (fenceMatch) return fenceMatch[1]
  return trimmed
}

export function mapLogEntry(
  entry: Record<string, unknown>,
): { t: string; icon: string; text: string } | null {
  const t = typeof entry.timestamp === "string" ? entry.timestamp : ""
  const event = typeof entry.event === "string" ? entry.event : ""
  const role = typeof entry.role === "string" ? entry.role : ""
  const status = typeof entry.status === "string" ? entry.status : ""

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

/** Escape a string for safe embedding in a YAML double-quoted value. */
function yamlEscape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")
}

export type { AssistWorkflowRun }
