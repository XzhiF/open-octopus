// packages/server/src/services/execution/interfaces.ts
import type { ExecutionRow } from "./types"

// ExecutionLifecycle 接口（Task 8）
export interface IExecutionLifecycle {
  start(executionId: string, inputValues?: Record<string, string>, syncMainBranch?: boolean): Promise<ExecutionRow>
  cancel(executionId: string): Promise<ExecutionRow>
  retry(executionId: string, failedNodeId: string, inputValues?: Record<string, string>, intervention?: string): Promise<ExecutionRow>
  approve(executionId: string, nodeId: string, answer: string, comment?: string): Promise<ExecutionRow>
  pause(executionId: string): Promise<{ success: boolean; error?: string }>
  resume(executionId: string, intervention?: string): Promise<{ success: boolean; error?: string }>
  skip(executionId: string): boolean
  setChainCallback(callback: (executionId: string, status: string) => void | Promise<void>): void
}

// EngineFactory 接口（Task 9）
export interface IEngineFactory {
  createEngine(execution: ExecutionRow, workflow: any, callbacks?: any, signal?: AbortSignal): any
  reconstructEngine(execution: ExecutionRow, callbacks: any, signal: AbortSignal): any
  resolveProviders(workflow: any): Record<string, any>
  resolveWorkflowWithSnapshot(executionId: string, workflowRef: string): { parsed: any; content: string } | undefined
}

// EngineCallbacks 接口（Task 10）
export interface IEngineCallbacks {
  buildCallbacks(executionId: string): any  // 返回 EngineCallbacks
}

// HookExecutor 接口（Task 11）
export interface IHookExecutor {
  executeWorkflowHooks(event: string, context: any, workflow: any, executionId: string): Promise<void>
}

// GitBranchManager 接口（Task 12）
export interface IGitBranchManager {
  createExecutionBranch(executionId: string, parentBranch?: string): Promise<string>
  switchToBranch(branch: string): Promise<void>
  getCurrentBranch(): Promise<string>
}

// StateFileManager 接口（Task 13）
export interface IStateFileManager {
  saveExecutionState(execution: ExecutionRow): void
  loadExecutionState(executionId: string): any
  updateExecutionState(executionId: string, updates: Partial<ExecutionRow>): void
}

// RecoveryManager 接口（Task 14）
export interface IRecoveryManager {
  recoverInterruptedExecutions(): Promise<void>
  recoverChainState(): Promise<void>  // 新增：链恢复
}
