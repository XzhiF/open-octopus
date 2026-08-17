// packages/server/src/routes/clone/autosave.ts
//
// 04 — task-author autosave seam (v2-D6/D11/SG3/SG8).
//
// Extracted from clone/index.ts:406 so the seam is unit-testable without
// spinning up the full SSE route. The route calls this helper at turn-end
// (after the auto-title block, before the done SSE), gated by
// cloneName === 'task-author'. The helper is best-effort: any error is
// swallowed + logged so the chat reply still reaches the user even if
// autosave fails.
//
// Semantics (spec v2-D6/D11 + SG3 + SG8):
//   - First turn (no task linked to this session via source_chat_session_id):
//     create a draft row (status='draft', source_chat_session_id, name=autoTitle)
//     AND link the session's scope_id to the new task id (SG3 writer).
//   - Subsequent turns: targeted UPDATE name+updated_at ONLY — does NOT bump
//     version and does NOT touch task_spec/resources/authoring_resources
//     (SG8: avoid races with the spec-field tool, which bumps version).
//
// The autoTitle is derived by the caller (the route reads the session title
// AFTER the auto-title block has run, so it reflects the just-computed
// first-message title on turn 1, or the user-renamed title on later turns).

import crypto from "crypto"
import type { TaskDAO, AgentSessionDAO } from "../../db/dao"

export interface AutosaveDeps {
  taskDAO: TaskDAO
  sessionDAO: AgentSessionDAO
}

export interface AutosaveInput {
  sessionId: string
  org: string
  /** Auto-derived title (from the session title / first user message).
   *  Caller computes this; the autosave seam does not re-derive. */
  autoTitle: string
}

/**
 * task-author turn-end autosave (v2-D6/D11). Returns the task id on success
 * (so the caller can include it in the done SSE if desired), or null on
 * failure. Failures are non-fatal — the chat reply is unaffected.
 */
export function autosaveTaskDraft(
  deps: AutosaveDeps,
  input: AutosaveInput,
): string | null {
  const { taskDAO, sessionDAO } = deps
  try {
    const existing = taskDAO.getBySourceChatSession(input.sessionId)
    if (existing) {
      // Subsequent turn: targeted UPDATE name+updated_at ONLY (SG8).
      // Does NOT bump version, does NOT touch task_spec/resources —
      // avoids races with the spec-field tool on the same turn (autosave
      // fires at turn-end, after tool calls have already landed).
      taskDAO.updateAutosave(existing.id, input.autoTitle)
      return existing.id
    }
    // First turn: create draft row + link scope_id (SG3).
    const id = crypto.randomUUID()
    const now = new Date().toISOString()
    taskDAO.insert({
      id,
      org: input.org,
      name: input.autoTitle,
      status: "draft",
      source_chat_session_id: input.sessionId,
      created_at: now,
      updated_at: now,
    })
    // SG3: link the bound chat session's scope_id to the new task id (implicit
    // autosave path — mirrors TasksService.createTask's explicit POST path).
    try {
      sessionDAO.updateSession(input.sessionId, { scope_id: id })
    } catch (err: unknown) {
      // Non-fatal — task row exists; scope_id link is best-effort. Mirrors
      // the swallow+log pattern in TasksService.createTask (03).
      console.error(
        "[autosaveTaskDraft] failed to link session scope_id (non-fatal — task row created):",
        err instanceof Error ? err.message : String(err),
      )
    }
    return id
  } catch (err: unknown) {
    console.error(
      "[autosaveTaskDraft] autosave failed (non-fatal — chat reply unaffected):",
      err instanceof Error ? err.message : String(err),
    )
    return null
  }
}
