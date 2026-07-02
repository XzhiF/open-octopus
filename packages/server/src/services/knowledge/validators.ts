// packages/server/src/services/knowledge/validators.ts
//
// Shared validation helpers for knowledge routes. Centralizes the rules
// that were previously duplicated across archive.ts, knowledge.ts, and
// review.ts, and tightens the path-traversal check so every file-bearing
// endpoint enforces the same policy.

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
 *   * Must start with `projects/` or `workflows/` (subdirectory prefix).
 *   * Sub-path (after prefix) must be a plain `.md` basename — no further
 *     directory separators.
 *   * No path traversal (`..`), null bytes, or URL-encoded separators.
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
  // Reject path traversal and null bytes
  if (name.includes("..") || name.includes("\0")) {
    return { ok: false, error: "Invalid file name" }
  }
  // Reject URL-encoded separators
  if (/%2e|%2f|%5c/i.test(name)) {
    return { ok: false, error: "Invalid file name" }
  }
  // Must start with "projects/" or "workflows/"
  if (!name.startsWith("projects/") && !name.startsWith("workflows/")) {
    return { ok: false, error: "Must start with projects/ or workflows/" }
  }
  // Extract sub-path after the directory prefix
  const subPath = name.replace(/^(projects|workflows)\//, "")
  // Sub-path must not contain directory separators
  if (subPath.includes("/") || subPath.includes("\\") || subPath.length === 0) {
    return { ok: false, error: "Invalid sub-path" }
  }
  // Must end with .md
  if (!subPath.endsWith(".md")) {
    return { ok: false, error: "Must end with .md" }
  }
  return { ok: true }
}

// ---------------------------------------------------------------------------
// Error response helpers
// ---------------------------------------------------------------------------
//
// The knowledge subsystem's route handlers use try/catch blocks that, in the
// original PR, returned raw `String(err)` to the client. That leaks internal
// paths, SQL text, provider API responses, and stack traces — violating
// OWASP guidance and the project's own security.md.
//
// The helpers below produce a consistent response shape that:
//   * preserves stable `code` strings clients can branch on (NOT_FOUND, etc.)
//   * logs the real error server-side with the request path for correlation
//   * returns a generic human message to the client

export interface ErrorResponse {
  error: { code: string; message: string }
}

/**
 * Map a thrown error to a JSON response body + HTTP status.
 *
 * Recognized sentinel messages (thrown by services):
 *   * "NOT_FOUND"           → 404
 *   * "INVALID_TARGET_FILE" → 400
 *   * "INVALID_SKILL_NAME"  → 400
 *   * anything containing "CONFLICT" → 409
 *   * everything else       → 500
 *
 * The raw error is logged to stderr; the client only sees the code plus
 * a safe generic message.
 */
export function errorResponse(
  err: unknown,
  context: string,
): { body: ErrorResponse; status: number } {
  const raw = err instanceof Error ? err.message : String(err)

  // Server-side log retains the full message for debugging.
  // Use stderr so it doesn't mix with Hono's access logs on stdout.
  process.stderr.write(`[knowledge/${context}] ${raw}\n`)

  if (raw === "NOT_FOUND") {
    return {
      body: { error: { code: "NOT_FOUND", message: "Requested resource was not found" } },
      status: 404,
    }
  }
  if (raw.startsWith("INVALID_TARGET_FILE") || raw.startsWith("INVALID_SKILL_NAME")) {
    return {
      body: { error: { code: "INVALID_PARAM", message: "One or more input values are invalid" } },
      status: 400,
    }
  }
  if (raw.includes("CONFLICT")) {
    return {
      body: { error: { code: "MEMORY_CONFLICT", message: "Conflicts with existing memory entry" } },
      status: 409,
    }
  }
  return {
    body: { error: { code: "INTERNAL_ERROR", message: "An internal error occurred" } },
    status: 500,
  }
}

