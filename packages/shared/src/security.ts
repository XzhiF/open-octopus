/**
 * Shared security utilities: path validation, shell escaping, input sanitization.
 */

import path from "path"

/**
 * Shell-escape a value for safe use inside bash single-quoted strings.
 * Replaces each `'` with `'\''` (close-quote, escaped-quote, open-quote).
 */
export function shellEscape(value: string): string {
  return value.replace(/'/g, "'\\''")
}

// ponytail: values matching this pattern are safe to substitute raw into shell scripts.
// Values with ANY character outside this set get single-quoted to prevent injection.
const SHELL_SAFE_VALUE_RE = /^[a-zA-Z0-9_./:=@,+^-]*$/

/**
 * Return a shell-safe representation of a value:
 * - If the value contains only safe characters → return raw
 * - If the value contains shell-dangerous characters → wrap in single quotes
 * ponytail: prevents command injection while preserving backward compat for simple values
 */
export function shellSafeValue(value: string): string {
  if (value === "") return "''"
  if (SHELL_SAFE_VALUE_RE.test(value)) return value
  return `'${shellEscape(value)}'`
}

/**
 * Like substituteVars but wraps each substituted value in single quotes
 * after shell-escaping, preventing command injection via variable values.
 *
 * Usage: pass this to bash/python executors instead of raw substituteVars.
 */
export function safeShellSubstituteVars(
  text: string,
  pool: { get(key: string): any },
  nodeOutputs?: Record<string, Record<string, any>>,
): string {
  return text.replace(/\$([a-zA-Z0-9_.:-]+)/g, (_match, ref: string) => {
    let val: any
    if (ref.startsWith("vars.")) {
      val = pool.get(ref.slice(5))
    } else if (ref.startsWith("inputs.")) {
      val = pool.get(ref.slice(7))
    } else if (ref.startsWith("hook.")) {
      val = pool.get(ref)
    } else {
      const nodeMatch = ref.match(/^([a-zA-Z0-9_-]+)\.output\.([a-zA-Z0-9_.]+)$/)
      if (nodeMatch) {
        val = nodeOutputs?.[nodeMatch[1]]?.[nodeMatch[2]]
      }
    }
    if (val !== undefined) {
      return `'${shellEscape(String(val))}'`
    }
    return `$${ref}`
  })
}

// ponytail: strict date format YYYY-MM-DD, prevents path traversal in filenames
const SAFE_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** Validate date string is exactly YYYY-MM-DD format. */
export function isSafeDate(date: string): boolean {
  return SAFE_DATE_RE.test(date)
}

// ponytail: safe filename — alphanumeric, hyphens, underscores, dots only
const SAFE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/

/** Validate a name component contains only safe characters. */
export function isSafeName(name: string): boolean {
  return SAFE_NAME_RE.test(name) && !name.includes("..")
}

/**
 * Validate a workflow ref is a safe filename (no path traversal).
 * Rejects directory separators and null bytes. Allows refs with or without .yaml extension.
 */
export function isSafeRef(ref: string): boolean {
  if (!ref || ref.includes("..") || ref.includes("/") || ref.includes("\\")) return false
  if (ref.includes("\0")) return false
  // ponytail: allow simple names like "test-workflow" (engine adds .yaml internally)
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(ref)
}

/**
 * Validate that a resolved path stays within an allowed base directory.
 * Returns true if `resolved` is equal to or a child of `baseDir`.
 */
export function isPathWithin(resolved: string, baseDir: string): boolean {
  const normBase = path.resolve(baseDir)
  const normTarget = path.resolve(resolved)
  return normTarget === normBase || normTarget.startsWith(normBase + path.sep)
}

// Prototype chain properties that must be blocked in expression evaluation
const DANGEROUS_PROPS = new Set([
  "constructor", "prototype", "__proto__",
  "eval", "Function", "require", "process", "global", "globalThis",
])

/** Check if a property name is dangerous (prototype chain traversal). */
export function isDangerousProperty(prop: string): boolean {
  return DANGEROUS_PROPS.has(prop)
}
