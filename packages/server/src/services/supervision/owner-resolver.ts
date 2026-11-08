// OwnerResolver — one execution, one owner.
//
// Ownership is execution-level (2026-11-07 decision). The default owner is the
// chat session that launched the run; a task-thread run falls back to the
// task's source chat thread. Executions with no chat (scheduler / bare CLI)
// resolve to null → the incident is recorded as `unowned` and held for the
// next-iteration manual queue.

import type Database from "better-sqlite3"
import type { SupervisorKind } from "@octopus/shared"

export interface OwnerTarget {
  kind: SupervisorKind
  /** Chat session id (kind = chat). */
  sessionId: string
  /** Org header used by the wake endpoint. */
  org: string
  workspaceId: string
}

export class OwnerResolver {
  constructor(private db: Database.Database) {}

  resolve(executionId: string): OwnerTarget | null {
    let row:
      | {
          session_id: string | null
          task_id: string | null
          workspace_id: string | null
          repo_group: string | null
          task_session_id: string | null
          clone_name: string | null
        }
      | undefined

    try {
      row = this.db
        .prepare(
          `SELECT el.session_id AS session_id,
                  e.task_id AS task_id,
                  e.workspace_id AS workspace_id,
                  w.repo_group AS repo_group,
                  t.source_chat_session_id AS task_session_id,
                  s.clone_name AS clone_name
             FROM executions e
             LEFT JOIN execution_links el ON el.execution_id = e.id
             LEFT JOIN tasks t ON t.id = e.task_id
             LEFT JOIN workspaces w ON w.id = e.workspace_id
             LEFT JOIN sessions s ON s.id = COALESCE(el.session_id, t.source_chat_session_id)
            WHERE e.id = ?`,
        )
        .get(executionId) as typeof row
    } catch {
      return null
    }

    if (!row) return null

    const sessionId = row.session_id ?? row.task_session_id ?? null
    if (!sessionId) return null
    // Legacy clone threads are not the main chat — never inject supervision
    // cards into them (same rule as ChatEventBridge).
    if (row.clone_name) return null

    return {
      kind: "chat",
      sessionId,
      org: row.repo_group ?? "",
      workspaceId: row.workspace_id ?? "",
    }
  }
}
