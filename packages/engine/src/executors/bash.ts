import { spawn } from "child_process"
import { existsSync } from "fs"
import { VarPool, substituteVars, substituteVarsFull, evaluateExpression } from "@octopus/shared"
import type { NodeDef, CrossExecResolver } from "@octopus/shared"
import type { NodeExecutor, NodeExecutionResult } from "./types"
import type { BashConfig } from "./executor-config"
import { applyVarsUpdate } from "./parse-vars-update"

/**
 * 解析 bash 可执行文件路径。
 * - 优先使用环境变量 OCTOPUS_BASH_PATH（用户显式覆盖）
 * - Windows 上优先 MSYS bash（Git for Windows），避免 WSL bash 的路径映射问题
 * - macOS/Linux 使用系统 bash
 */
function resolveBashPath(): string {
  // 1. 用户显式覆盖
  const envPath = process.env.OCTOPUS_BASH_PATH
  if (envPath && existsSync(envPath)) {
    return envPath
  }

  // 2. Windows: 优先 MSYS bash（Git for Windows）
  if (process.platform === "win32") {
    const candidates = [
      "C:\\Program Files\\Git\\bin\\bash.exe",
      "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
      process.env.GIT_BASH_PATH,
      process.env.LOCALAPPDATA + "\\Programs\\Git\\bin\\bash.exe",
    ].filter(Boolean) as string[]

    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        return candidate
      }
    }
    // fallback: 让系统 PATH 解析 bash（可能是 WSL bash）
    return "bash"
  }

  // 3. macOS/Linux: 使用系统 bash
  return "bash"
}

const BASH_PATH = resolveBashPath()

export class BashExecutor implements NodeExecutor {
  private signal?: AbortSignal
  private onLog?: (line: string, stream?: "stdout" | "stderr") => void
  private cwd?: string
  private crossExecResolver?: CrossExecResolver
  private executionId?: string
  private loopContext?: Record<string, any>
  private nodeOutputs?: Record<string, Record<string, any>>

  constructor(
    private node: NodeDef,
    private pool: VarPool,
    config?: BashConfig,
  ) {
    this.signal = config?.signal
    this.onLog = config?.onLog
    this.cwd = config?.cwd
    this.crossExecResolver = config?.crossExecResolver
    this.executionId = config?.executionId
    this.loopContext = config?.loopContext
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
    let script = substituteVarsFull(this.node.bash!, this.pool, this.nodeOutputs, this.crossExecResolver, this.executionId, this.loopContext)
    script = this.resolveInputs(script)
    const timeout = this.node.timeout ?? 30

    try {
      const result = await this.runScript(script, timeout)
      const durationMs = Date.now() - start

      if (result.exitCode !== 0) {
        this.onLog?.(`Script failed with exit code ${result.exitCode}`, "stderr")
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
      this.onLog?.(status === "failed" ? "Script requested failure via __status" : "Script completed successfully")
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
      this.onLog?.(`Script error: ${err.message ?? String(err)}`, "stderr")
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
      const value = substituteVars(expr, this.pool, undefined, this.crossExecResolver, this.executionId)
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
        const resolved = substituteVars(expr, this.pool, undefined, this.crossExecResolver, this.executionId)
        this.pool.set(poolKey, resolved)
        outputs[poolKey] = resolved
      } else {
        this.pool.set(poolKey, expr)
        outputs[poolKey] = expr
      }
    }
  }

  private runScript(script: string, timeoutSec: number): Promise<{
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
      const proc = spawn(BASH_PATH, ["-c", script], {
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
        cwd: this.cwd,
        env: (() => {
          const childEnv = { ...process.env }
          delete childEnv.OCTOPUS_DB_PATH
          return childEnv
        })(),
      })

      let stdout = ""
      let stderr = ""
      const logLines: string[] = []
      let aborted = false

      // 监听 abort signal，在 Windows 上强制杀死进程树
      const onAbort = () => {
        aborted = true
        if (process.platform === "win32") {
          // Windows: 使用 taskkill 强制杀死进程树
          try {
            const { execSync } = require("child_process")
            execSync(`taskkill /PID ${proc.pid} /T /F`, { stdio: "ignore" })
          } catch {
            proc.kill("SIGKILL")
          }
        } else {
          // Unix: 使用 SIGTERM 杀死进程组
          try {
            process.kill(-proc.pid!, "SIGTERM")
          } catch {
            proc.kill("SIGTERM")
          }
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
        onAbort()
        reject(new Error(`Timeout after ${timeoutSec}s`))
      }, timeoutSec * 1000)

      proc.on("close", (code: number | null) => {
        clearTimeout(timer)
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
        this.signal?.removeEventListener("abort", onAbort)
        reject(err)
      })
    })
  }
}