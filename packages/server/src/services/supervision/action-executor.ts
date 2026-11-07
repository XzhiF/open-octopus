// ActionExecutor — the single place a supervision Decision becomes an effect.
//
// Two application paths share one decision vocabulary:
//   • in-hook   — a running engine is about to retry/fail; RuntimeSupervisor
//                 stashes a pending action the callback consumes.
//   • out-of-band — the execution is already paused/failed (chat resolved an
//                 incident minutes later); this executor drives the public
//                 ExecutionService / RepairService surface.
//
// No supervisor writes to the engine directly. Whitelist checks happen in
// RuntimeSupervisor before this runs.

import type { Decision } from "@octopus/shared"
import type { RepairService } from "../repair"
import type { ExecutionService } from "../execution"

export interface ExecutionEntryLike {
  service: ExecutionService
  wsPath: string
}

export interface ActionExecutorDeps {
  getExecutionService?: (workspaceId: string) => ExecutionEntryLike | undefined
  getRepairService?: (workspaceId: string) => RepairService | null
}

export interface ActionResult {
  ok: boolean
  /** Short human/agent-readable outcome. */
  detail: string
}

export class ActionExecutor {
  constructor(private deps: ActionExecutorDeps = {}) {}

  private execEntry(workspaceId: string): ExecutionEntryLike | null {
    if (this.deps.getExecutionService) {
      return this.deps.getExecutionService(workspaceId) ?? null
    }
    try {
      // Lazy require keeps this module importable in unit tests with no server.
      const { getExecutionService } = require("../execution-service-registry") as typeof import("../execution-service-registry")
      return getExecutionService(workspaceId) ?? null
    } catch {
      return null
    }
  }

  private repair(workspaceId: string): RepairService | null {
    if (this.deps.getRepairService) return this.deps.getRepairService(workspaceId)
    try {
      const { createRepairServiceForWorkspace } = require("../../routes/repair") as typeof import("../../routes/repair")
      return createRepairServiceForWorkspace(workspaceId)
    } catch {
      return null
    }
  }

  async apply(input: {
    executionId: string
    workspaceId: string
    nodeId: string
    decision: Decision
  }): Promise<ActionResult> {
    const { executionId, workspaceId, nodeId, decision } = input
    const entry = this.execEntry(workspaceId)
    if (!entry) return { ok: false, detail: `workspace ${workspaceId} 未注册执行服务` }
    const service = entry.service

    const exec = service.getById(executionId)
    if (!exec) return { ok: false, detail: `执行 ${executionId} 不存在` }

    const terminal = ["completed", "completed_with_failures", "cancelled", "aborted", "rejected", "interrupted"]
    if (terminal.includes(exec.status) && decision.type !== "proceed") {
      return { ok: false, detail: `执行已结束（${exec.status}），无法应用 ${decision.type}` }
    }

    switch (decision.type) {
      case "proceed":
        return { ok: true, detail: "保持引擎默认行为" }

      case "inject":
        return this.resumeOrRetry(service, workspaceId, exec.status, executionId, nodeId, decision.message)

      case "retry": {
        if (decision.varPoolPatches && Object.keys(decision.varPoolPatches).length > 0) {
          const repair = this.repair(workspaceId)
          if (!repair) return { ok: false, detail: "修复服务不可用，无法写入变量" }
          repair.patchVarPool(executionId, decision.varPoolPatches)
        }
        const hint = decision.hint ?? (decision.model ? `换用模型 ${decision.model} 后重试` : undefined)
        // `retry` is a plain re-run from the node (patches already applied). The
        // engine's intervention path is reserved for `inject`, where the owner
        // explicitly hands the node an instruction.
        return this.resumeOrRetry(service, workspaceId, exec.status, executionId, nodeId, hint, {
          intervention: false,
        })
      }

      case "pause": {
        if (exec.status === "paused") return { ok: true, detail: "执行已在暂停中" }
        const result = await service.pause(executionId)
        return result.success
          ? { ok: true, detail: "执行已暂停" }
          : { ok: false, detail: result.error ?? "暂停失败" }
      }

      case "abort": {
        await service.cancel(executionId)
        return { ok: true, detail: "执行已中止" }
      }

      case "reload": {
        const repair = this.repair(workspaceId)
        if (!repair) return { ok: false, detail: "修复服务不可用，无法重载工作流" }
        try {
          const result = repair.reloadWorkflow(executionId, decision.yaml)
          const diff = result.diff?.length ? `：${result.diff.join("; ")}` : ""
          // A reload only replaces the execution snapshot; the paused/failed
          // engine must be restarted to pick it up. Re-run the node so the
          // decision actually moves the execution forward.
          if (exec.status === "paused" || exec.status === "failed") {
            const resumed = await this.resumeOrRetry(
              service, workspaceId, exec.status, executionId, nodeId, undefined,
              { intervention: false },
            )
            return {
              ok: resumed.ok,
              detail: `工作流已重载${diff}；${resumed.detail}`,
            }
          }
          return { ok: true, detail: `工作流已重载${diff}；运行中的执行将在下次重建时使用新定义` }
        } catch (err) {
          return { ok: false, detail: err instanceof Error ? err.message : String(err) }
        }
      }

      case "block":
        // Block needs an in-flight hook (skip + continueSubsequent). Out-of-band
        // there is no safe equivalent that preserves downstream semantics.
        return {
          ok: false,
          detail: "block 只能在执行仍运行、引擎 hook 可消费时生效；已暂停的执行请用 retry/inject/abort",
        }

      case "escalate":
        return { ok: false, detail: "escalate 由 RuntimeSupervisor 处理，不应到达 ActionExecutor" }

      default: {
        const exhaustive: never = decision
        return { ok: false, detail: `未知决策 ${JSON.stringify(exhaustive)}` }
      }
    }
  }

  private async resumeOrRetry(
    service: ExecutionService,
    workspaceId: string,
    status: string,
    executionId: string,
    nodeId: string,
    hint?: string,
    opts?: { intervention?: boolean },
  ): Promise<ActionResult> {
    const intervention = opts?.intervention === false ? undefined : hint
    try {
      if (status === "paused") {
        const result = await service.resume(executionId, intervention)
        if (result.success) {
          return { ok: true, detail: hint ? "已带指令恢复执行" : "执行已恢复" }
        }
        // A harness-delegate pause leaves the node `failed` and no `paused`
        // row, so resume() refuses. Recover through the retry path instead.
        if ((result.error ?? "").includes("未找到暂停节点")) {
          await service.retryPausedNode(executionId, nodeId, intervention)
          return { ok: true, detail: hint ? "已带指令重试暂停节点" : "已重试暂停节点" }
        }
        return { ok: false, detail: result.error ?? "恢复失败" }
      }
      if (status === "failed") {
        await service.retry(executionId, nodeId, undefined, intervention)
        return { ok: true, detail: hint ? "已带指令重试失败节点" : "已重试失败节点" }
      }
      if (status === "running") {
        // Engine is live and mid-flight: hand the instruction to the engine's
        // retryFrom path; the next hook consumes any stashed decision.
        const repair = this.repair(workspaceId)
        if (repair && intervention) {
          const result = await repair.intervene(executionId, nodeId, intervention)
          if (result.injected) return { ok: true, detail: "指令已注入运行中的节点" }
        }
        return {
          ok: true,
          detail: "执行仍在运行；决策已记录，引擎下一个 hook 会消费",
        }
      }
      return { ok: false, detail: `当前状态 ${status} 不支持该动作` }
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) }
    }
  }
}
