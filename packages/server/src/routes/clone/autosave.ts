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
// first-message title on turn 1).
//
// Bugfix 2026-08-21: the task name is USER-OWNED once the user sets it
// (header rename / POST name). Subsequent turns therefore refresh updated_at
// ONLY and never overwrite a user-set name with the session title.
//
// Refinement 2026-08-21 (follow-up): the DEFAULT name ("Untitled task",
// see DEFAULT_TASK_NAME) is NOT user-owned — it's a placeholder from
// TasksService.createTask. While the name is still the default, the seam
// adopts the smart session title (derived from the first chat message by the
// route's auto-title block), restoring the original "title auto-fills after
// the first chat" behavior. A user rename freezes the name either way.
// TasksService.updateTask keeps the bound session title in sync with a header
// rename, so when they diverge (a sidebar session rename not followed by a
// header rename), the task title wins.

import crypto from "crypto"
import type { TaskDAO, AgentSessionDAO } from "../../db/dao"
import { TaskHomeService } from "../../services/tasks/task-home-service"
import { DEFAULT_TASK_NAME } from "../../services/tasks/tasks-service"

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
  /** The session's placeholder title (e.g. "task-author 会话"). When
   *  autoTitle still equals this, no meaningful title has been derived yet
   *  (e.g. empty first message) — never adopt it as the task name. */
  placeholderTitle?: string
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
      // Subsequent turn: refresh updated_at (SG8). Name policy:
      //   - user-set name (header rename / POST name) → PRESERVED (bugfix
      //     2026-08-21: writing the session title here was clobbering a
      //     manual header rename on the next chat turn). updateTask syncs
      //     header renames into the session title, so existing.name ===
      //     session title in the common case; when they diverge, the task
      //     title wins.
      //   - default name (DEFAULT_TASK_NAME, never user-set) → ADOPT the
      //     smart session title, so a draft created with the placeholder
      //     name gets a real title after the first chat (refinement
      //     2026-08-21). Only when a meaningful title exists (autoTitle is
      //     not the placeholder itself).
      // Still no version bump and no task_spec/resources touch — avoids
      // races with the spec-field tool on the same turn (autosave fires at
      // turn-end, after tool calls).
      const meaningfulTitle =
        input.autoTitle.trim().length > 0 &&
        input.autoTitle !== (input.placeholderTitle ?? "")
      const name =
        existing.name === DEFAULT_TASK_NAME && meaningfulTitle
          ? input.autoTitle
          : existing.name
      taskDAO.updateAutosave(existing.id, name)
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
    // Create task home directory so the next turn's clone cwd override
    // (routes/clone/index.ts) can resolve to the task dir instead of the
    // clone's own dir. Without this, @@task_context is not injected and
    // skill-relative paths land in the wrong place.
    try {
      new TaskHomeService().createHome(id, { org: input.org })
    } catch (err: unknown) {
      // Non-fatal — task row exists; home creation is best-effort. Mirrors
      // the swallow+log pattern for scope_id link above.
      console.error(
        "[autosaveTaskDraft] failed to create task home (non-fatal — task row created):",
        err instanceof Error ? err.message : String(err),
      )
    }
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
