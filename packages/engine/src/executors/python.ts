import { spawn } from "child_process"
import { VarPool, substituteVars, substituteVarsFull, applyOutputsMapping } from "@octopus/shared"
import type { NodeDef } from "@octopus/shared"
import type { NodeExecutor, NodeExecutionResult } from "./types"
import type { PythonConfig } from "./executor-config"
import { applyVarsUpdate } from "./parse-vars-update"
import { buildHostEnv, killProcessTree, startForceKillChain } from "./process-isolation"

export class PythonExecutor implements NodeExecutor {
  private signal?: AbortSignal
  private onLog?: (line: string, stream?: "stdout" | "stderr") => void
  private nodeOutputs?: Record<string, Record<string, any>>

  constructor(
    private node: NodeDef,
    private pool: VarPool,
    config?: PythonConfig,
  ) {
    this.signal = config?.signal
    this.onLog = config?.onLog
    this.nodeOutputs = config?.nodeOutputs
  }

  async execute(): Promise<NodeExecutionResult> {
    if (this.signal?.aborted) {
      this.onLog?.("Execution cancelled before start", "stderr")
      return {
        outputs: {},
        status: "cancelled",
        durationMs: 0,
        logLines: ["Execution cancelled before start"],
      }
    }

    const start = Date.now()
    let script = substituteVarsFull(this.node.python!, this.pool, this.nodeOutputs)
    script = this.resolveInputs(script)
    const timeout = this.node.timeout ?? 60

    try {
      const result = await this.runPython(script, timeout)
      const durationMs = Date.now() - start

      if (result.exitCode !== 0) {
        this.onLog?.(`Python script failed with exit code ${result.exitCode}`, "stderr")
        return {
          lastOutput: result.stdout,
          exitCode: result.exitCode,
          outputs: {},
          status: "failed",
          durationMs,
          logLines: result.logLines,
        }
      }

      const outputs: Record<string, any> = {
        last_output: result.stdout,
        exit_code: result.exitCode,
      }

      this.applyVarsUpdate(result.stdout, outputs)
      this.applyOutputsMapping(outputs)

      const status = (outputs.__status === "failed") ? "failed" : "completed"
      this.onLog?.(status === "failed" ? "Python script requested failure via __status" : "Python script completed successfully")
      return {
        lastOutput: result.stdout,
        exitCode: result.exitCode,
        outputs,
        status,
        durationMs,
        logLines: result.logLines,
      }
    } catch (err: any) {
      const durationMs = Date.now() - start
      this.onLog?.(`Python script error: ${err.message ?? String(err)}`, "stderr")
      return {
        outputs: {},
        status: "failed",
        durationMs,
        logLines: [err.message ?? String(err)],
      }
    }
  }

  private resolveInputs(script: string): string {
    if (!this.node.inputs) return script
    let result = script
    for (const [key, expr] of Object.entries(this.node.inputs)) {
      const value = substituteVars(expr, this.pool)
      result = result.replaceAll(`__${key}__`, value)
    }
    return result
  }

  private applyVarsUpdate(stdout: string, outputs: Record<string, any>) {
    applyVarsUpdate(stdout, this.pool, outputs)
  }

  private applyOutputsMapping(outputs: Record<string, any>) {
    if (!this.node.outputs) return
    applyOutputsMapping(this.node.outputs, outputs, this.pool, outputs.last_output, outputs.exit_code)
  }

  private runPython(script: string, timeoutSec: number): Promise<{
    stdout: string
    stderr: string
    exitCode: number
    logLines: string[]
  }> {
    return new Promise((resolve, reject) => {
      if (this.signal?.aborted) {
        reject(new Error("Aborted"))
        return
      }
      // Merge VarPool string values into child env so os.environ["VAR_NAME"] works
      const env = buildHostEnv()
      for (const [k, v] of Object.entries(this.pool.snapshot())) {
        if (v != null && typeof v !== "object") {
          env[k] = String(v)
        }
      }

      const proc = spawn("python3", ["-c", script], {
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
        env,
      })

      let stdout = ""
      let stderr = ""
      const logLines: string[] = []
      let aborted = false
      // Track the force kill chain so we can cancel it when the process exits
      let killChain: { cancel: () => void } | null = null

      // Manual abort handler using process group kill (not proc.kill)
      const onAbort = () => {
        aborted = true
        if (proc.pid) {
          killProcessTree(proc.pid)
        }
      }

      this.signal?.addEventListener("abort", onAbort, { once: true })

      proc.stdout?.on("data", (data: Buffer) => {
        const chunk = data.toString()
        stdout += chunk
        for (const line of chunk.split("\n")) {
          if (line) {
            logLines.push(line)
            this.onLog?.(line, "stdout")
          }
        }
      })

      proc.stderr?.on("data", (data: Buffer) => {
        const chunk = data.toString()
        stderr += chunk
        for (const line of chunk.split("\n")) {
          if (line) {
            logLines.push(`[stderr] ${line}`)
            this.onLog?.(line, "stderr")
          }
        }
      })

      const timer = setTimeout(() => {
        // Timeout: use force kill chain (SIGTERM → 5s → SIGKILL)
        if (proc.pid) {
          killChain = startForceKillChain(proc.pid, 5000)
        }
        reject(new Error(`Timeout after ${timeoutSec}s`))
      }, timeoutSec * 1000)

      proc.on("close", (code: number | null) => {
        clearTimeout(timer)
        killChain?.cancel()
        this.signal?.removeEventListener("abort", onAbort)
        if (aborted) {
          reject(new Error("Aborted"))
        } else {
          resolve({
            stdout: stdout.trimEnd(),
            stderr: stderr.trimEnd(),
            exitCode: code ?? 1,
            logLines,
          })
        }
      })

      proc.on("error", (err: Error) => {
        clearTimeout(timer)
        killChain?.cancel()
        this.signal?.removeEventListener("abort", onAbort)
        reject(err)
      })
    })
  }
}