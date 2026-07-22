import { VarPool, substituteVarsFull, substituteVars, evaluateExpression } from "@octopus/shared"
import type { NodeDef, CrossExecResolver } from "@octopus/shared"
import type { NodeExecutor, NodeExecutionResult, ApprovalMetadata } from "./types"
import type { ApprovalConfig } from "./executor-config"
import { readFileSync, existsSync } from "fs"
import { resolve } from "path"

export class ApprovalExecutor implements NodeExecutor {
  private userChoice?: string
  private userComment?: string
  private signal?: AbortSignal
  private loopContext?: Record<string, any>
  private crossExecResolver?: CrossExecResolver
  private executionId?: string
  private nodeOutputs?: Record<string, Record<string, any>>
  private cwd?: string

  constructor(
    private node: NodeDef,
    private pool: VarPool,
    config?: ApprovalConfig,
  ) {
    this.userChoice = config?.userChoice
    this.userComment = config?.userComment
    this.signal = config?.signal
    this.loopContext = config?.loopContext
    this.crossExecResolver = config?.crossExecResolver
    this.executionId = config?.executionId
    this.nodeOutputs = config?.nodeOutputs
    this.cwd = config?.cwd
  }

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
      const outputs: Record<string, any> = {
        decision: this.userChoice,
        comment: this.userComment ?? "",
        last_output: this.userChoice,
      }
      // Apply outputs mapping (e.g. "$vars.current_guess": "$last_output")
      this.applyOutputsMapping(outputs)
      return {
        outputs,
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

    // Pre-process: resolve $file:path references by reading file contents directly.
    // This runs BEFORE substituteVarsFull so file paths can contain $vars references.
    let promptWithFiles = rawPrompt.replace(/\$file:([^\s\n]+)/g, (_match, rawPath: string) => {
      // Resolve variables in the path first (e.g. $vars.feature → "engine-init-sync")
      const resolvedPath = substituteVars(rawPath, this.pool, this.nodeOutputs, this.crossExecResolver, this.executionId, this.loopContext)
      const fullPath = this.cwd ? resolve(this.cwd, resolvedPath) : resolvedPath
      try {
        if (existsSync(fullPath)) {
          return readFileSync(fullPath, "utf8").trimEnd()
        }
        return `[file not found: ${resolvedPath}]`
      } catch {
        return `[error reading: ${resolvedPath}]`
      }
    })

    const resolvedPrompt = substituteVarsFull(promptWithFiles, this.pool, this.nodeOutputs, this.crossExecResolver, this.executionId, this.loopContext)
    const approvalMetadata: ApprovalMetadata = {
      prompt: resolvedPrompt,
      options: this.node.options || [
        { label: "同意", value: "approve" },
        { label: "拒绝", value: "reject" }
      ],
      nodeId: this.node.id,
      ...(this.node.comment_label ? { commentLabel: this.node.comment_label } : {}),
      ...(this.node.comment_placeholder ? { commentPlaceholder: this.node.comment_placeholder } : {}),
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

  private applyOutputsMapping(outputs: Record<string, any>) {
    if (!this.node.outputs) return
    for (const [key, expr] of Object.entries(this.node.outputs)) {
      const poolKey = key.startsWith("$vars.") ? key.slice(6) : key

      if (expr === "$last_output") {
        this.pool.set(poolKey, outputs.last_output)
        outputs[poolKey] = outputs.last_output
      } else if (expr.startsWith("$last_output.")) {
        const field = expr.slice(13)
        const value = outputs.last_output?.[field] ?? outputs[field]
        this.pool.set(poolKey, value)
        outputs[poolKey] = value
      } else if (/^\$vars\.\w+$/.test(expr)) {
        const varKey = expr.slice(6)
        this.pool.set(poolKey, this.pool.get(varKey))
        outputs[poolKey] = this.pool.get(varKey)
      } else if (expr.startsWith("$")) {
        const resolved = substituteVars(expr, this.pool, undefined, this.crossExecResolver, this.executionId)
        this.pool.set(poolKey, resolved)
        outputs[poolKey] = resolved
      } else {
        this.pool.set(poolKey, expr)
        outputs[poolKey] = expr
      }
    }
  }
}