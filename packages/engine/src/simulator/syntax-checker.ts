// packages/engine/src/simulator/syntax-checker.ts
//
// Pre-flight syntax validation for bash and python script nodes.
// Uses `bash -n` and `python3 -c "compile(...)"` to check syntax
// without executing the scripts.

import { execSync } from "child_process"
import type { SyntaxError } from "./types"

export interface SyntaxCheckResult {
  passed: boolean
  errors: SyntaxError[]
}

/**
 * Check syntax of all bash and python script nodes.
 * Returns immediately with results — does not affect simulation.
 */
export function checkSyntax(
  nodes: Array<{ id: string; type: string; bash?: string; python?: string; nodes?: any[] }>,
): SyntaxCheckResult {
  const errors: SyntaxError[] = []

  for (const node of nodes) {
    if (node.type === "bash" && node.bash !== undefined) {
      const error = checkBashSyntax(node.id, node.bash)
      if (error) errors.push(error)
    }

    if (node.type === "python" && node.python !== undefined) {
      const error = checkPythonSyntax(node.id, node.python)
      if (error) errors.push(error)
    }

    // Recurse into loop inner nodes
    if (node.type === "loop" && node.nodes) {
      const innerResult = checkSyntax(node.nodes)
      errors.push(...innerResult.errors)
    }
  }

  return { passed: errors.length === 0, errors }
}

function checkBashSyntax(nodeId: string, script: string): SyntaxError | null {
  // Empty script is valid
  if (!script.trim()) return null

  try {
    // Use bash -n to check syntax without executing
    // Pass script via stdin to avoid shell escaping issues
    execSync(`bash -n`, {
      input: script,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 5000,
    })
    return null
  } catch (err: any) {
    const stderr = err.stderr?.toString() ?? ""
    const lineMatch = stderr.match(/line (\d+)/)
    return {
      nodeId,
      nodeType: "bash",
      script,
      error: stderr.trim() || "Bash syntax error",
      line: lineMatch ? parseInt(lineMatch[1], 10) : undefined,
    }
  }
}

function checkPythonSyntax(nodeId: string, script: string): SyntaxError | null {
  // Empty script is valid
  if (!script.trim()) return null

  try {
    // Use Python compile() to check syntax without executing
    const escapedScript = script.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")
    execSync(
      `python3 -c "compile(\\"${escapedScript}\\", '<string>', 'exec')"`,
      {
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 5000,
      },
    )
    return null
  } catch (err: any) {
    const stderr = err.stderr?.toString() ?? ""
    const lineMatch = stderr.match(/line (\d+)/)
    return {
      nodeId,
      nodeType: "python",
      script,
      error: stderr.trim() || "Python syntax error",
      line: lineMatch ? parseInt(lineMatch[1], 10) : undefined,
    }
  }
}
