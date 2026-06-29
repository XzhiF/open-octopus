// packages/server/src/services/knowledge/validators.ts
//
// Shared validation helpers for knowledge routes. Centralizes the rules
// that were previously duplicated across archive.ts, knowledge.ts, and
// review.ts, and tightens the path-traversal check so every file-bearing
// endpoint enforces the same policy.

import path from "path"

/**
 * Strict UUID v4 (case-insensitive). Used by archive routes where the
 * path parameter is an execution id produced by `randomUUID()`.
 */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isValidUUID(id: string): boolean {
  return typeof id === "string" && UUID_REGEX.test(id)
}

/**
 * Rule / pending-review ID format. Matches:
 *   * `generateRuleId(target)` → `{target}-{YYYYMMDD}-{4 hex}`
 *   * `skill-{8 base64url chars}`
 *   * `skill-pattern-{base36 timestamp}`
 *   * `compact-{...}` (any suffix produced by generateRuleId)
 *
 * The policy is intentionally permissive on the suffix (alphanumeric,
 * dashes, underscores) but strict on what characters are allowed — this
 * keeps the DAO safe from injection while tolerating the id variants
 * produced by the knowledge subsystem.
 */
const RULE_ID_REGEX = /^[a-z][a-z0-9-]*-[a-z0-9_-]{4,32}$/i

export function isValidRuleId(id: string): boolean {
  return typeof id === "string" && RULE_ID_REGEX.test(id)
}

/**
 * Validate a knowledge file name used in `GET/PUT /api/knowledge/file/:path`
 * and `POST /api/knowledge/compact`.
 *
 * Policy:
 *   * Must be a non-empty basename (no path separators, no parent refs).
 *   * No null bytes, no URL-encoded separators, no backslashes.
 *   * Length capped to avoid filesystem-level surprises.
 *
 * Returns a structured result so callers can return a consistent
 * `INVALID_PARAM` response without having to re-derive the reason.
 */
export function validateKnowledgeFileName(name: unknown): {
  ok: boolean
  error?: string
} {
  if (typeof name !== "string" || name.length === 0) {
    return { ok: false, error: "fileName required" }
  }
  if (name.length > 200) {
    return { ok: false, error: "fileName too long" }
  }
  // Reject any path-separator variant (raw, URL-encoded, or Windows).
  if (
    name.includes("..") ||
    name.includes("/") ||
    name.includes("\\") ||
    name.includes("\0") ||
    /%2e|%2f|%5c/i.test(name)
  ) {
    return { ok: false, error: "Invalid file name" }
  }
  // Must be a basename — parsing with path.basename should round-trip.
  if (path.basename(name) !== name) {
    return { ok: false, error: "Invalid file name" }
  }
  return { ok: true }
}
