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

/** The SDK's project-dir key: every non-alphanumeric character → '-'. */
export function projectDirKey(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-")
}

function claudeProjectsDir(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR
    ? path.resolve(process.env.CLAUDE_CONFIG_DIR)
    : path.join(os.homedir(), ".claude")
  return path.join(configDir, "projects")
}

/**
 * 2026-10-28 task-thread: one main chat switches cwd at identity boundaries
 * (task home → execution workspace). The SDK keys its transcript by cwd, so a
 * resume id stored under the old project dir would go cold on the next turn.
 * Copy every file belonging to this provider session into the new project dir
 * BEFORE `usableResumeId` is consulted. Best-effort: a missing source is a cold
 * turn, never an error.
 */
export function migrateProviderTranscript(
  oldCwd: string,
  newCwd: string,
  sessionId: string,
): boolean {
  if (!sessionId || path.resolve(oldCwd) === path.resolve(newCwd)) return false
  const projects = claudeProjectsDir()
  const fromDir = path.join(projects, projectDirKey(oldCwd))
  const toDir = path.join(projects, projectDirKey(newCwd))
  try {
    if (!fs.existsSync(fromDir)) return false
    const files = fs.readdirSync(fromDir).filter((name) => name.includes(sessionId))
    if (files.length === 0) return false
    fs.mkdirSync(toDir, { recursive: true })
    let copied = false
    for (const name of files) {
      const target = path.join(toDir, name)
      if (fs.existsSync(target)) continue
      fs.copyFileSync(path.join(fromDir, name), target)
      copied = true
    }
    return copied
  } catch {
    return false
  }
}

/**
 * Cheap pre-flight for the SDK's local transcript. The SDK keys project dirs
 * by replacing every non-alphanumeric character in cwd with '-'
 * (e.g. /Users/x/.octopus/agent → -Users-x--octopus-agent).
 */
export function hasLocalTranscript(cwd: string, sessionId: string): boolean {
  const projectsDir = claudeProjectsDir()
  const key = projectDirKey(cwd)
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
