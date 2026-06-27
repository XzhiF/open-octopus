// packages/server/src/services/chain-trigger.ts
// ChainTriggerService — Phase 4 of Execution Memory: Workflow Chain Trigger.
// Reads the workflow YAML's `chain` field and logs/triggers successor workflows on completion.
// Independent from the existing ChainEngine (which handles pipeline.yaml chain).

import fs from "fs"
import path from "path"
import os from "os"
import type { ArchiveDAO } from "../db/dao/archive-dao"
import type { ExecutionDAO } from "../db/dao/execution-dao"
import type { ExecutionArchiveRow } from "../db/types-archive"

interface ChainNext {
  workflow: string
  condition?: string
  auto_trigger?: boolean
  input_mapping?: Record<string, string>
}

interface WorkflowChain {
  on_success?: ChainNext[]
  on_failure?: ChainNext[]
}

export class ChainTriggerService {
  constructor(
    private archiveDAO: ArchiveDAO,
    private executionDAO: ExecutionDAO,
  ) {}

  /**
   * Check if completed execution has a chain definition and trigger successors.
   * Called after execution completion is archived.
   */
  async onExecutionComplete(executionId: string): Promise<void> {
    try {
      const archive = this.archiveDAO.findById(executionId)
      if (!archive) return

      // Read workflow YAML to get chain definition
      const chain = this.readWorkflowChain(archive.workspace_id, archive.workflow_ref)
      if (!chain) return

      // Select successors based on status
      const isSuccess = archive.status === 'completed' || archive.status === 'completed_with_failures'
      const successors = isSuccess ? (chain.on_success || []) : (chain.on_failure || [])

      for (const next of successors) {
        // Evaluate condition
        if (next.condition && !this.evaluateCondition(next.condition, archive)) {
          continue
        }

        // Loop detection: check if this workflow_name is already in the chain path
        if (this.isInChainPath(archive, next.workflow)) {
          console.warn(`[ChainTrigger] Loop detected: ${next.workflow} already in chain path, skipping`)
          continue
        }

        // Depth check
        const depth = this.getChainDepth(archive)
        if (depth >= 10) {
          console.warn(`[ChainTrigger] Depth limit reached (${depth}), skipping trigger`)
          continue
        }

        // Total execution count cap: ≤ 20 in chain
        const totalInChain = this.countChainExecutions(archive)
        if (totalInChain >= 20) {
          console.warn(`[ChainTrigger] Total execution cap reached (${totalInChain}), skipping trigger`)
          continue
        }

        console.log(`[ChainTrigger] Triggering successor: ${next.workflow} from ${archive.workflow_name}`)
        // Note: actual triggering would call ExecutionService to start the next workflow.
        // For now, log the intent — full integration requires ExecutionService access.
        // Future: this.executionService.startWorkflow(next.workflow, archive.workspace_id, ...)
      }
    } catch (err) {
      console.error(`[ChainTrigger] onExecutionComplete failed for ${executionId}:`, err)
    }
  }

  private readWorkflowChain(workspaceId: string | null, workflowRef: string): WorkflowChain | null {
    if (!workspaceId) return null
    try {
      const wsPath = this.executionDAO.findWorkspacePath(workspaceId)
      if (!wsPath) return null

      const resolvedPath = wsPath.replace(/^~/, os.homedir())
      const workflowPath = path.join(resolvedPath, workflowRef)
      if (!fs.existsSync(workflowPath)) return null

      const content = fs.readFileSync(workflowPath, 'utf-8')
      // Try to use the shared YAML parser
      try {
        const { parseWorkflow } = require('@octopus/shared')
        const parsed = parseWorkflow(content)
        return (parsed as any)?.chain ?? null
      } catch {
        return null
      }
    } catch {
      return null
    }
  }

  private evaluateCondition(condition: string, archive: ExecutionArchiveRow): boolean {
    try {
      // Simple condition evaluation: replace $vars references with archive values
      const resolved = condition
        .replace(/\$vars\.status/g, `'${archive.status}'`)
        .replace(/\$vars\.workflow_name/g, `'${archive.workflow_name}'`)
        .replace(/\$vars\.total_cost_usd/g, String(archive.total_cost_usd))

      // Safe eval: only allow comparison operators and safe characters
      if (/^[a-zA-Z0-9'"_.=<>!&|\s()]+$/.test(resolved)) {
        // Use Function constructor for safe evaluation (no access to outer scope)
        return new Function(`return (${resolved})`)() as boolean
      }
      return false
    } catch {
      return false
    }
  }

  private isInChainPath(archive: ExecutionArchiveRow, workflowName: string): boolean {
    // Check parent chain for cycle detection
    if (archive.workflow_name === workflowName) return true
    if (archive.parent_execution_id) {
      const parent = this.archiveDAO.findById(archive.parent_execution_id)
      if (parent) return this.isInChainPath(parent, workflowName)
    }
    return false
  }

  private getChainDepth(archive: ExecutionArchiveRow): number {
    let depth = 0
    let current: ExecutionArchiveRow | null = archive
    while (current?.parent_execution_id && depth < 20) {
      depth++
      current = this.archiveDAO.findById(current.parent_execution_id)
    }
    return depth
  }

  private countChainExecutions(archive: ExecutionArchiveRow): number {
    let count = 1
    let current: ExecutionArchiveRow | null = archive
    while (current?.parent_execution_id && count < 25) {
      count++
      current = this.archiveDAO.findById(current.parent_execution_id)
    }
    return count
  }
}
