// packages/server/src/services/execution/RecoveryManager.ts
import type { ExecutionDAO } from "../../db/dao/execution-dao"
import type { ExecutionLifecycle } from "./ExecutionLifecycle"
import type { HookDef, NodeDef } from "@octopus/shared"
import { parseWorkflow, VarPool, WorkflowRef } from "@octopus/shared"
import { BashExecutor, AgentExecutor, AgentNodeRunner } from "@octopus/engine"
import { getProvider } from "@octopus/providers"
import { join } from "path"
import { existsSync, readFileSync } from "fs"

export class RecoveryManager {
  constructor(
    private dao: ExecutionDAO,
    private lifecycle?: ExecutionLifecycle,
  ) {}

  static async consumePendingHooks(dao: ExecutionDAO): Promise<void> {
    const rows = await dao.findPendingHooksExecutions()
    if (rows.length === 0) return

    process.stderr.write(`[ExecutionService] Consuming pending hooks for ${rows.length} execution(s)\n`)

    for (const row of rows) {
      try {
        let hooks: HookDef[]
        try {
          hooks = JSON.parse(row.pending_hooks) as HookDef[]
        } catch {
          process.stderr.write(`[ExecutionService] Malformed pending_hooks JSON for ${row.id}, clearing\n`)
          await dao.updateExecution(row.id, { pending_hooks: "[]" })
          continue
        }
        const workspacePath = row.workspace_path.replace(/^~/, process.env.HOME || process.env.USERPROFILE || "~")

        const exec = await dao.findById(row.id)
        let poolSnapshot: Record<string, string> = {}
        if (exec?.var_pool) {
          try { poolSnapshot = JSON.parse(exec.var_pool) } catch { /* use empty pool */ }
        }

        for (const hook of hooks) {
          if (hook.type === "bash" || hook.bash) {
            try {
              const pool = new VarPool({ ...poolSnapshot })
              const bashNode: NodeDef = {
                id: hook.id ?? `hook-pending-bash-${Date.now()}`,
                type: "bash", bash: hook.bash!, timeout: hook.timeout ?? 60,
              }
              const executor = new BashExecutor(bashNode, pool, {
                onLog: (line, stream) => {
                  const label = `[Hook:${hook.id ?? "pending-bash"}${stream === "stderr" ? ":err" : ""}]`
                  process.stderr.write(`${label} ${line}\n`)
                },
                cwd: workspacePath,
              })
              await executor.execute()
            } catch (err: unknown) {
              const msg = err instanceof Error ? err.message : String(err)
              process.stderr.write(`[Hook] pending bash hook ${hook.id ?? "anonymous"} failed: ${msg}\n`)
            }
          } else if (hook.type === "agent" || hook.prompt) {
            try {
              const pool = new VarPool({ ...poolSnapshot })
              const provider = getProvider("claude")
              const agentNode: NodeDef = {
                id: hook.id ?? `hook-pending-agent-${Date.now()}`,
                type: "agent", prompt: hook.prompt!, timeout: hook.timeout ?? 120,
              }
              const runner = new AgentNodeRunner(provider, workspacePath)
              const executor = new AgentExecutor(agentNode, pool, { runner })
              await executor.execute()
            } catch (err: unknown) {
              const msg = err instanceof Error ? err.message : String(err)
              process.stderr.write(`[Hook] pending agent hook ${hook.id ?? "anonymous"} failed: ${msg}\n`)
            }
          }
        }

        await dao.updateExecution(row.id, { pending_hooks: "[]" })
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        process.stderr.write(`[ExecutionService] Failed to consume pending hooks for ${row.id}: ${msg}\n`)
      }
    }
  }

  static async recoverInterruptedExecutions(dao: ExecutionDAO): Promise<void> {
    const STALE_THRESHOLD_MS = 10 * 60 * 1000
    const now = new Date()
    const nowISO = now.toISOString()
    const staleCutoff = new Date(now.getTime() - STALE_THRESHOLD_MS).toISOString()

    const runningExecs = await dao.findRunningExecutionIds()

    const staleExecs = await dao.findStaleRunningExecutions(staleCutoff)
    for (const exec of staleExecs) {
      let config: any = {}
      try { config = JSON.parse(exec.pipeline_config || "{}") } catch { /* ignore */ }
      const isAutoResume = config?.execution?.resume_on_interrupt === "auto"
      if (isAutoResume) {
        await dao.updateExecution(exec.id, { status: "pending_resume" })
        console.log(`[Recovery] Stale execution ${exec.id} (last updated: ${exec.updated_at}) → pending_resume (auto-resume)`)
      } else {
        await dao.updateExecution(exec.id, { status: "failed", completed_at: nowISO })
        await dao.updateNodeExecutionsByStatus(exec.id, "failed", ["running", "pending"], { error: "服务重启中断（运行超过10分钟）" })
        console.log(`[Recovery] Stale execution ${exec.id} (last updated: ${exec.updated_at}) → failed`)
      }
    }

    const recentExecs = await dao.findRecentRunningExecutions(staleCutoff)
    for (const exec of recentExecs) {
      let config: any = {}
      try { config = JSON.parse(exec.pipeline_config || "{}") } catch { /* ignore */ }
      const isAutoResume = config?.execution?.resume_on_interrupt === "auto"
      if (isAutoResume) {
        await dao.updateExecution(exec.id, { status: "pending_resume" })
        console.log(`[Recovery] Recent execution ${exec.id} (last updated: ${exec.updated_at}) → pending_resume (auto-resume)`)
      } else {
        await dao.updateExecution(exec.id, { status: "failed", completed_at: nowISO })
        await dao.updateNodeExecutionsByStatus(exec.id, "failed", ["running", "pending"], { error: "服务重启中断" })
        console.log(`[Recovery] Recent execution ${exec.id} (last updated: ${exec.updated_at}) → failed`)
      }
    }

    const orphanCount = await dao.fixOrphanedNodes()

    const staleResumes = await dao.findPendingResumeExecutions()
    let expiredResumes = 0
    for (const exec of staleResumes) {
      let config: any = {}
      try { config = JSON.parse(exec.pipeline_config || "{}") } catch { /* ignore */ }
      const timeout = config?.execution?.pending_resume_timeout ?? 600
      if (Date.now() - new Date(exec.updated_at ?? 0).getTime() > timeout * 1000) {
        await dao.updateExecution(exec.id, { status: "failed", completed_at: nowISO })
        expiredResumes++
      }
    }

    const totalRecovered = staleExecs.length + recentExecs.length + orphanCount + expiredResumes
    if (totalRecovered > 0) {
      console.log(
        `[Recovery] ${staleExecs.length} stale + ${recentExecs.length} recent executions → failed/pending_resume, ` +
        `${orphanCount} orphaned nodes → failed, ` +
        `${expiredResumes} stale pending_resume → failed`
      )
    }

    // Execute on_interrupt hooks for recovered executions
    for (const exec of runningExecs) {
      try {
        const wsPath = await dao.findWorkspacePath(exec.workspace_id)
        if (!wsPath) continue

        const workspacePath = wsPath.replace(/^~/, process.env.HOME || process.env.USERPROFILE || "~")

        const stateDir = join(workspacePath, "state")
        const snapshotPath = join(stateDir, `${exec.id}-${WorkflowRef.sanitize(exec.workflow_ref)}`)
        let parsed: any = null

        if (existsSync(snapshotPath)) {
          try {
            const content = readFileSync(snapshotPath, "utf-8")
            parsed = parseWorkflow(content)
          } catch { /* skip */ }
        }

        if (!parsed) {
          const wfPath = WorkflowRef.toPath(join(workspacePath, "workflows"), exec.workflow_ref)
          if (existsSync(wfPath)) {
            try {
              const content = readFileSync(wfPath, "utf-8")
              parsed = parseWorkflow(content)
            } catch { /* skip */ }
          }
        }

        if (!parsed) continue

        const interruptHooks = parsed.hooks?.on_interrupt
        if (!interruptHooks || interruptHooks.length === 0) continue

        const execRow = await dao.findById(exec.id)
        const poolSnapshot: Record<string, string> = (() => {
          try { return JSON.parse(execRow?.var_pool || "{}") } catch { return {} }
        })()

        const hookVars: Record<string, string> = {
          "hook.event": "interrupt", "hook.workflow_name": parsed.name ?? "",
          "hook.execution_id": exec.id, "hook.timestamp": new Date().toISOString(),
          "hook.last_status": "running", "hook.interrupt_reason": "服务重启中断",
        }

        const agentHooksToDefer: HookDef[] = []

        for (const hook of interruptHooks) {
          if (hook.type === "bash" || hook.bash) {
            try {
              const pool = new VarPool({ ...poolSnapshot })
              pool.update(hookVars)
              const bashNode: NodeDef = {
                id: hook.id ?? `hook-interrupt-bash-${Date.now()}`,
                type: "bash", bash: hook.bash!, timeout: hook.timeout ?? 60,
              }
              const executor = new BashExecutor(bashNode, pool, {
                onLog: (line, stream) => {
                  const label = `[Hook:${hook.id ?? "interrupt-bash"}${stream === "stderr" ? ":err" : ""}]`
                  process.stderr.write(`${label} ${line}\n`)
                },
                cwd: workspacePath,
              })
              executor.execute().catch((err: unknown) => {
                const msg = err instanceof Error ? err.message : String(err)
                process.stderr.write(`[Hook] on_interrupt/${hook.id ?? "anonymous"} failed during recovery: ${msg}\n`)
              })
            } catch (err: unknown) {
              const msg = err instanceof Error ? err.message : String(err)
              process.stderr.write(`[Hook] on_interrupt/${hook.id ?? "anonymous"} failed during recovery: ${msg}\n`)
            }
          } else {
            agentHooksToDefer.push(hook)
          }
        }

        if (agentHooksToDefer.length > 0) {
          await dao.updateExecution(exec.id, { pending_hooks: JSON.stringify(agentHooksToDefer) })
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        process.stderr.write(`[Recovery] on_interrupt hooks failed for ${exec.id}: ${msg}\n`)
      }
    }
  }

  static async resumePendingExecutions(dao: ExecutionDAO): Promise<void> {
    const pending = await dao.findPendingResumeExecutions()
    if (pending.length === 0) return
    console.log(`[Recovery] Found ${pending.length} execution(s) pending auto-resume`)

    for (const exec of pending) {
      let config: any = {}
      try { config = JSON.parse(exec.pipeline_config || "{}") } catch { /* ignore */ }

      const maxAttempts = config?.execution?.auto_resume_max_attempts ?? 3

      if (exec.resume_attempts >= maxAttempts) {
        await dao.updateExecution(exec.id, { status: "failed" })
        console.log(`[Recovery] ${exec.id} exceeded max resume attempts → failed`)
        continue
      }

      await dao.incrementResumeAttempts(exec.id)

      const delay = (config?.execution?.auto_resume_delay ?? 10) * 1000
      const execId = exec.id
      const timer = setTimeout(() => {
        ;(process as any).emit("octopus:resume-execution", execId)
      }, delay)
      timer.unref()
    }
  }
}
