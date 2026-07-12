// packages/shared/src/notify/template-renderer.ts
import { VarPool } from "../variables/var-pool"
import { substituteVars } from "../variables/substitute"
import { applyFilters } from "./filters"
import type { NotifyTemplate, NotifyMessage } from "../types/notify"

const MAX_NESTING = 3

export class TemplateRenderer {
  validate(template: NotifyTemplate): string[] {
    const errors: string[] = []
    const texts = [template.title, template.body ?? ""]

    for (const text of texts) {
      // Detect ${...} without | (invalid filter syntax)
      const badFilter = text.match(/\$\{([^}]+)\}/g)
      if (badFilter) {
        for (const m of badFilter) {
          if (!m.includes("|")) {
            errors.push(`Invalid filter syntax "${m}": filter requires pipe, e.g. \${var | filter}`)
          }
        }
      }

      // Detect unmatched {{#if}} / {{/if}}
      const ifCount = (text.match(/\{\{#if\s/g) || []).length
      const endifCount = (text.match(/\{\{\/if\}\}/g) || []).length
      if (ifCount !== endifCount) {
        errors.push(`Unmatched conditionals: ${ifCount} {{#if}} vs ${endifCount} {{/if}}`)
      }
    }

    if (!template.title || template.title.trim().length === 0) {
      errors.push("Template title cannot be empty")
    }

    return errors
  }

  render(
    template: NotifyTemplate,
    pool: VarPool,
    nodeOutputs?: Record<string, Record<string, any>>,
  ): NotifyMessage {
    const title = this.renderText(template.title, pool, nodeOutputs)
    const body = template.body ? this.renderText(template.body, pool, nodeOutputs) : ""

    return {
      severity: template.severity ?? "info",
      title,
      body,
    }
  }

  private renderText(
    text: string,
    pool: VarPool,
    nodeOutputs?: Record<string, Record<string, any>>,
  ): string {
    // Step 1: processConditionals ({{#if $vars.xxx}}...{{/if}})
    let result = processConditionals(text, pool, nodeOutputs)

    // Build vars map for filter resolution.
    // Pool keys are stored WITHOUT prefix (e.g. "failed_reason"), but filter
    // expressions reference them WITH prefix (e.g. "vars.failed_reason").
    // Add both forms so applyFilters can resolve either.
    const vars: Record<string, string> = {}
    for (const [key, value] of Object.entries(pool.snapshot())) {
      vars[key] = String(value ?? "")
      if (key.startsWith("vars.")) vars[key.slice(5)] = String(value ?? "")
      if (key.startsWith("inputs.")) vars[key.slice(7)] = String(value ?? "")
      // Also add prefixed forms so filter expressions like ${vars.xxx | ...} resolve
      if (!key.includes(".")) vars[`vars.${key}`] = String(value ?? "")
    }
    if (nodeOutputs) {
      for (const [nodeId, outputs] of Object.entries(nodeOutputs)) {
        for (const [key, value] of Object.entries(outputs)) {
          vars[`${nodeId}.output.${key}`] = String(value ?? "")
        }
      }
    }

    // Step 2: applyFilters — resolves ${...|...} expressions (handles nesting internally)
    result = applyFilters(result, vars)

    // Step 3: substituteVars — replace remaining bare $vars.*, $hook.*, etc.
    result = substituteVars(result, pool, nodeOutputs)

    return result
  }
}

// ── Exported for use in validateTemplateSyntax ──
export function validateTemplateSyntax(template: NotifyTemplate): string[] {
  return new TemplateRenderer().validate(template)
}

// ── Internal helpers ──

function processConditionals(
  text: string,
  pool: VarPool,
  nodeOutputs?: Record<string, Record<string, any>>,
): string {
  let result = text
  let iterations = 0
  const maxIterations = MAX_NESTING + 1

  while (result.includes("{{#if ") && iterations < maxIterations) {
    iterations++

    // Non-greedy match — safe from ReDoS. Nesting protection handled by outer while + MAX_NESTING.
    const innerPattern = /\{\{#if\s+([^}]+)\}\}([\s\S]*?)\{\{\/if\}\}/
    const match = result.match(innerPattern)

    if (!match) {
      if (result.includes("{{#if ") || result.includes("{{/if}}")) {
        throw new Error("Malformed conditional: unmatched {{#if}} or {{/if}} tags")
      }
      break
    }

    const [, condition, content] = match
    const value = resolveVarRef(condition.trim(), pool, nodeOutputs)
    const isTruthy = isTruthyValue(value)

    result = result.replace(match[0], isTruthy ? content : "")
  }

  if (result.includes("{{#if ")) {
    throw new Error(`Conditional nesting exceeds maximum depth of ${MAX_NESTING}`)
  }

  return result
}

function resolveVarRef(
  varExpr: string,
  pool: VarPool,
  nodeOutputs?: Record<string, Record<string, any>>,
): any {
  const ref = varExpr.trim()

  if (ref.startsWith("$vars.")) return pool.get(ref.slice(6))
  if (ref.startsWith("$hook.")) return pool.get(ref.slice(1)) // "$hook.xxx" → pool key "hook.xxx"
  if (ref.startsWith("$inputs.")) return pool.get(ref.slice(8))
  if (ref.startsWith("$notify.")) return pool.get(ref.slice(1)) // "$notify.xxx" → pool key "notify.xxx"

  const nodeMatch = ref.match(/^\$([a-zA-Z0-9_-]+)\.output\.([a-zA-Z0-9_.]+)$/)
  if (nodeMatch) {
    const [, nodeId, key] = nodeMatch
    return nodeOutputs?.[nodeId]?.[key]
  }

  if (ref.startsWith("$ref:")) return pool.resolveRef(ref.slice(5))

  return undefined
}

function isTruthyValue(value: any): boolean {
  if (value === null || value === undefined) return false
  if (typeof value === "string") {
    if (value.length === 0) return false
    // Numeric strings (e.g. "0" from String(0)) — evaluate as number
    const n = Number(value)
    if (!isNaN(n)) return n !== 0
    return true
  }
  if (typeof value === "number") return value !== 0
  if (typeof value === "boolean") return value
  return true
}
