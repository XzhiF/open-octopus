import type { SchedulerJob, SchedulerExecutionStatus } from "@octopus/shared"
import type { Executor, ExecutionResult } from "./executor-interface"
import type { DemandDAO } from "../../../db/dao/demand-dao"
import { TaskPoolDispatcher } from "../../task-board/task-pool-dispatcher"

/**
 * TaskPoolExecutor — scheduler executor that polls and dispatches ready demands.
 *
 * Registered as job_type 'task_pool_poller' in the SchedulerEngine.
 * On each trigger, it creates a TaskPoolDispatcher, calls poll() to pick
 * ready demands, then execute() on each dispatched demand.
 *
 * Default interval: 30 seconds (configured via cron_expression on the schedule).
 */
export class TaskPoolExecutor implements Executor {
  private readonly dispatcher: TaskPoolDispatcher

  constructor(dao: DemandDAO, batchSize?: number) {
    this.dispatcher = new TaskPoolDispatcher(dao, batchSize ?? 5)
  }

  getType(): string {
    return "task_pool_poller"
  }

  async execute(
    _job: SchedulerJob,
    _executionId: string,
  ): Promise<ExecutionResult> {
    const start = Date.now()

    try {
      // Step 1: Poll for ready demands and mark them dispatched
      const pollResult = await this.dispatcher.poll()

      if (pollResult.count === 0) {
        return {
          success: true,
          exitCode: 0,
          durationMs: Date.now() - start,
          status: "success" as SchedulerExecutionStatus,
          agentOutput: "No ready demands to dispatch",
        }
      }

      // Step 2: Execute each dispatched demand
      let successCount = 0
      let failCount = 0
      for (const demandId of pollResult.dispatched) {
        try {
          await this.dispatcher.execute(demandId)
          successCount++
        } catch {
          failCount++
        }
      }

      const durationMs = Date.now() - start

      return {
        success: failCount === 0,
        exitCode: failCount === 0 ? 0 : 1,
        durationMs,
        status: (failCount === 0 ? "success" : "failure") as SchedulerExecutionStatus,
        agentOutput: `Dispatched ${pollResult.count} demands: ${successCount} succeeded, ${failCount} failed`,
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        success: false,
        exitCode: 1,
        errorMessage: message,
        durationMs: Date.now() - start,
        status: "failure" as SchedulerExecutionStatus,
      }
    }
  }
}
