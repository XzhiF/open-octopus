import fs from "fs"
import os from "os"
import path from "path"

/**
 * Resume robustness for the Claude SDK path.
 *
 * A stored provider_session_id can outlive its transcript (DB restored on a
 * fresh machine, cache cleaned, SDK version change). Passing a dead id makes
 * the turn fail. These helpers let the routes degrade to a cold turn instead
 * of a dead chat — the same strategy CloneRuntime already uses by retrying
 * without resume.
 */

/** Provider error text that means "this session id is no longer resumable". */
export function isResumeFailureMessage(message: string): boolean {
  return /no conversation|conversation.*not found|session.*not found|invalid.*session|resume.*fail/i.test(
    message,
  )
}

/**
 * Cheap pre-flight for the SDK's local transcript. The SDK keys project dirs
 * by replacing every non-alphanumeric character in cwd with '-'
 * (e.g. /Users/x/.octopus/agent → -Users-x--octopus-agent).
 */
export function hasLocalTranscript(cwd: string, sessionId: string): boolean {
  const configDir = process.env.CLAUDE_CONFIG_DIR
    ? path.resolve(process.env.CLAUDE_CONFIG_DIR)
    : path.join(os.homedir(), ".claude")
  const projectsDir = path.join(configDir, "projects")
  const key = cwd.replace(/[^a-zA-Z0-9]/g, "-")
  if (fs.existsSync(path.join(projectsDir, key, `${sessionId}.jsonl`))) return true
  // Fallback: cwd may be symlinked/rewritten by the SDK — scan project dirs.
  try {
    for (const entry of fs.readdirSync(projectsDir)) {
      if (fs.existsSync(path.join(projectsDir, entry, `${sessionId}.jsonl`))) return true
    }
  } catch {
    /* no projects dir — treat as cold */
  }
  return false
}

/** Return the id only when it can actually be resumed; otherwise undefined. */
export function usableResumeId(
  cwd: string,
  sessionId: string | null | undefined,
): string | undefined {
  if (!sessionId) return undefined
  return hasLocalTranscript(cwd, sessionId) ? sessionId : undefined
}
