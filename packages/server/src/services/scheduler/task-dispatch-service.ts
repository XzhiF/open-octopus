// packages/server/src/services/scheduler/task-dispatch-service.ts
//
// TaskDispatchPort implementation — the adapter between the engine's `task_dispatch`
// node and the task domain's child-run machinery.
//
// 票03 (ADR-0021) emptied this class. It used to be where a composite task's children
// were BORN as `schedules` rows: its own schedule_id, `origin_type='task'`,
// `origin_role='subunit'`, `origin_id=<parent task>`, a `schedule_executions` link row, a
// `parent_task_dispatch` marker smuggled into the child's config JSON so a restart could
// still find the parent, and a concurrency branch that parked over-cap children as
// 'queued' rows for the pump's claim loop to pick up. That is why the scheduler could not
// be separated from tasks: it was executing them.
//
// What is left is only what genuinely belongs here: the engine calls a port, and the port
// must be an object with two methods. Both now delegate to services/tasks/task-child-run
// — the child is an `executions` row (parent_id + task_id), and the parent's resume is
// derived from those two columns instead of a stored marker.

import type Database from "better-sqlite3"
import type { SubunitSpec, TaskDispatchPort, ChildHandle } from "@octopus/shared"
import type { WorkspaceService } from "../workspace"
import type { SSEService } from "../sse"
import { dispatchChildRun, resumeParentFromChild } from "../tasks/task-child-run"

export interface TaskDispatchServiceDeps {
  db: Database.Database
  /** The coordinator workspace — the run that is dispatching lives here. */
  workspaceId: string
  workspacePath: string
  org: string
  workspaceService: WorkspaceService
  sse: SSEService
}

export class TaskDispatchService implements TaskDispatchPort {
  constructor(private deps: TaskDispatchServiceDeps) {}

  async dispatchChild(subunit: SubunitSpec): Promise<ChildHandle> {
    return dispatchChildRun(
      {
        db: this.deps.db,
        workspaceId: this.deps.workspaceId,
        org: this.deps.org,
        workspaceService: this.deps.workspaceService,
        sse: this.deps.sse,
      },
      subunit,
    )
  }

  /** Kept on the port because the engine's node state stores the handle and may need to
   *  re-forward a result after a restart. The correlation is derived from the child row
   *  (parent_id + the parent's running node), so there is nothing to look up here. */
  async resumeOnCompletion(handle: ChildHandle, output: Record<string, unknown>): Promise<void> {
    await resumeParentFromChild(this.deps.db, handle.child_id, output)
  }
}
