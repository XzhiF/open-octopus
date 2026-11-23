// packages/server/src/services/execution/StateFileManager.ts
//
// Manages execution state files on disk: per-execution JSON snapshots and
// the aggregated executions.json used by the frontend.
//
import type { IStateFileManager } from "./interfaces"
import type { ExecutionRow } from "./types"
import type { ExecutionDAO } from "../../db/dao/execution-dao"
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs"
import { join } from "path"

export class StateFileManager implements IStateFileManager {
  private stateDir: string

  constructor(
    private workspacePath: string,
    private workspaceDbId: string,
    private dao: ExecutionDAO,
  ) {
    this.stateDir = join(workspacePath, "state")
    if (!existsSync(this.stateDir)) {
      mkdirSync(this.stateDir, { recursive: true })
    }
  }

  saveExecutionState(execution: ExecutionRow): void {
    const stateFile = join(this.stateDir, `${execution.id}.json`)
    const state = {
      id: execution.id,
      status: execution.status,
      started_at: execution.started_at,
      completed_at: execution.completed_at,
      duration: execution.duration,
      output: execution.var_pool ? JSON.parse(execution.var_pool) : {},
    }
    writeFileSync(stateFile, JSON.stringify(state, null, 2), "utf-8")
  }

  loadExecutionState(executionId: string): any {
    const stateFile = join(this.stateDir, `${executionId}.json`)
    if (!existsSync(stateFile)) return null
    try {
      return JSON.parse(readFileSync(stateFile, "utf-8"))
    } catch {
      return null
    }
  }

  updateExecutionState(executionId: string, updates: Partial<ExecutionRow>): void {
    const currentState = this.loadExecutionState(executionId)
    if (!currentState) return
    const newState = { ...currentState, ...updates }
    const stateFile = join(this.stateDir, `${executionId}.json`)
    writeFileSync(stateFile, JSON.stringify(newState, null, 2), "utf-8")
  }

  /**
   * Write aggregated executions.json for the workspace.
   * Used by the frontend for the execution tree view.
   */
  syncStateJson(): void {
    const timingOn = process.env.OCTOPUS_EXEC_TIMING === "1"
    const t0 = timingOn ? Date.now() : 0
    if (!existsSync(this.stateDir)) mkdirSync(this.stateDir, { recursive: true })

    const rows = this.dao.findExecutionsForStateSync(this.workspaceDbId)
    const t1 = timingOn ? Date.now() : 0

    const safeJsonParse = (v: string | null | undefined): Record<string, string> | null => {
      if (!v) return null
      try { return JSON.parse(v) } catch { return null }
    }

    const state = {
      workspace_id: this.workspaceDbId,
      updated_at: new Date().toISOString(),
      executions: rows.map(r => ({
        execution_id: r.id, parent_id: r.parent_id,
        node_type: r.node_type ?? "normal", branch: r.branch,
        status: r.status, workflow_ref: r.workflow_ref, workflow_name: r.workflow_name,
        input_values: safeJsonParse(r.input_values),
        start_commit_id: safeJsonParse(r.start_commit_id),
        end_commit_id: safeJsonParse(r.end_commit_id),
        started_at: r.started_at, completed_at: r.completed_at,
      })),
    }

    const json = JSON.stringify(state, null, 2)
    if (timingOn) {
      const t2 = Date.now()
      writeFileSync(join(this.stateDir, "executions.json"), json, "utf-8")
      console.log(`[exec-timing] syncStateJson ${JSON.stringify({
        rows: rows.length,
        query_ms: t1 - t0, build_stringify_ms: t2 - t1, write_ms: Date.now() - t2,
      })}`)
    } else {
      writeFileSync(join(this.stateDir, "executions.json"), json, "utf-8")
    }
  }

  /**
   * Read per-execution state JSON file.
   */
  getStateJson(executionId: string): Record<string, unknown> | null {
    const stateFile = join(this.stateDir, `${executionId}.json`)
    if (!existsSync(stateFile)) return null
    try { return JSON.parse(readFileSync(stateFile, "utf-8")) } catch { return null }
  }
}
