import type { DemandDAO } from "../../db/dao/demand-dao"

/**
 * TaskPoolDispatcher — polls for ready demands and dispatches them for execution.
 *
 * Lifecycle: ready → dispatched → executing → done/failed
 *
 * poll(): Grabs up to batchSize ready demands (priority-ordered via DAO),
 *         marks them as 'dispatched', and returns the list of IDs.
 *
 * execute(): Transitions a dispatched demand through executing → done (R2 stub),
 *            or → failed on error.
 */
export class TaskPoolDispatcher {
  constructor(
    private readonly dao: DemandDAO,
    private readonly batchSize: number = 5,
  ) {}

  /**
   * Poll for ready demands and mark them as dispatched.
   * Uses dao.listReady() which returns demands ordered by priority (critical first)
   * then created_at ascending.
   *
   * @returns Object with dispatched IDs array and count.
   */
  async poll(): Promise<{ dispatched: string[]; count: number }> {
    const ready = this.dao.listReady(this.batchSize)
    const dispatched: string[] = []

    for (const demand of ready) {
      this.dao.updateStatus(demand.id, "dispatched")
      dispatched.push(demand.id)
    }

    return { dispatched, count: dispatched.length }
  }

  /**
   * Execute a single dispatched demand.
   *
   * Happy path: dispatched → executing → done (with result stub)
   * Failure path: dispatched → executing → failed (with error_message)
   *
   * Silently skips if demand doesn't exist or isn't in 'dispatched' status.
   */
  async execute(demandId: string): Promise<void> {
    const demand = this.dao.findById(demandId)
    if (!demand || demand.status !== "dispatched") return

    this.dao.updateStatus(demandId, "executing")

    try {
      // R2: stub — real WorkflowEngine integration deferred
      this.dao.updateStatus(demandId, "done")
      this.dao.update(demandId, { result: "Completed (R2 stub)" })
    } catch (error: unknown) {
      this.dao.updateStatus(demandId, "failed")
      const message = error instanceof Error ? error.message : String(error)
      this.dao.setError(demandId, message)
    }
  }
}
