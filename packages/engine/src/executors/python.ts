import { spawn } from "child_process"
import { VarPool, substituteVars, evaluateExpression } from "@octopus/shared"
import type { NodeDef } from "@octopus/shared"
import type { NodeExecutor, NodeExecutionResult } from "./types"
import { applyVarsUpdate } from "./parse-vars-update"

export class PythonExecutor implements NodeExecutor {
  constructor(
    private node: NodeDef,
    private pool: VarPool,
    private signal?: AbortSignal,
    private onLog?: (line: string, stream?: "stdout" | "stderr") => void,
  ) {}

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
    let script = substituteVars(this.node.python!, this.pool)
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
    for (const [key, expr] of Object.entries(this.node.outputs)) {
      const poolKey = key.startsWith("$vars.") ? key.slice(6) : key

      // 变量赋值语法: $vars.xxx = expression
      const VARS_ASSIGN_RE = /^\$vars\.(\w+)\s*=\s*(.+)$/
      const assignMatch = expr.match(VARS_ASSIGN_RE)
      if (assignMatch) {
        const varKey = assignMatch[1]
        const rhs = assignMatch[2].trim()
        const resolved = evaluateExpression(rhs, this.pool)
        this.pool.set(varKey, resolved)
        outputs[poolKey] = resolved
        continue
      }

      if (expr === "$last_output") {
        this.pool.set(poolKey, outputs.last_output)
        outputs[poolKey] = outputs.last_output
      } else if (expr.startsWith("$last_output.")) {
        const field = expr.slice(13)
        let obj: any = outputs.last_output
        try { obj = JSON.parse(outputs.last_output) } catch { /* stdout 非 JSON */ }
        const value = obj?.[field]
        this.pool.set(poolKey, value)
        outputs[poolKey] = value
      } else if (expr === "$exit_code") {
        this.pool.set(poolKey, outputs.exit_code)
        outputs[poolKey] = outputs.exit_code
      } else if (/^\$vars\.\w+$/.test(expr)) {
        const varKey = expr.slice(6)
        this.pool.set(poolKey, this.pool.get(varKey))
        outputs[poolKey] = this.pool.get(varKey)
      } else if (expr.startsWith("$")) {
        const resolved = substituteVars(expr, this.pool)
        this.pool.set(poolKey, resolved)
        outputs[poolKey] = resolved
      } else {
        this.pool.set(poolKey, expr)
        outputs[poolKey] = expr
      }
    }
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
      const proc = spawn("python3", ["-c", script], {
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
        signal: this.signal,
        env: (() => {
          const childEnv = { ...process.env }
          delete childEnv.OCTOPUS_DB_PATH
          return childEnv
        })(),
      })

      let stdout = ""
      let stderr = ""
      const logLines: string[] = []

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
        proc.kill("SIGTERM")
        reject(new Error(`Timeout after ${timeoutSec}s`))
      }, timeoutSec * 1000)

      proc.on("close", (code: number | null) => {
        clearTimeout(timer)
        resolve({
          stdout: stdout.trimEnd(),
          stderr: stderr.trimEnd(),
          exitCode: code ?? 1,
          logLines,
        })
      })

      proc.on("error", (err: Error) => {
        clearTimeout(timer)
        reject(err)
      })
    })
  }
}