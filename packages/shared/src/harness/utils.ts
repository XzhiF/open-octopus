/**
 * computeErrorHash — extract error features from a node execution result
 * and produce a short hash for comparing whether two failures are the same.
 *
 * Uses a minimal interface so shared does not depend on @octopus/engine.
 */
export interface ErrorResultLike {
  logLines?: string[]
  error?: string
  outputs?: { exitCode?: number; [key: string]: any }
}

export function computeErrorHash(result: ErrorResultLike): string {
  const errorLines =
    result.logLines
      ?.filter((l) => l.includes("error") || l.includes("Error"))
      .join("\n") ?? ""

  const raw = [
    errorLines,
    result.error ?? "",
    result.outputs?.exitCode?.toString() ?? "",
  ].join("|")

  return simpleHash(raw.substring(0, 500))
}

/**
 * simpleHash — non-cryptographic hash for string comparison.
 * djb2-style, returns base-36 absolute value.
 */
export function simpleHash(str: string): string {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0
  }
  return Math.abs(hash).toString(36)
}
