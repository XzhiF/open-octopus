import { VarPool, substituteVars } from "@octopus/shared"
import type { NodeDef, CrossExecResolver } from "@octopus/shared"
import type { NodeExecutor, NodeExecutionResult, ApprovalMetadata } from "./types"

export class ApprovalExecutor implements NodeExecutor {
  constructor(
    private node: NodeDef,
    private pool: VarPool,
    private userChoice?: string,
    private userComment?: string,
    private signal?: AbortSignal,
    private loopContext?: Record<string, any>,
    private crossExecResolver?: CrossExecResolver,
    private executionId?: string,
  ) {}

  async execute(): Promise<NodeExecutionResult> {
    const start = Date.now()

    if (this.signal?.aborted) {
      return {
        outputs: {},
        status: "cancelled",
        durationMs: 0,
        logLines: ["Approval cancelled before execution"],
      }
    }

    if (this.userChoice) {
      const durationMs = Date.now() - start
      const isRejected = this.userChoice === "reject" || this.userChoice.endsWith("-reject")
      return {
        outputs: { decision: this.userChoice, comment: this.userComment ?? "" },
        status: isRejected ? "rejected" : "completed",
        durationMs,
        logLines: [`Approval decided: ${this.userChoice}${isRejected ? " (rejected)" : ""}`],
        decision: this.userChoice,
        comment: this.userComment,
      }
    }

    const logLines = ["Approval node waiting for user input"]
    const timeout = this.node.approval_timeout ?? undefined
    if (timeout) {
      logLines.push(`Approval timeout: ${timeout}s`)
    }

    // Build approval metadata from node definition, resolving variables in prompt
    const rawPrompt = this.node.prompt || "需要审批确认"
    const resolvedPrompt = substituteVars(rawPrompt, this.pool, undefined, this.crossExecResolver, this.executionId, this.loopContext)
    const approvalMetadata: ApprovalMetadata = {
      prompt: resolvedPrompt,
      options: this.node.options || [
        { label: "同意", value: "approve" },
        { label: "拒绝", value: "reject" }
      ],
      nodeId: this.node.id
    }

    logLines.push(`Approval prompt: ${approvalMetadata.prompt}`)
    logLines.push(`Approval options: ${approvalMetadata.options.map(o => o.label).join(", ")}`)

    return {
      outputs: {},
      status: "pending_approval",
      durationMs: Date.now() - start,
      logLines,
      timeout,
      approvalMetadata,
    }
  }
}