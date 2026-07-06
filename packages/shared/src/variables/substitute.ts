import { VarPool } from "./var-pool"
import type { CrossExecResolver } from "./cross-exec-resolver"

export function substituteVars(
  text: string,
  pool: VarPool,
  nodeOutputs?: Record<string, Record<string, any>>,
  crossExecResolver?: CrossExecResolver,
  executionId?: string,
  loopContext?: Record<string, any>,
): string {
  // 1. 先处理跨 execution 引用（如果提供了 resolver）
  if (crossExecResolver && executionId) {
    text = crossExecResolver.resolve(text, executionId)
  }

  // 2. 处理 $iteration（loop 变量，单独处理避免被正则中的 : 干扰）
  if (loopContext && loopContext["iteration"] !== undefined) {
    text = text.replace(/\$iteration\b/g, String(loopContext["iteration"]))
  }

  // 3. 再处理现有变量引用（$vars.*, $inputs.*, $hook.*, $ref:*, nodeId.output.*）
  return text.replace(/\$([a-zA-Z0-9_.:-]+)/g, (_match, ref: string) => {
    if (ref.startsWith("vars.")) {
      const key = ref.slice(5)
      const val = pool.get(key)
      return val !== undefined ? String(val) : `$${ref}`
    }

    if (ref.startsWith("inputs.")) {
      const key = ref.slice(7)
      const val = pool.get(key)
      return val !== undefined ? String(val) : `$${ref}`
    }

    if (ref.startsWith("deps.")) {
      const key = ref.slice(5)
      const val = pool.get(`deps.${key}`)
      return val !== undefined ? String(val) : `$${ref}`
    }

    if (ref.startsWith("hook.")) {
      const val = pool.get(ref)
      return val !== undefined ? String(val) : `$${ref}`
    }

    // ★ Cross-execution reference: $ref:workflowRef.nodeId.outputKey
    if (ref.startsWith("ref:")) {
      const refPath = ref.slice(4)
      if (pool.hasRefResolver()) {
        const val = pool.resolveRef(refPath)
        return val !== undefined ? String(val) : `$${ref}`
      }
      return `$${ref}`
    }

    const nodeMatch = ref.match(/^([a-zA-Z0-9_-]+)\.output\.([a-zA-Z0-9_.]+)$/)
    if (nodeMatch) {
      const nodeId = nodeMatch[1]
      const key = nodeMatch[2]
      const val = nodeOutputs?.[nodeId]?.[key]
      return val !== undefined ? String(val) : `$${ref}`
    }

    return `$${ref}`
  })
}