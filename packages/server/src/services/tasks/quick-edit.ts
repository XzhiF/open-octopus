// packages/server/src/services/tasks/quick-edit.ts
//
// Server-side half of the 「每改即提交」 write discipline (ADR-0025 票01).
//
// The turn that just finished may have moved the task workspace's git现场.
// Land ONE marked commit per dirty repo on its checked-out execution branch.
// Nothing here picks a branch (the worktrees already carry the execution
// branch) and nothing here rolls anything back. Per-repo best-effort: one bad
// repo must not eat the reply the user already saw.
//
// Extracted from TaskDoerService so the unified task thread (a main agent
// session bound to a task) and the legacy doer chat share one implementation.

import fs from "fs"
import path from "path"
import { QUICK_EDIT_MARKER, TAKEOVER_EDIT_MARKER, gitOps } from "../git-ops"

export interface QuickEditCommit {
  repo: string
  branch: string
  commit: string
  message: string
}

/** First line of the user's instruction, capped — the commit subject stays
 *  greppable (票09 counts by the marker) without quoting essays. */
export function quickEditSummary(content: string): string {
  const first = content.split(/\r?\n/)[0].trim()
  return first.length > 60 ? `${first.slice(0, 59)}…` : first
}

export function quickEditMarkerFor(takeoverTurn: boolean): string {
  return takeoverTurn ? TAKEOVER_EDIT_MARKER : QUICK_EDIT_MARKER
}

export interface CommitWorkspaceEditsInput {
  /** Absolute path of the bound execution workspace. */
  wsPath: string
  taskId: string
  sessionId: string
  /** The user message that drove the turn (subject body). */
  content: string
  /** `[quick-edit]` or `[takeover-edit]`. */
  marker?: string
}

/** Commit every dirty `{ws}/projects/*` repo once. Returns the commits landed
 *  (empty when nothing changed). Never throws. */
export async function commitWorkspaceEdits(
  input: CommitWorkspaceEditsInput,
): Promise<QuickEditCommit[]> {
  const projectsDir = path.join(input.wsPath, "projects")
  let names: string[]
  try {
    names = fs.readdirSync(projectsDir)
  } catch {
    return []
  }
  const marker = input.marker ?? QUICK_EDIT_MARKER
  const subject = `${marker} ${quickEditSummary(input.content)}`
  const out: QuickEditCommit[] = []
  for (const name of names) {
    const repo = path.join(projectsDir, name)
    try {
      if (!fs.existsSync(path.join(repo, ".git"))) continue
      if (!(await gitOps.hasUncommittedChanges(repo))) continue
      const before = await gitOps.getHeadCommit(repo)
      await gitOps.autoCommit(
        repo,
        `${subject}\n\ntask: ${input.taskId}\ndoer_session: ${input.sessionId}\nrepo: ${name}`,
      )
      const after = await gitOps.getHeadCommit(repo)
      if (after === before) continue // .gitignore-only dirt — nothing staged
      out.push({
        repo: name,
        branch: await gitOps.getCurrentBranch(repo),
        commit: after,
        message: subject,
      })
    } catch (err: unknown) {
      console.warn(
        `[quick-edit] commit failed for ${repo} (non-fatal):`,
        err instanceof Error ? err.message : String(err),
      )
    }
  }
  return out
}
