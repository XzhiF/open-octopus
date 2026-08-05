// packages/server/src/services/harness/action-types.ts
//
// Shared types for the harness action system.

import type { DiagnosisReport, StrategyAction } from "@octopus/shared"
import type { HarnessDAO } from "../../db/dao/harness-dao"
import type { SSEService } from "../sse"
import type { RepairService } from "../repair"

/**
 * Result of executing a single intervention action.
 */
export interface InterventionResult {
  success: boolean
  action: string
  message: string
  modelOverride?: string
  harnessHint?: string
  delegate?: boolean
  details?: Record<string, any>
}

/**
 * Context passed to every action handler.
 */
export interface ActionContext {
  report: DiagnosisReport
  strategyAction: StrategyAction
  dao: HarnessDAO
  sse: SSEService
  repairService?: RepairService
  workspaceId: string
}

/**
 * An action handler is an async function that takes an ActionContext
 * and returns an InterventionResult.
 */
export type ActionHandler = (ctx: ActionContext) => Promise<InterventionResult>
