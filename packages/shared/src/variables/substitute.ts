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
  // ponytail: the global regex char class includes '-' and '.' so nodeIds like
  // "requirements-clarify" and "$nodeId.output.key" match in one token. But that
  // greedily swallows trailing separators/Extensions too (e.g. "$hook.timestamp.md"
  // matches ref="hook.timestamp.md"). For vars/hook/inputs, keys are single
  // identifiers — resolve the longest valid key prefix and append the unconsumed
  // remainder (so ".md" / trailing "-" survive).
  return text.replace(/\$([a-zA-Z0-9_.:-]+)/g, (_match, ref: string) => {
    if (ref.startsWith("vars.")) {
      const key = "vars." + ref.slice(5).match(/^[a-zA-Z0-9_]+/)?.[0]
      if (key) {
        const val = pool.get(key.slice(5))
        if (val !== undefined) return String(val) + ref.slice(key.length)
      }
      return `$${ref}`
    }

    if (ref.startsWith("inputs.")) {
      const key = "inputs." + ref.slice(7).match(/^[a-zA-Z0-9_]+/)?.[0]
      if (key) {
        const val = pool.get(key.slice(7))
        if (val !== undefined) return String(val) + ref.slice(key.length)
      }
      return `$${ref}`
    }

    if (ref.startsWith("hook.")) {
      const key = "hook." + ref.slice(5).match(/^[a-zA-Z0-9_]+/)?.[0]
      if (key) {
        const val = pool.get(key)
        if (val !== undefined) return String(val) + ref.slice(key.length)
      }
      return `$${ref}`
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

    // $nodeId.output — resolve to node's primary output (lastOutput, decision, etc.)
    const nodeOutputPrimary = ref.match(/^([a-zA-Z0-9_-]+)\.output$/)
    if (nodeOutputPrimary) {
      const nodeId = nodeOutputPrimary[1]
      const nodeOut = nodeOutputs?.[nodeId]
      if (nodeOut) {
        const val = nodeOut["output"] ?? nodeOut["last_output"] ?? nodeOut["decision"]
        return val !== undefined ? String(val) : `$${ref}`
      }
      return `$${ref}`
    }

    // $nodeId.output.key — resolve to specific output key
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