import { VarPool } from "./var-pool"

function toJsLiteral(value: any): string {
  if (value === null || value === undefined) return "null"
  if (typeof value === "boolean") return value ? "true" : "false"
  if (typeof value === "number") return String(value)
  if (typeof value === "string") return JSON.stringify(value)
  return JSON.stringify(value)
}

function resolveRefs(
  expr: string,
  pool: VarPool,
  nodeOutputs?: Record<string, Record<string, any>>,
  inputs?: Record<string, any>,
  loopContext?: Record<string, any>,
): string {
  let result = expr

  result = result.replace(/\$vars\.([a-zA-Z0-9_]+)/g, (_match, key: string) => {
    const val = pool.get(key)
    return toJsLiteral(val)
  })

  result = result.replace(/\$([a-zA-Z0-9_-]+)\.output\.([a-zA-Z0-9_]+)/g, (_match, nodeId: string, key: string) => {
    const val = nodeOutputs?.[nodeId]?.[key]
    return toJsLiteral(val)
  })

  result = result.replace(/\$inputs\.([a-zA-Z0-9_]+)/g, (_match, key: string) => {
    const val = inputs?.[key]
    return toJsLiteral(val)
  })

  result = result.replace(/\$hook\.([a-zA-Z0-9_]+)/g, (_match, key: string) => {
    const val = pool.get(`hook.${key}`)
    return toJsLiteral(val)
  })

  // ★ Cross-execution reference: $ref:workflowRef.nodeId.outputKey
  result = result.replace(/\$ref:([a-zA-Z0-9_.-]+)/g, (_match, refPath: string) => {
    if (pool.hasRefResolver()) {
      const val = pool.resolveRef(refPath)
      return toJsLiteral(val)
    }
    return toJsLiteral(undefined)
  })

  result = result.replace(/\$iteration/g, () => {
    const val = loopContext?.["iteration"]
    return toJsLiteral(val)
  })

  return result
}

function transformInOperator(expr: string): string {
  return expr.replace(
    /([a-zA-Z0-9_'"truefalsnull]+)\s+in\s+\[([^\]]+)\]/g,
    (_match, left: string, arrContent: string) => {
      return `[${arrContent}].includes(${left})`
    },
  )
}

const ALLOWED_PATTERN = /^[a-zA-Z0-9_\s'".\[\],:!|<>=()\-&]+$/

// ponytail: block prototype chain traversal in expressions (RCE prevention)
const DANGEROUS_PROP_RE = /\b(constructor|prototype|__proto__|eval|Function|require|process|global|globalThis)\b/

export function evaluateExpression(
  expr: string,
  pool: VarPool,
  nodeOutputs?: Record<string, Record<string, any>>,
  inputs?: Record<string, any>,
  loopContext?: Record<string, any>,
): boolean {
  if (expr.trim() === "default") return true

  const resolved = resolveRefs(expr, pool, nodeOutputs, inputs, loopContext)

  const transformed = transformInOperator(resolved)

  if (!ALLOWED_PATTERN.test(transformed)) return false

  // ponytail: block prototype chain access — ""["constructor"]("return process")()
  if (DANGEROUS_PROP_RE.test(transformed)) return false

  try {
    const fn = new Function(`return (${transformed})`)
    const result = fn()
    return Boolean(result)
  } catch {
    return false
  }
}