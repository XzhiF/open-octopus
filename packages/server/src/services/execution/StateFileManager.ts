// packages/server/src/services/execution/StateFileManager.ts
import type { IStateFileManager } from "./interfaces"
import type { ExecutionRow } from "./types"
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs"
import { join } from "path"

export class StateFileManager implements IStateFileManager {
  private stateDir: string

  constructor(private workspacePath: string) {
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
    if (!existsSync(stateFile)) {
      return null
    }

    try {
      const content = readFileSync(stateFile, "utf-8")
      return JSON.parse(content)
    } catch (error) {
      return null
    }
  }

  updateExecutionState(executionId: string, updates: Partial<ExecutionRow>): void {
    const currentState = this.loadExecutionState(executionId)
    if (!currentState) {
      return
    }

    const newState = { ...currentState, ...updates }
    const stateFile = join(this.stateDir, `${executionId}.json`)
    writeFileSync(stateFile, JSON.stringify(newState, null, 2), "utf-8")
  }
}
