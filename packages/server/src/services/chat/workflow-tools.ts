import { z } from "zod"
import { createSdkMcpServer, tool } from "@octopus/providers"
import { parseWorkflow, validateWorkflow } from "@octopus/shared"
import { BuiltInWorkflowService } from "../builtin-workflow"
import { WorkflowService } from "../workflow"
import { getResourceRegistry } from "../resource-registry"
import { getExecutionService } from "../execution-service-registry"
import { createRepairServiceForWorkspace } from "../../routes/repair"
import { getChatEventBridge } from "../activity/chat-event-bridge"
import { selectReleasedWorkflows } from "./workflow-release"
import { getWorkflowDevService } from "../tasks/workflow-dev-service"

/**
 * In-process MCP tools that let a chat agent run and inspect workflows in its
 * bound workspace. Execution goes through the normal ExecutionService, so
 * safety interception / workspace boundaries / agent events are unchanged.
 *
 * workflow-dev sessions (2026-11-06) get a wider surface: snapshots are
 * listable/runnable, authored task-home workflows are listed, and the
 * validate → simulate → run hard gate is enforced before a real run.
 */
export interface WorkflowToolOptions {
  /** Bound task (workflow-dev sessions only). */
  taskId?: string
  kind?: "workflow-dev"
}

export function createWorkflowToolServer(
  workspaceId: string,
  owner?: { sessionId: string; org: string },
  opts: WorkflowToolOptions = {},
) {
  const workflowService = new WorkflowService()
  const devService = opts.kind === "workflow-dev" && opts.taskId ? getWorkflowDevService() : null
  const isDev = !!devService && !!opts.taskId

  const resolveExec = (workspaceId: string) => {
    const registry = getExecutionService(workspaceId)
    if (!registry) throw new Error(`workspace ${workspaceId} not available`)
    return registry
  }

  const listWorkflows = async () => {
    const registry = resolveExec(workspaceId)
    const local = workflowService.list(registry.wsPath)
    const builtIn = new BuiltInWorkflowService(getResourceRegistry().get()).list()
    if (!isDev) return selectReleasedWorkflows(local, builtIn)
    // workflow-dev: everything is visible, including the task's authored YAMLs.
    const authored = (devService?.listFiles(opts.taskId!) ?? []).map((f) => ({
      ref: f.ref,
      name: f.name,
      description: f.description,
      version: f.version,
      stage: f.stage,
      group: "task-home",
    }))
    // Authored files are mirrored into the workspace workflows/ dir so they can
    // run; hide that duplicate from the listing (the task-home entry is truth).
    const authoredRefs = new Set(authored.map((f) => f.ref))
    return [...authored, ...local.filter((w) => !authoredRefs.has(w.ref)), ...builtIn]
  }

  /**
   * Resolve a ref the same way execution does (workspace first, then built-in)
   * and report whether it is not a released workflow. Unresolvable refs are left
   * to ExecutionService so the real "not found" error surfaces unchanged.
   */
  const isSnapshotRef = (ref: string): boolean => {
    const registry = resolveExec(workspaceId)
    const local = workflowService.get(registry.wsPath, ref)
    if (local) return (local.parsed.stage ?? "snapshot") !== "release"
    const builtIn = new BuiltInWorkflowService(getResourceRegistry().get()).get(ref)
    if (builtIn) return (builtIn.parsed.stage ?? "snapshot") !== "release"
    return false
  }

  /** Content lookup across task-home (dev only) → workspace → built-in. */
  const resolveContent = (ref: string): string | null => {
    if (isDev) {
      const authored = devService!.readFile(opts.taskId!, ref)
      if (authored !== null) return authored
    }
    const registry = resolveExec(workspaceId)
    const local = workflowService.get(registry.wsPath, ref)
    if (local) return local.content
    const builtIn = new BuiltInWorkflowService(getResourceRegistry().get()).get(ref)
    return builtIn?.content ?? null
  }

  const text = (data: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  })

  const describe = (ref: string, content: string) => {
    const parsed = parseWorkflow(content)
    return {
      ref,
      name: parsed.name,
      description: parsed.description,
      stage: parsed.stage ?? "snapshot",
      version: parsed.version,
      execution_mode: parsed.execution_mode,
      inputs: parsed.inputs ?? {},
      nodes: parsed.nodes.map((n) => ({
        id: n.id,
        type: n.type,
        depends_on: n.depends_on ?? [],
      })),
      content,
    }
  }

  const tools = [
    tool(
      "list_workflows",
      isDev
        ? "List workflows visible to this workflow-dev task: authored task-home YAMLs, workspace workflows, and built-in workflows. Snapshots are included. Each item carries description / stage / version and inputs so you can answer what each workflow does and when to use it."
        : "List released workflows available in the current chat workspace (workspace + built-in). Snapshots (unreleased/dev) are hidden. Each item carries its numeric version when declared.",
      {},
      async () => text(await listWorkflows()),
    ),
    tool(
      "get_workflow",
      "Read one workflow in full: YAML content plus parsed name / description / stage / version / execution mode / inputs / node list. Use it to explain an existing workflow's details and use cases before writing a new one.",
      {
        workflow_ref: z.string().min(1).describe("Workflow ref (e.g. built-in/matt-spec-dev, my-flow.yaml, or a task-home ref)"),
      },
      async ({ workflow_ref }) => {
        const content = resolveContent(workflow_ref)
        if (content === null) return text({ error: `workflow "${workflow_ref}" not found` })
        try {
          return text(describe(workflow_ref, content))
        } catch (err: unknown) {
          return text({ error: `workflow "${workflow_ref}" failed to parse: ${err instanceof Error ? err.message : String(err)}` })
        }
      },
    ),
    tool(
      "run_workflow",
      isDev
        ? "Run a workflow in the current chat workspace and return its execution id. Workflow-dev tasks may run snapshots; authored YAMLs must pass validation + simulation first unless the human explicitly asked for a waiver (pass waiver=<reason>). Execution is automatic (no confirmation step)."
        : "Run a released workflow in the current chat workspace and return its execution id. Workflow execution is automatic (no confirmation step). Snapshot workflows cannot be run from the main chat.",
      {
        workflow_ref: z.string().min(1).describe("Workflow ref from list_workflows (e.g. built-in/matt-spec-dev or a workspace yaml)"),
        input_values: z.record(z.string()).optional().describe("Workflow inputs (key/value strings)"),
        waiver: z
          .string()
          .optional()
          .describe("Workflow-dev only: reason the human explicitly waived the validate+simulate hard gate"),
      },
      async ({ workflow_ref, input_values, waiver }) => {
        if (isDev) {
          const authored = devService!.readFile(opts.taskId!, workflow_ref)
          if (authored !== null) {
            // Keep the workspace mirror current before the engine resolves it.
            devService!.syncToWorkspace(opts.taskId!, workflow_ref)
            const gate = devService!.canRun(opts.taskId!, workflow_ref, waiver)
            if (!gate.ok) return text({ error: gate.reason })
          }
        } else if (isSnapshotRef(workflow_ref)) {
          return text({
            error: `workflow "${workflow_ref}" is a snapshot, not a release — the main chat only runs released workflows. Ask a human to release it (set "stage: release" and a numeric "version" in its YAML) first.`,
          })
        }
        const registry = resolveExec(workspaceId)
        const exec = registry.service.create(workspaceId, {
          workflow_ref,
          input_values: input_values ?? {},
          triggered_by: "chat",
          // 消耗口径（2026-11-03）：主对话直接跑的工作流不属于任何任务，创建时
          // 带上 origin，ExecutionLifecycle 会在同一处落 execution_links —— 会话
          // 账本据此把它算进「这个 chat 关联的工作流」。将来其他 chat 代跑路径
          // 同样传 origin，不需要各自记得补登记。
          ...(owner ? { origin: { sessionId: owner.sessionId, kind: "chat_run" as const } } : {}),
        })
        if (owner) {
          getChatEventBridge().bindExecution(exec.id, {
            sessionId: owner.sessionId,
            org: owner.org,
            workspaceId,
            workflowRef: workflow_ref,
          })
        }
        await registry.service.start(exec.id, input_values ?? {})
        return text({ executionId: exec.id, workflow_ref, workspace_id: workspaceId, status: "running" })
      },
    ),
    tool(
      "validate_workflow",
      "Parse + semantic-validate a workflow YAML (shared parser). In a workflow-dev task this also records the result against the current file hash for the run gate.",
      {
        workflow_ref: z.string().min(1).optional().describe("Existing workflow ref to validate (defaults to the active authored workflow)"),
        yaml: z.string().optional().describe("Raw YAML to validate instead of reading a file"),
      },
      async ({ workflow_ref, yaml }) => {
        try {
          if (
            isDev &&
            (workflow_ref === undefined || devService!.readFile(opts.taskId!, workflow_ref) !== null)
          ) {
            // yaml-less validation records the result for the run gate; an
            // explicit body is a dry run (no state write).
            return text(devService!.validate(opts.taskId!, yaml, workflow_ref))
          }
          const ref = workflow_ref
          if (yaml === undefined) {
            if (!ref) return text({ error: "workflow_ref or yaml is required" })
            const content = resolveContent(ref)
            if (content === null) return text({ error: `workflow "${ref}" not found` })
            const wf = parseWorkflow(content)
            const { warnings } = validateWorkflow(wf)
            return text({ valid: true, errors: [], warnings })
          }
          const wf = parseWorkflow(yaml)
          const { warnings } = validateWorkflow(wf)
          return text({ valid: true, errors: [], warnings })
        } catch (err: unknown) {
          return text({ valid: false, errors: [err instanceof Error ? err.message : String(err)], warnings: [] })
        }
      },
    ),
    tool(
      "simulate_workflow",
      "Workflow-dev only. Run the current workflow's `<name>.test.yaml` fixture through the engine simulator (strict by default). Records the result against the file hash for the run gate.",
      {
        scenario: z.string().optional().describe("Run only this scenario name"),
        strict: z.boolean().optional().describe("Strict mode: fail on missing mocks (default true)"),
        real_execution: z.array(z.string()).optional().describe("Bash/Python node ids that should execute for real"),
      },
      async ({ scenario, strict, real_execution }) => {
        if (!isDev) return text({ error: "simulate_workflow is only available in workflow-dev tasks" })
        try {
          return text(await devService!.simulate(opts.taskId!, {
            scenario,
            strict,
            realExecution: real_execution,
          }))
        } catch (err: unknown) {
          return text({ error: err instanceof Error ? err.message : String(err) })
        }
      },
    ),
    tool(
      "list_executions",
      "List recent executions in the current chat workspace.",
      { limit: z.number().int().min(1).max(50).optional() },
      async ({ limit }) => {
        const registry = resolveExec(workspaceId)
        const rows = registry.service.list(workspaceId).slice(0, limit ?? 10)
        return text(rows.map((r) => ({
          executionId: r.id,
          workflow_ref: r.workflow_ref,
          status: r.status,
          progress: r.progress,
          started_at: r.started_at,
          completed_at: r.completed_at,
        })))
      },
    ),
    tool(
      "get_execution",
      "Get an execution's status and its node executions.",
      { execution_id: z.string().min(1) },
      async ({ execution_id }) => {
        const registry = resolveExec(workspaceId)
        const exec = registry.service.getById(execution_id)
        if (!exec) return text({ error: `execution ${execution_id} not found` })
        const steps = registry.service.getByIdWithSteps(execution_id)?.steps ?? []
        return text({
          executionId: exec.id,
          workflow_ref: exec.workflow_ref,
          status: exec.status,
          progress: exec.progress,
          steps: steps.map((s) => ({
            nodeId: s.node_id,
            status: s.status,
            startedAt: s.started_at,
            completedAt: s.completed_at,
            error: s.error,
          })),
        })
      },
    ),
    tool(
      "cancel_execution",
      "Cancel a running execution.",
      { execution_id: z.string().min(1) },
      async ({ execution_id }) => {
        const registry = resolveExec(workspaceId)
        const exec = await registry.service.cancel(execution_id)
        return text({ executionId: exec.id, status: exec.status })
      },
    ),
    tool(
      "pause_execution",
      "Pause a running execution at its currently running node.",
      { execution_id: z.string().min(1) },
      async ({ execution_id }) => {
        const registry = resolveExec(workspaceId)
        return text(await registry.service.pause(execution_id))
      },
    ),
    tool(
      "resume_execution",
      "Resume a paused execution, optionally injecting an intervention message for the paused node.",
      {
        execution_id: z.string().min(1),
        intervention: z.string().optional().describe("Instruction to give the paused node when it resumes"),
      },
      async ({ execution_id, intervention }) => {
        const registry = resolveExec(workspaceId)
        return text(await registry.service.resume(execution_id, intervention))
      },
    ),
    tool(
      "respond_approval",
      "Answer a pending approval/interaction node in an execution.",
      {
        execution_id: z.string().min(1),
        node_id: z.string().min(1),
        answer: z.string().min(1),
        comment: z.string().optional(),
      },
      async ({ execution_id, node_id, answer, comment }) => {
        const registry = resolveExec(workspaceId)
        const exec = await registry.service.approve(execution_id, node_id, answer, comment)
        return text({ executionId: exec.id, status: exec.status })
      },
    ),
    tool(
      "retry_node",
      "Retry a failed node in an execution.",
      {
        execution_id: z.string().min(1),
        node_id: z.string().min(1),
        intervention: z.string().optional(),
      },
      async ({ execution_id, node_id, intervention }) => {
        const registry = resolveExec(workspaceId)
        const exec = await registry.service.retry(execution_id, node_id, undefined, intervention)
        return text({ executionId: exec.id, status: exec.status })
      },
    ),
    tool(
      "rerun_execution",
      "Rerun a TERMINAL execution (failed/cancelled/aborted/completed) with a FRESH start: resets the first failed node and everything downstream to pending, clears synthetic nodes, then launches the engine from scratch like a manual trigger (started_at resets, reaper clock restarts). Use this when retry_node refuses because the execution already ended; startup-level failures (engine init) rerun the whole flow from node one. For a single failed node inside a still-running execution, prefer retry_node.",
      {
        execution_id: z.string().min(1),
        reset_var_pool: z.boolean().optional().describe("Also roll the variable pool back to the restore point's checkpoint (default: keep current pool)"),
      },
      async ({ execution_id, reset_var_pool }) => {
        const service = createRepairServiceForWorkspace(workspaceId)
        if (!service) return text({ error: "repair service unavailable for this workspace" })
        return text(await service.rerun(execution_id, { resetVarPool: reset_var_pool }))
      },
    ),
    tool(
      "diagnose_execution",
      "Diagnose a failed execution: root cause, failed node, suggested actions. Use this before changing the YAML — explain the cause to the human first.",
      { execution_id: z.string().min(1) },
      async ({ execution_id }) => {
        const service = createRepairServiceForWorkspace(workspaceId)
        if (!service) return text({ error: "repair service unavailable for this workspace" })
        try {
          return text(service.diagnose(execution_id))
        } catch (err: unknown) {
          return text({ error: err instanceof Error ? err.message : String(err) })
        }
      },
    ),
    tool(
      "reset_execution_node",
      "Reset one node execution to pending (re-run) or completed (manually accept its outputs).",
      {
        execution_id: z.string().min(1),
        node_id: z.string().min(1),
        status: z.enum(["pending", "completed"]),
        outputs: z.record(z.unknown()).optional().describe("For completed: output values to merge into the node"),
      },
      async ({ execution_id, node_id, status, outputs }) => {
        const service = createRepairServiceForWorkspace(workspaceId)
        if (!service) return text({ error: "repair service unavailable for this workspace" })
        try {
          return text(service.resetNode(execution_id, node_id, status, outputs))
        } catch (err: unknown) {
          return text({ error: err instanceof Error ? err.message : String(err) })
        }
      },
    ),
    tool(
      "reload_execution_workflow",
      "Replace a running/failed execution's workflow snapshot with new YAML (e.g. after fixing the definition). Returns the node diff. In workflow-dev the current authored file is used when content is omitted.",
      {
        execution_id: z.string().min(1),
        content: z.string().optional().describe("New workflow YAML (defaults to the active authored workflow in a workflow-dev task)"),
        workflow_ref: z.string().optional().describe("Authored ref to load when content is omitted"),
      },
      async ({ execution_id, content, workflow_ref }) => {
        const service = createRepairServiceForWorkspace(workspaceId)
        if (!service) return text({ error: "repair service unavailable for this workspace" })
        let yaml = content
        if (!yaml && isDev) {
          const ref = workflow_ref ?? devService!.getState(opts.taskId!).ref
          if (!ref) return text({ error: "no authored workflow to reload; pass content" })
          yaml = devService!.readFile(opts.taskId!, ref) ?? undefined
        }
        if (!yaml) return text({ error: "content is required" })
        try {
          return text(service.reloadWorkflow(execution_id, yaml))
        } catch (err: unknown) {
          return text({ error: err instanceof Error ? err.message : String(err) })
        }
      },
    ),
  ]

  return createSdkMcpServer({
    name: "octopus-workflow",
    version: "1.0.0",
    instructions:
      "Use these tools to inspect, author, run, and debug workflows in the current workspace. Workflows execute automatically; use get_execution/list_executions to follow progress. In workflow-dev tasks, validate + simulate before a real run unless the human explicitly waives it.",
    tools,
    alwaysLoad: true,
  })
}
