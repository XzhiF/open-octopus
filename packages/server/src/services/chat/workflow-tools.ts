import { z } from "zod"
import { createSdkMcpServer, tool } from "@octopus/providers"
import { BuiltInWorkflowService } from "../builtin-workflow"
import { WorkflowService } from "../workflow"
import { getResourceRegistry } from "../resource-registry"
import { getExecutionService } from "../execution-service-registry"
import { createRepairServiceForWorkspace } from "../../routes/repair"
import { getChatEventBridge } from "../activity/chat-event-bridge"
import { selectReleasedWorkflows } from "./workflow-release"

/**
 * In-process MCP tools that let a chat agent run and inspect workflows in its
 * bound workspace. Execution goes through the normal ExecutionService, so
 * safety interception / workspace boundaries / agent events are unchanged.
 */
export function createWorkflowToolServer(
  workspaceId: string,
  owner?: { sessionId: string; org: string },
) {
  const workflowService = new WorkflowService()

  const resolveExec = (workspaceId: string) => {
    const registry = getExecutionService(workspaceId)
    if (!registry) throw new Error(`workspace ${workspaceId} not available`)
    return registry
  }

  const listWorkflows = async () => {
    const registry = resolveExec(workspaceId)
    const local = workflowService.list(registry.wsPath)
    const builtIn = new BuiltInWorkflowService(getResourceRegistry().get()).list()
    return selectReleasedWorkflows(local, builtIn)
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

  const text = (data: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  })

  const tools = [
    tool(
      "list_workflows",
      "List released workflows available in the current chat workspace (workspace + built-in). Snapshots (unreleased/dev) are hidden. Each item carries its numeric version when declared.",
      {},
      async () => text(await listWorkflows()),
    ),
    tool(
      "run_workflow",
      "Run a released workflow in the current chat workspace and return its execution id. Workflow execution is automatic (no confirmation step). Snapshot workflows cannot be run from the main chat.",
      {
        workflow_ref: z.string().min(1).describe("Workflow ref from list_workflows (e.g. built-in/matt-spec-dev or a workspace yaml)"),
        input_values: z.record(z.string()).optional().describe("Workflow inputs (key/value strings)"),
      },
      async ({ workflow_ref, input_values }) => {
        if (isSnapshotRef(workflow_ref)) {
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
  ]

  return createSdkMcpServer({
    name: "octopus-workflow",
    version: "1.0.0",
    instructions:
      "Use these tools to inspect and run workflows in the current workspace. Workflows execute automatically; use get_execution/list_executions to follow progress.",
    tools,
    alwaysLoad: true,
  })
}
